from http.server import BaseHTTPRequestHandler
import json, os
from server.dean_service import PublicError,handle

class handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,status,value):
        data=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status)
        for k,v in {'Content-Type':'application/json; charset=utf-8','Content-Length':str(len(data)),
                    'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'}.items():self.send_header(k,v)
        self.end_headers();self.wfile.write(data)
    def do_GET(self):self.respond(405,{'error':'Використайте захищений кабінет.'})
    def do_POST(self):
        try:
            origins={'https://www.xelay.ink','https://xelay.ink'}
            if os.environ.get('VERCEL_ENV')=='preview' and os.environ.get('VERCEL_URL'):origins.add('https://'+os.environ['VERCEL_URL'])
            if self.headers.get('Origin') not in origins or self.headers.get('Sec-Fetch-Site','same-origin')!='same-origin':raise PublicError('Недозволене джерело запиту.',403)
            token=self.headers.get('Authorization','')
            if not token.startswith('Bearer ') or len(token)>8192:raise PublicError('Увійдіть до кабінету.',401)
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise PublicError('Потрібен JSON.',415)
            n=int(self.headers.get('Content-Length','0'))
            if not 1<=n<=50000:raise PublicError('Запит завеликий.',413)
            result=handle(json.loads(self.rfile.read(n)),token[7:])
            self.respond(200,result)
        except PublicError as e:self.respond(e.status,{'error':str(e)})
        except (ValueError,KeyError,TypeError):self.respond(400,{'error':'Некоректні параметри запиту.'})
        except Exception:self.respond(503,{'error':'Сервіс тимчасово недоступний. Чернетку збережено.'})
