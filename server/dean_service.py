"""Authenticated orchestration. Secrets never enter logs, persisted jobs, or solver input."""
import json, os, secrets, uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError

class PublicError(Exception):
    def __init__(self, message, status=400): super().__init__(message); self.status=status

def configuration(env=os.environ):
    url=(env.get('SUPABASE_URL') or env.get('VITE_SUPABASE_URL') or '').rstrip('/')
    # A fixed project prevents accidental credential forwarding to arbitrary hosts.
    if url!='https://baohfpadxvhqhhjjqtil.supabase.co': raise PublicError('Сервіс ще не налаштовано.',503)
    secret=env.get('SUPABASE_SERVICE_ROLE_KEY') or env.get('SUPABASE_SERVICE_ROLE')
    if not secret: raise PublicError('Сервіс ще не налаштовано.',503)
    return url,secret

class Backend:
    def __init__(self, token, env=os.environ): self.url,self.secret=configuration(env); self.token=token
    def request(self,path,body=None,privileged=False,method='POST'):
        token=self.secret if privileged else self.token
        req=Request(self.url+path,data=None if body is None else json.dumps(body).encode(),method=method,
          headers={'apikey':self.secret,'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        try:
            with urlopen(req,timeout=25) as response:return json.load(response)
        except HTTPError as e:
            # Translate only reviewed fixed database codes, never provider payloads.
            try: code=json.loads(e.read(4096)).get('message','')
            except Exception: code=''
            messages={'DEAN_CALC_BUSY':'Інший розрахунок ще працює. Спробуйте трохи пізніше.',
              'DEAN_CALC_LIMIT':'Денний ліміт розрахунків вичерпано.',
              'DEAN_STALE_VERSION':'Версія змінилась. Відкрийте чернетку знову.',
              'DEAN_MFA_REQUIRED':'Підтвердіть другий фактор.',
              'DEAN_DRAFT_DENIED':'Немає доступу до цієї чернетки.',
              'DEAN_ACCESS_DENIED':'Доступ до кабінету не надано.'}
            raise PublicError(messages.get(code,'Запит відхилено. Перевірте доступ і повторіть спробу.'),403 if e.code in (401,403) else 400) from None
    def rpc(self,action,payload):return self.request('/rest/v1/rpc/xelay_dean_online',{'p_action':action,'p_payload':payload})

def validate_source(source):
    if not isinstance(source,dict): raise PublicError('Некоректні вхідні дані.')
    events=source.get('events'); students=source.get('students')
    if not isinstance(events,list) or not 1<=len(events)<=600 or not isinstance(students,list) or len(students)>5000: raise PublicError('Онлайн-розрахунок підтримує до 600 шаблонів і 5000 студентів.')
    roster={s.get('id') for s in students if isinstance(s,dict) and isinstance(s.get('id'),str)}
    seen=set();size=0
    for e in events:
        if not isinstance(e,dict) or not isinstance(e.get('id'),str) or e['id'] in seen: raise PublicError('Некоректний ідентифікатор заняття.')
        seen.add(e['id'])
        for k in ('studentIds','teacherIds','weeks'):
            v=e.get(k)
            if not isinstance(v,list) or len(v)>5000 or any(not isinstance(x,(str,int)) or isinstance(x,bool) for x in v) or len(v)!=len(set(v)):raise PublicError('Некоректний склад заняття.')
        if not e['studentIds'] or not set(e['studentIds'])<=roster or not e['weeks'] or len(e['weeks'])>30 or any(type(w)!=int or not 1<=w<=30 for w in e['weeks']):raise PublicError('Некоректні студенти або тижні.')
        if any(not isinstance(t,str) or len(t)>200 for t in e['teacherIds']) or len(e['teacherIds'])>10:raise PublicError('Некоректні викладачі.')
        if e.get('activity') not in ('lecture','practice','lab','seminar') or (e['activity']=='lab' and len(e['studentIds'])>18):raise PublicError('Некоректний вид або розмір заняття.')
        if any(type(e.get(k))!=int or not 1<=e[k]<=n for k,n in [('day',5),('period',6)]):raise PublicError('Некоректний час заняття.')
        if not isinstance(e.get('course'),str) or not isinstance(e.get('teacher'),str):raise PublicError('Некоректна дисципліна.')
        size+=(len(e['studentIds'])+len(e['teacherIds']))*len(e['weeks'])
    if size>250000:raise PublicError('Розділіть великий розрахунок на навчальні періоди.')
    return events

def calculate(backend,body,solver=None):
    from server.dean_planner import settings,solve
    solver=solver or solve
    cfg=settings(body.get('settings',{}))
    target=body.get('target')
    if target is not None and (not isinstance(target,dict) or set(target)!={'event','day','period'} or not isinstance(target['event'],str) or type(target['day'])!=int or type(target['period'])!=int):raise PublicError('Некоректне перенесення.')
    job=backend.rpc('begin',{'draftId':str(uuid.UUID(body['draftId'])),'revision':int(body['revision']),'settings':cfg,'target':target})
    try:
        events=validate_source(job['document']['source']);options=[];excluded=[];note=''
        # Original schedule is excluded, so "another variant" cannot return it unchanged.
        excluded.append(events)
        for i in range(2):
            response=solver(events,cfg,seed=secrets.randbelow(1000000),target=target,excluded=excluded,seconds=25)
            if not response['ok']:note=response['reason'];break
            options.append(response);excluded.append(response['events'])
        result={'ok':bool(options),'options':options,'note':note or 'Варіанти перевірено. Застосування створить окрему копію.'}
    except (ValueError,PublicError) as e: result={'ok':False,'options':[],'note':str(e)}
    except Exception: result={'ok':False,'options':[],'note':'Розрахунок перервано. Початкова чернетка збережена.'}
    finished=backend.request('/rest/v1/rpc/xelay_dean_finish_job',{'p_id':job['job'],'p_result':result},True)
    if not finished:raise PublicError('Сесію або доступ змінено. Початкова чернетка збережена.',409)
    return {'job':job['job']}

def create_staff(backend,body):
    # Authorization happens before generating credentials or invoking Admin Auth.
    backend.rpc('staff_list',{})
    count=body.get('count',1)
    if type(count)!=int or not 1<=count<=5:raise PublicError('Від 1 до 5 акаунтів за один раз.')
    draft_id=str(uuid.UUID(body['draftId'])) if body.get('draftId') else None
    if draft_id:backend.request('/rest/v1/rpc/xelay_dean_workspace',{'p_action':'load','p_payload':{'id':draft_id}})
    actor=backend.request('/auth/v1/user',None,method='GET')['id'];created=[]
    for i in range(count):
        login='dean-'+secrets.token_hex(5)+'@dean.xelay.ink';password=secrets.token_urlsafe(24)
        label='Деканат · робоче місце '+str(i+1)
        user=None
        reserved_id=str(uuid.uuid4())
        try:
            backend.request('/rest/v1/rpc/xelay_dean_reserve_staff',{'p_user_id':reserved_id,'p_login':login})
            user=backend.request('/auth/v1/admin/users',{'id':reserved_id,'email':login,'password':password,'email_confirm':True,
              'user_metadata':{'full_name':label,'name':label},'app_metadata':{'dean_service':True,'created_by':actor}},True)
            backend.rpc('staff_register',{'userId':user['id'],'login':login,'label':label,'draftId':draft_id})
            created.append({'login':login,'password':password,'label':label})
        except Exception:
            if user:
                try:backend.request('/auth/v1/admin/users/'+str(uuid.UUID(user['id'])),{'ban_duration':'876000h'},True,'PUT')
                except Exception:pass # No staff grant means the account cannot enter the cabinet.
            break
    if not created:raise PublicError('Акаунти не створено. Перевірте налаштування реєстрації.',503)
    return {'credentials':created,'complete':len(created)==count}

def handle(body,token,backend_factory=Backend):
    if not isinstance(body,dict):raise PublicError('Некоректний запит.')
    backend=backend_factory(token)
    if body.get('action')=='calculate':return calculate(backend,body)
    if body.get('action')=='create_staff':return create_staff(backend,body)
    raise PublicError('Невідома дія.')
