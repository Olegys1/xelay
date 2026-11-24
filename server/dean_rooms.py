"""Room constraints shared by allocation and independent schedule validation."""
from collections import defaultdict

def assign_fixed_rooms(events,catalog,students,seconds=6):
    import copy
    from ortools.sat.python import cp_model
    rooms=room_catalog(catalog);roster={s['id']:s for s in students};m=cp_model.CpModel();variables=[];costs=[]
    for i,e in enumerate(events):
        options=[j for j,r in enumerate(rooms) if eligible(e,r,roster) and [e['day'],e['period']] not in r['blockedSlots']]
        if not options:return None
        v=m.new_int_var_from_domain(cp_model.Domain.from_values(options),'room'+str(i));variables.append(v)
        costs_by_room=[(j,abs(rooms[j]['capacity']-len(e['studentIds']))*100+int(rooms[j]['computer'] and e['activity']!='lab')) for j in options]
        cost=m.new_int_var(0,500001,'cost'+str(i));m.add_allowed_assignments([v,cost],costs_by_room);costs.append(cost)
        if e.get('room') in {rooms[j]['id'] for j in options}:m.add_hint(v,next(j for j in options if rooms[j]['id']==e['room']))
    occupied=defaultdict(list)
    for i,e in enumerate(events):
        for w in e['weeks']:occupied[w,e['day'],e['period']].append(i)
    for indices in {tuple(v) for v in occupied.values()}:
        if len(indices)>1:m.add_all_different([variables[i] for i in indices])
    m.minimize(sum(costs));solver=cp_model.CpSolver();solver.parameters.max_time_in_seconds=seconds;solver.parameters.num_search_workers=1
    if solver.solve(m) not in (cp_model.OPTIMAL,cp_model.FEASIBLE):return None
    result=copy.deepcopy(events)
    for i,e in enumerate(result):e['room']=rooms[solver.value(variables[i])]['id']
    return result if audit_rooms(result,rooms,students)['passed'] else None

def room_catalog(value):
    if value is None:return []
    if not isinstance(value,list) or len(value)>200:raise ValueError('Каталог підтримує до 200 аудиторій.')
    out=[];seen=set()
    for r in value:
        if not isinstance(r,dict) or not isinstance(r.get('id'),str) or not 1<=len(r['id'].strip())<=80 or r['id'] in seen:raise ValueError('Перевірте назви аудиторій: вони мають бути унікальними.')
        seen.add(r['id'])
        disabled=r.get('disabled',False);computer=r.get('computer',False);capacity=r.get('capacity')
        if type(disabled)!=bool or type(computer)!=bool or not (capacity is None and disabled or type(capacity)==int and 1<=capacity<=5000):raise ValueError('Вкажіть місткість та тип кожної доступної аудиторії.')
        blocked=r.get('blockedSlots',[]);programs=r.get('allowedPrograms',[])
        if not isinstance(blocked,list) or len(blocked)>30 or any(not isinstance(x,list) or len(x)!=2 or type(x[0])!=int or type(x[1])!=int or not 1<=x[0]<=5 or not 1<=x[1]<=6 for x in blocked):raise ValueError('Некоректна зайнятість аудиторії.')
        if not isinstance(programs,list) or len(programs)>100 or any(not isinstance(x,str) or not 1<=len(x.strip())<=120 for x in programs):raise ValueError('Некоректні напрями для аудиторії.')
        note=r.get('note','')
        if not isinstance(note,str) or len(note)>1000:raise ValueError('Примітка аудиторії надто довга.')
        out.append(dict(id=r['id'],capacity=capacity,computer=computer,disabled=disabled,
                        blockedSlots=blocked,allowedPrograms=[p.strip().upper() for p in programs],note=note))
    return out

def eligible(event,room,students):
    if room['disabled'] or room['capacity'] is None or len(event['studentIds'])>room['capacity']+3:return False
    if event['activity']=='lab' and not room['computer']:return False
    if room['allowedPrograms']:
        for sid in event['studentIds']:
            program=students.get(sid,{}).get('group','').split('-')[0].strip().upper()
            if program not in room['allowedPrograms']:return False
    return True

def audit_rooms(events,catalog,students):
    rooms={r['id']:r for r in room_catalog(catalog)}
    roster={s['id']:s for s in students};occupied=set();errors=[];used=set();laptops=0;excess=0
    for e in events:
        r=rooms.get(e.get('room'))
        if not r or not eligible(e,r,roster):
            errors.append('Не призначено допустиму аудиторію.');continue
        if [e['day'],e['period']] in r['blockedSlots']:errors.append('Аудиторія зайнята в цей час.')
        used.add(r['id']);over=max(0,len(e['studentIds'])-r['capacity']);excess=max(excess,over)
        laptops+=int(e['activity']=='lab' and over>0)
        for week in e['weeks']:
            key=(r['id'],week,e['day'],e['period'])
            if key in occupied:errors.append('Дві пари одночасно займають одну аудиторію.')
            occupied.add(key)
    return dict(passed=not errors,errors=list(dict.fromkeys(errors)),rooms=len(used),
                assigned=sum(e.get('room') in rooms for e in events),laptopClasses=laptops,maxExcess=excess)

def add_room_constraints(model,events,catalog,students,slots,xs):
    rooms=room_catalog(catalog);roster={s['id']:s for s in students}
    room_vars=[];room_slots=[];costs=[]
    for i,e in enumerate(events):
        options=[j for j,r in enumerate(rooms) if eligible(e,r,roster)]
        if not options:raise ValueError('Для одного із занять немає аудиторії відповідного типу та місткості.')
        rv=model.new_int_var(0,len(rooms)-1,'room'+str(i))
        sv=model.new_int_var(0,len(slots)-1,'slot'+str(i))
        model.add(sv==sum(j*x for j,x in enumerate(xs[i])))
        tuples=[(j,k) for j in options for k,slot in enumerate(slots) if list(slot) not in rooms[j]['blockedSlots']]
        if not tuples:raise ValueError('Аудиторії для одного із занять недоступні в обрані дні.')
        model.add_allowed_assignments([rv,sv],tuples)
        rs=model.new_int_var(0,len(rooms)*len(slots)-1,'roomslot'+str(i))
        model.add(rs==rv*len(slots)+sv)
        cost=model.new_int_var(0,5000,'roomfit'+str(i))
        model.add_allowed_assignments([rv,cost],[(j,abs(rooms[j]['capacity']-len(e['studentIds']))) for j in options])
        costs.append(cost);room_vars.append(rv);room_slots.append(rs)
        if e.get('room') in {rooms[j]['id'] for j in options}:
            model.add_hint(rv,next(j for j in options if rooms[j]['id']==e['room']))
    patterns={tuple(i for i,e in enumerate(events) if week in e['weeks']) for week in {w for e in events for w in e['weeks']}}
    for pattern in patterns:
        if len(pattern)>1:model.add_all_different([room_slots[i] for i in pattern])
    return rooms,room_vars,costs

