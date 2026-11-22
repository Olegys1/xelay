"""Isolated draft scheduler. Never writes to the original planner or its sources."""
import copy, hashlib, json, random, sys
from pathlib import Path
from collections import defaultdict
from ortools.sat.python import cp_model

DEFAULTS={'days':[1,2,3,4,5],'firstPeriod':1,'lastPeriod':6,'minDaily':2,'maxDaily':4,'zeroGaps':True,'fiveDays':True,'lowLoadException':True,'teacherCompact':True,'avoidLate':False,'blocked':[]}
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def settings(raw):
    if not isinstance(raw,dict):raise ValueError('Некоректні умови розрахунку.')
    out=copy.deepcopy(DEFAULTS);out.update({k:v for k,v in raw.items() if k in out})
    if not isinstance(out['days'],list) or not out['days'] or any(type(d)!=int or d not in range(1,6) for d in out['days']):raise ValueError('Оберіть навчальні дні.')
    out['days']=sorted(set(out['days']))
    for k in ('firstPeriod','lastPeriod','minDaily','maxDaily'):
        if type(out[k])!=int or not 1<=out[k]<=6:raise ValueError('Кількість і номери пар: від 1 до 6.')
    if out['firstPeriod']>out['lastPeriod'] or out['minDaily']>out['maxDaily']:raise ValueError('Мінімум не може перевищувати максимум.')
    for k in ('zeroGaps','fiveDays','lowLoadException','teacherCompact','avoidLate'):
        if type(out[k])!=bool:raise ValueError('Некоректний перемикач умов.')
    if not isinstance(out['blocked'],list) or len(out['blocked'])>200:raise ValueError('Забагато обмежень доступності.')
    for b in out['blocked']:
        if not isinstance(b,dict) or type(b.get('day'))!=int or type(b.get('period'))!=int or b.get('day') not in range(1,6) or b.get('period') not in range(1,7) or not isinstance(b.get('teacher'),str) or not 1<=len(b['teacher'])<=200:raise ValueError('Оберіть викладача, день і пару.')
    return out

def attendance(events,key):
    by=defaultdict(set)
    for i,e in enumerate(events):
        for person in e[key]:
            for week in e['weeks']:by[person,week].add(i)
    return by

def audit(base,events,cfg):
    """Independent validation, including exact immutable hours and memberships."""
    errors=[];stats={'studentGaps':0,'teacherGaps':0,'conflicts':0,'changed':0,'semesterPairs':0}
    if len(events)!=len(base) or len({e['id'] for e in events})!=len(events):errors.append('Змінився склад занять.')
    originals={e['id']:e for e in base}
    for e in events:
        old=originals.get(e['id'])
        if old is None or {k:v for k,v in e.items() if k not in ('day','period')}!={k:v for k,v in old.items() if k not in ('day','period')}:errors.append('Змінилися години, студенти або дані заняття.')
        if e['day'] not in cfg['days'] or not cfg['firstPeriod']<=e['period']<=cfg['lastPeriod']:errors.append('Заняття поза дозволеним часом.')
        if e['activity']=='lab' and len(e['studentIds'])>18:errors.append('У лабораторній більше 18 студентів.')
        if old and (old['day'],old['period'])!=(e['day'],e['period']):stats['changed']+=1
        stats['semesterPairs']+=len(e['weeks'])
        for b in cfg['blocked']:
            if b['teacher'] in e['teacherIds'] and (b['day'],b['period'])==(e['day'],e['period']):errors.append('Викладач недоступний у цей час.')
    for key in ('studentIds','teacherIds'):
        for indices in attendance(events,key).values():
            slots=[(events[i]['day'],events[i]['period']) for i in indices]
            if len(slots)!=len(set(slots)):stats['conflicts']+=len(slots)-len(set(slots))
            days=defaultdict(list)
            for d,p in slots:days[d].append(p)
            for ps in days.values():
                gaps=max(ps)-min(ps)+1-len(set(ps));stats['studentGaps' if key=='studentIds' else 'teacherGaps']+=gaps
                if key=='studentIds' and (not cfg['minDaily']<=len(ps)<=cfg['maxDaily'] or cfg['zeroGaps'] and gaps):errors.append('Порушено кількість пар або відсутність вікон студента.')
            if key=='studentIds' and cfg['fiveDays']:
                allowed=[3,4] if cfg['lowLoadException'] and len(indices)<10 else [len(cfg['days'])]
                if len(days) not in allowed:errors.append('Порушено кількість навчальних днів студента.')
    if stats['conflicts']:errors.append('Є накладки студентів або викладачів.')
    return {'passed':not errors,'errors':list(dict.fromkeys(errors)),'metrics':stats}

