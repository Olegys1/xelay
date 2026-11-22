import copy,json,socket,unittest
from unittest.mock import patch
from server.dean_planner import DEFAULTS,solve,audit,settings
from server.dean_service import validate_source,calculate,create_staff,PublicError,configuration

def source():
 return {'students':[{'id':'s','name':'Synthetic'}], 'events':[{'id':str(i),'course':'Synthetic','activity':'lecture','teacher':'Synthetic','teacherIds':['t'],'studentIds':['s'],'day':d,'period':p,'weeks':[1,2]} for i,(d,p) in enumerate((d,p) for d in range(1,6) for p in [1,2])]}

class SolverTests(unittest.TestCase):
 def test_other_variant_and_cascade(self):
  data=source();base=copy.deepcopy(data)
  r=solve(data['events'],DEFAULTS,1,target={'event':'0','day':2,'period':1},seconds=3)
  self.assertTrue(r['ok']);self.assertEqual(data,base);self.assertTrue(r['report']['passed']);self.assertGreaterEqual(len(r['changes']),2)
  self.assertEqual((r['events'][0]['day'],r['events'][0]['period']),(2,1))
  second=solve(data['events'],DEFAULTS,2,excluded=[r['events']],seconds=3)
  self.assertTrue(second['ok']);self.assertNotEqual(second['events'],r['events'])
 def test_independent_verifier_rejects_lost_hours_and_students(self):
  base=source()['events']
  for field,value in [('weeks',[1]),('studentIds',[]),('period',2)]:
   bad=copy.deepcopy(base);bad[0][field]=value;self.assertFalse(audit(base,bad,DEFAULTS)['passed'])
 def test_low_load_exception_and_unavailability(self):
  events=source()['events'][:6];self.assertTrue(audit(events,events,DEFAULTS)['passed'])
  cfg=copy.deepcopy(DEFAULTS);cfg['blocked']=[{'teacher':'t','day':d,'period':p} for d in range(1,6) for p in range(1,7)]
  self.assertEqual(solve(events,cfg,seconds=1)['status'],'INFEASIBLE')
 def test_validation_rejects_unbounded_or_malformed_work(self):
  self.assertEqual(len(validate_source(source())),10)
  for change in [{'events':[]},{'events':[{}]},{'events':source()['events']*61}]:
   with self.assertRaises(PublicError):validate_source({**source(),**change})
  for cfg in [{'days':[]},{'maxDaily':True},{'minDaily':5,'maxDaily':2}]:
   with self.assertRaises(ValueError):settings(cfg)
 def test_no_incompatible_provider_destination(self):
  with self.assertRaises(PublicError):configuration({'SUPABASE_URL':'https://other.example','SUPABASE_SERVICE_ROLE':'test'})
 def test_auth_denial_never_runs_solver(self):
  class Denied:
   def rpc(self,*args):raise PublicError('denied',403)
  with self.assertRaises(PublicError):calculate(Denied(),{'draftId':'00000000-0000-4000-8000-000000000001','revision':1},lambda *a,**k:self.fail('solver ran'))
 def test_persisted_result_without_publication_and_failure_safety(self):
  class Backend:
   def __init__(self):self.calls=[]
   def rpc(self,action,body):self.calls.append(action);return {'job':'job','document':{'source':source()}}
   def request(self,path,body,privileged):self.calls.append(path);self.result=body['p_result'];return True
  b=Backend();r=calculate(b,{'draftId':'00000000-0000-4000-8000-000000000001','revision':1},lambda *a,**k:{'ok':False,'reason':'No result'})
  self.assertEqual(r,{'job':'job'});self.assertFalse(b.result['ok']);self.assertNotIn('publish',b.calls)
 def test_staff_credentials_are_unique_and_never_sent_to_rpc(self):
  class Backend:
   def __init__(self):self.calls=[]
   def rpc(self,action,payload):self.calls.append((action,payload));return []
   def request(self,path,body=None,privileged=False,method='POST'):return {'id':'00000000-0000-4000-8000-000000000001'}
  b=Backend();r=create_staff(b,{'count':5});self.assertEqual(len(r['credentials']),5)
  self.assertEqual(len({c['password'] for c in r['credentials']}),5);self.assertTrue(all(len(c['password'])>=32 for c in r['credentials']))
  self.assertNotIn('password',json.dumps(b.calls));self.assertEqual(b.calls[0][0],'staff_list')

class HttpBoundaryTests(unittest.TestCase):
 def test_untrusted_origin_and_missing_session_never_reach_backend(self):
  from api.dean import handler
  from io import BytesIO
  cases=[({'Origin':'https://evil.example','Authorization':'Bearer synthetic'},403),
         ({'Origin':'https://www.xelay.ink'},401),
         ({'Origin':'https://www.xelay.ink','Authorization':'Bearer synthetic','Content-Type':'text/plain'},415),
         ({'Origin':'https://www.xelay.ink','Authorization':'Bearer synthetic','Content-Type':'application/json','Content-Length':'999999'},413)]
  for headers,status in cases:
   request=object.__new__(handler);request.headers=headers;request.rfile=BytesIO(b'{}')
   result=[];request.respond=lambda code,data:result.append(code)
   with patch('api.dean.handle',side_effect=AssertionError('Unauthorized backend call')):request.do_POST()
   self.assertEqual(result,[status])

def setUpModule():
 # Applies both to direct execution and unittest discovery in required CI.
 global network_guard
 network_guard=patch.object(socket,'create_connection',side_effect=AssertionError('network disabled'))
 network_guard.start()
def tearDownModule():network_guard.stop()
if __name__=='__main__':unittest.main()
