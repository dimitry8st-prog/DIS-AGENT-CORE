#!/usr/bin/env python3
"""Fresh, isolated Docker stand. Never reuses/stops a pre-existing service."""
import json, os, secrets, subprocess, tempfile, time, urllib.request, urllib.error, uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
IMAGE='n8nio/n8n:2.42.6@sha256:526daa38b68e923cc00c5280d18b4da5d489f115a73bdbf3b8e452b184197a9a'

def main():
    suffix=uuid.uuid4().hex[:10]
    net='dis-review-'+suffix; pg=net+'-pg'; n8n=net+'-n8n'
    key=secrets.token_hex(32)
    report={'n8n_version':'2.42.6','status':'BLOCKED','phases':[]}
    created=[]
    env=os.environ.copy()
    for k in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']:
        env.pop(k,None)
    env['DOCKER_HOST']='unix:///var/run/docker.sock'
    def command(*args,input=None,timeout=120):
        r=subprocess.run(args,cwd=ROOT,env=env,input=input,text=True,capture_output=True,timeout=timeout)
        if r.returncode: raise RuntimeError((r.stderr or r.stdout)[-4000:].replace(key,'[REDACTED]'))
        return r.stdout
    def ready(url):
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(120):
            try:
                with opener.open(url+'/healthz/readiness',timeout=2) as r:
                    if json.load(r).get('status')=='ok': return
            except (OSError,ValueError): pass
            time.sleep(1)
        raise RuntimeError('owned n8n did not become ready')
    out=ROOT/'.local'/'review-e2e-results.json';out.parent.mkdir(exist_ok=True)
    try:
        version=command('docker','run','--rm',IMAGE,'--version',timeout=180).strip()
        if version!='2.42.6': raise RuntimeError('unexpected n8n version: '+version)
        command('docker','network','create',net);created.append(('network',net))
        command('docker','run','-d','--name',pg,'--label','dis.review='+suffix,'--network',net,'--network-alias','postgres',
                '-e','POSTGRES_USER=dis','-e','POSTGRES_DB=dis_core_test','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16')
        created.append(('container',pg))
        for _ in range(40):
            r=subprocess.run(['docker','exec',pg,'pg_isready','-U','dis'],capture_output=True,env=env)
            if r.returncode==0: break
            time.sleep(1)
        else: raise RuntimeError('owned PostgreSQL did not become ready')
        for file in sorted((ROOT/'db').glob('*.sql')):
            command('docker','exec','-i',pg,'psql','-U','dis','-d','dis_core_test','-v','ON_ERROR_STOP=1',input=file.read_text())
        # No published PostgreSQL port. n8n is reachable only via host loopback.
        args=['docker','run','-d','--name',n8n,'--label','dis.review='+suffix,'--network',net,'-p','127.0.0.1::5678']
        settings={'N8N_DIAGNOSTICS_ENABLED':'false','N8N_PERSONALIZATION_ENABLED':'false',
          'N8N_HOST':'127.0.0.1','N8N_LISTEN_ADDRESS':'0.0.0.0','N8N_PROTOCOL':'http','N8N_SECURE_COOKIE':'false',
          'NODE_FUNCTION_ALLOW_BUILTIN':'crypto',
          'N8N_BLOCK_ENV_ACCESS_IN_NODE':'false','DIS_GATEWAY_HMAC_KEY':key}
        for k,v in settings.items(): args+=['-e',k+'='+v]
        command(*args,IMAGE);created.append(('container',n8n))
        port=command('docker','port',n8n,'5678/tcp').strip().split(':')[-1]
        url='http://127.0.0.1:'+port
        print('isolated n8n started; importing workflows',flush=True)
        ready(url)
        with tempfile.TemporaryDirectory(prefix='dis-review-input-') as directory:
            d=Path(directory)
            credential=[{'id':'disReviewPg','name':'Isolated review PostgreSQL','type':'postgres','data':{
              'host':'postgres','port':5432,'database':'dis_core_test','user':'dis','password':'','ssl':'disable','sshTunnel':False}}]
            (d/'credential.json').write_text(json.dumps(credential))
            command('docker','cp',str(d/'credential.json'),n8n+':/tmp/review-credential.json')
            result=command('docker','exec',n8n,'n8n','import:credentials','--input=/tmp/review-credential.json')
            if 'Successfully imported 1 credential' not in result: raise RuntimeError('credential import unconfirmed')
            command('docker','exec',n8n,'mkdir','-p','/tmp/review-workflows')
            for p in sorted((ROOT/'workflows').glob('*.json')):
                w=json.loads(p.read_text())
                for n in w['nodes']:
                    if n['type'].endswith('.postgres'): n['credentials']['postgres']={'id':'disReviewPg','name':'Isolated review PostgreSQL'}
                    if n['type'].endswith('.webhook'): n['parameters']['path']='dis-review'
                (d/p.name).write_text(json.dumps(w))
                command('docker','cp',str(d/p.name),n8n+':/tmp/review-workflows/'+p.name)
            for phase in ['first_import','reimport']:
                print('phase '+phase+': CLI import/publication',flush=True)
                result=command('docker','exec',n8n,'n8n','import:workflow','--separate','--input=/tmp/review-workflows')
                if 'Successfully imported 5 workflows' not in result: raise RuntimeError('workflow import unconfirmed')
                for i in range(4,-1,-1):
                    result=command('docker','exec',n8n,'n8n','publish:workflow','--id=disCoreWF0'+str(i))
                    if 'Please restart n8n' not in result: raise RuntimeError('workflow publication unconfirmed')
                command('docker','restart',n8n)
                port=command('docker','port',n8n,'5678/tcp').strip().split(':')[-1]
                url='http://127.0.0.1:'+port
                ready(url)
                driver_env={**env,'DIS_E2E_URL':url,'DIS_E2E_PG':pg,'DIS_E2E_N8N':n8n,'DIS_GATEWAY_HMAC_KEY':key}
                r=subprocess.run(['node','tests/e2e_review.mjs'],cwd=ROOT,env=driver_env,text=True,capture_output=True,timeout=180)
                if r.returncode: raise RuntimeError((r.stdout+r.stderr)[-5000:].replace(key,'[REDACTED]'))
                result=json.loads(r.stdout.strip().splitlines()[-1]);report['phases'].append({'phase':phase,**result})
                print(phase+': '+json.dumps(result),flush=True)
        report['status']='PASS_WITH_EXPECTED_FAILURE'
        return 0
    except Exception as exc:
        report['status']='FAIL' if created else 'BLOCKED'
        report['error']=str(exc).replace(key,'[REDACTED]')
        log=subprocess.run(['docker','logs','--tail','60',n8n],capture_output=True,text=True,env=env)
        report['diagnostic']=(log.stdout+log.stderr)[-5000:].replace(key,'[REDACTED]')
        print(json.dumps(report),flush=True)
        return 1
    finally:
        # Only resources created by this invocation; no shared service mutations.
        for kind,name in reversed(created):
            args=['docker','rm','-f',name] if kind=='container' else ['docker','network','rm',name]
            subprocess.run(args,capture_output=True,env=env)
        out.write_text(json.dumps(report,indent=2)+'\n')

if __name__=='__main__': raise SystemExit(main())