def solve(base,cfg,seed=0,target=None,excluded=None,seconds=18):
    cfg=settings(cfg);events=copy.deepcopy(base);m=cp_model.CpModel()
    slots=[(d,p) for d in cfg['days'] for p in range(cfg['firstPeriod'],cfg['lastPeriod']+1)]
    xs=[];moves=[];objective=[];rng=random.Random(seed)
    if target and (target.get('event') not in {e['id'] for e in base} or (target.get('day'),target.get('period')) not in slots):raise ValueError('Перенесення поза дозволеною сіткою.')
    for i,e in enumerate(events):
        row=[m.new_bool_var(f'e{i}s{j}') for j in range(len(slots))];m.add_exactly_one(row);xs.append(row)
        for j,(d,p) in enumerate(slots):
            if any(b['teacher'] in e['teacherIds'] and (b['day'],b['period'])==(d,p) for b in cfg['blocked']):m.add(row[j]==0)
            if target and e['id']==target['event']:m.add(row[j]==int((d,p)==(target['day'],target['period'])))
            same=(d,p)==(e['day'],e['period']);m.add_hint(row[j],int(same))
            if not same:moves.append(row[j])
            objective.append(row[j]*(rng.randrange(1,15)+(30*p if cfg['avoidLate'] else 0)))
    # Deduplicate equal attendance patterns across weeks and students.
    for key in ('studentIds','teacherIds'):
        patterns=set(tuple(sorted(v)) for v in attendance(events,key).values())
        for n,indices in enumerate(sorted(patterns)):
            occ=[]
            for j in range(len(slots)):
                v=m.new_bool_var(f'{key}{n}-{j}');m.add(v==sum(xs[i][j] for i in indices));occ.append(v)
            active=[]
            for d in cfg['days']:
                ps=[occ[j] for j,s in enumerate(slots) if s[0]==d]
                a=m.new_bool_var(f'{key}{n}d{d}');m.add_max_equality(a,ps);active.append(a)
                if key=='studentIds':
                    m.add(sum(ps)>=cfg['minDaily']*a);m.add(sum(ps)<=cfg['maxDaily']*a)
                    if cfg['zeroGaps']:
                        rows=[[0]*len(ps)]
                        for size in range(cfg['minDaily'],min(cfg['maxDaily'],len(ps))+1):
                            for start in range(len(ps)-size+1):rows.append([int(start<=p<start+size) for p in range(len(ps))])
                        m.add_allowed_assignments(ps,rows)
                elif cfg['teacherCompact']:
                    # Penalise every interior empty slot, never forbid a teacher gap.
                    for j in range(1,len(ps)-1):
                        left=m.new_bool_var('left');right=m.new_bool_var('right');gap=m.new_bool_var('gap')
                        m.add_max_equality(left,ps[:j]);m.add_max_equality(right,ps[j+1:]);m.add(gap>=left+right-ps[j]-1);objective.append(80*gap)
                    objective.extend(4*v for v in active[-1:])
            if key=='studentIds' and cfg['fiveDays']:
                if cfg['lowLoadException'] and len(indices)<10:m.add(sum(active)>=3);m.add(sum(active)<=4)
                else:m.add(sum(active)==len(cfg['days']))
    for prior in (excluded or []):
        matches=[xs[i][slots.index((e['day'],e['period']))] for i,e in enumerate(prior) if (e['day'],e['period']) in slots]
        if matches:m.add(sum(matches)<=len(events)-1)
    m.minimize(sum(objective)+(100000*sum(moves) if target else 0))
    solver=cp_model.CpSolver();solver.parameters.max_time_in_seconds=seconds;solver.parameters.num_search_workers=1;solver.parameters.random_seed=seed
    status=solver.solve(m)
    if status not in (cp_model.OPTIMAL,cp_model.FEASIBLE):return {'ok':False,'reason':'Умови несумісні з поточним складом підгруп.' if status==cp_model.INFEASIBLE else 'За відведений час варіант не знайдено. Спробуйте ще раз або послабте побажання. Це не доказ неможливості.','status':solver.status_name(status)}
    for i,e in enumerate(events):e['day'],e['period']=slots[next(j for j,v in enumerate(xs[i]) if solver.value(v))]
    report=audit(base,events,cfg)
    if not report['passed']:raise ValueError('Незалежна перевірка відхилила результат: '+' '.join(report['errors']))
    if target and not any(e['id']==target['event'] and e['day']==target['day'] and e['period']==target['period'] for e in events):raise ValueError('Не виконано запитане перенесення.')
    changes=[{'id':e['id'],'course':e['course'],'teacher':e['teacher'],'from':[old['day'],old['period']],'to':[e['day'],e['period']],'students':len(e['studentIds'])} for old,e in zip(base,events) if (old['day'],old['period'])!=(e['day'],e['period'])]
    return {'ok':True,'events':events,'report':report,'changes':changes,'optimal':status==cp_model.OPTIMAL}
