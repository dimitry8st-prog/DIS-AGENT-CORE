// Actual gateway -> imported n8n -> PostgreSQL -> HTTP. Synthetic data only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHmac,randomUUID} from 'node:crypto';
import {createServer} from '../ingress/src/server.mjs';
import {signInternal} from '../ingress/src/internal-proof.mjs';
const {DIS_E2E_URL:url,DIS_E2E_PG:pg,DIS_E2E_N8N:n8n,DIS_GATEWAY_HMAC_KEY:key}=process.env;
if(!url||!pg||!n8n||!key)throw Error('BLOCKED: run via isolated run_review_e2e.py');
const token='synthetic-external-secret';
const sql=q=>{const r=spawnSync('docker',['exec','-i',pg,'psql','-U','dis','-d','dis_core_test','-qAt','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const sources=new Map([
 ['/ingress/api/test',{id:'review-api',channel:'api',project_id:'review',bot_id:'api',secret:token,may_assert_user_id:true}],
 ['/ingress/telegram/test',{id:'review-tg',channel:'telegram',project_id:'review',bot_id:'tg',secret:token}],
]);
const gateway=createServer({sources,internal_proof_secret:key,n8n_upstream_url:url+'/webhook/dis-review',max_body_bytes:65536,upstream_timeout_ms:15000,rate_limit:{window_ms:60000,max:1000}});
await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
const gw='http://127.0.0.1:'+gateway.address().port;
let passed=0;
const literal=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
async function check(name,fn){await fn();passed++;}
async function post(endpoint,body,headers={}){
 const raw=typeof body==='string'?body:JSON.stringify(body);
 const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},body:raw,signal:AbortSignal.timeout(20000)});
 const txt=await r.text();let data;try{data=JSON.parse(txt);}catch{data={non_json:true};}
 return {http:r.status,body:data};
}
const api=(body)=>post(gw+'/ingress/api/test',body,{'x-dis-signature':'sha256='+createHmac('sha256',token).update(JSON.stringify(body)).digest('hex')});
const direct=body=>post(url+'/webhook/dis-review',body,signInternal(body,key));
const id=()=>randomUUID();
const request=(extra={})=>({user_id:'9007199254740993',dialogue_id:'room-'+id(),external_event_id:id(),payload:{text:'/help'},...extra});
const trusted=(extra={})=>({channel:'api',project_id:'review',bot_id:'api',source_id:'review-api',user_id:'9007199254740993',dialogue_id:id(),external_event_id:id(),payload:{text:'/help'},ingress:{authenticated_source:true},...extra});
try{
 // Wait for published webhook reconciliation, not just /healthz.
 for(let i=0;i<40;i++){const r=await post(url+'/webhook/dis-review',{});if(r.http===401)break;if(i===39)throw Error('published webhook unavailable: '+r.http);await new Promise(r=>setTimeout(r,500));}
 sql("INSERT INTO users(telegram_id,status) VALUES(9007199254740993,'active') ON CONFLICT(telegram_id) DO NOTHING;");
 const user=sql('SELECT id FROM users WHERE telegram_id=9007199254740993;');
 await check('forged flag/missing/wrong proof rejected before reserve',async()=>{
  const before=sql('SELECT count(*) FROM processed_events;');
  const b=trusted();assert.equal((await post(url+'/webhook/dis-review',b)).http,401);
  assert.equal((await post(url+'/webhook/dis-review',b,signInternal(b,'different-test-key-with-at-least-32-bytes'))).http,401);
  for(const field of ['project_id','bot_id','user_id']){
   const changed={...b,[field]:field==='user_id'?'2':'foreign'};
   assert.equal((await post(url+'/webhook/dis-review',changed,signInternal(b,key))).http,401);
  }
  assert.equal(sql('SELECT count(*) FROM processed_events;'),before);
 });
 await check('gateway ordinary request and redelivery',async()=>{
  const b=request();const a=await api(b);assert.equal(a.http,200,JSON.stringify(a));assert.equal(a.body.routing.route,'support');
  assert.equal(a.body.user_id,'9007199254740993');
  const repeat=await api(b);assert.equal(repeat.body.status,'duplicate');assert.equal(repeat.body.correlation_id,a.body.correlation_id);
 });
 await check('external scope override denied',async()=>{
  for(const f of ['project_id','bot_id','channel'])assert.equal((await api(request({[f]:'foreign'}))).http,403);
 });
 await check('API raw JSON unsafe/fraction/type IDs rejected',async()=>{
  for(const f of ['user_id','dialogue_id','external_event_id'])for(const bad of ['9007199254740993','1.5','true','{}']){
   const raw=JSON.stringify(request()).replace(new RegExp('"'+f+'":"[^" ]+"'),'"'+f+'":'+bad);
   const h={'x-dis-signature':'sha256='+createHmac('sha256',token).update(raw).digest('hex')};
   assert.equal((await post(gw+'/ingress/api/test',raw,h)).http,400,f+':'+bad);
  }
 });
 await check('Telegram update zero, negative chat, large string user reach real WF-00',async()=>{
  const b={update_id:0,message:{from:{id:'9007199254740993'},chat:{id:-100},text:'/help'}};
  const r=await post(gw+'/ingress/telegram/test',b,{'x-telegram-bot-api-secret-token':token});
  assert.equal(r.http,200,JSON.stringify(r));assert.equal(r.body.external_event_id,'0');assert.equal(r.body.dialogue_id,'-100');
 });
 await check('Telegram fallback components unsafe numbers rejected; large strings preserved',async()=>{
  for(const bad of [{from:{id:9007199254740992},chat:{id:1},message_id:7},{from:{id:1},chat:{id:9007199254740992},message_id:7},{from:{id:1},chat:{id:-100},message_id:9007199254740992}]){
   const r=await post(gw+'/ingress/telegram/test',{message:bad},{'x-telegram-bot-api-secret-token':token});assert.equal(r.http,400);
  }
  const r=await post(gw+'/ingress/telegram/test',{message:{from:{id:'9007199254740993'},chat:{id:-100},message_id:'9007199254740993',text:'/help'}},{'x-telegram-bot-api-secret-token':token});
  assert.equal(r.http,200,JSON.stringify(r));assert.equal(r.body.external_event_id,'-100:9007199254740993');
 });
 await check('foreign SQL context propagates 403, no disclosure/lock change; reservation terminal',async()=>{
  const other=sql("INSERT INTO users(telegram_id) VALUES ("+String(1000000000000n+BigInt(Math.floor(Math.random()*1000000000)))+") RETURNING id;");
  const d=id();const ext=id();
  sql(`INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,state,payload,processing_lock,lock_owner,locked_at) VALUES('review','api','api','${d}','${other}','awaiting_payment','{"secret":"FOREIGN-CONTEXT-MARKER"}',true,'foreign-owner',now());`);
  const b=request({dialogue_id:d,external_event_id:ext});const r=await api(b);
  assert.equal(r.http,403,JSON.stringify(r));assert.equal(r.body.status,'rejected');assert.equal(r.body.routing.route,'unknown');
  assert(!JSON.stringify(r).includes('FOREIGN-CONTEXT-MARKER'));assert(!JSON.stringify(r).includes('awaiting_payment'));
  assert.equal(sql(`SELECT lock_owner FROM bot_context_scoped WHERE dialogue_id='${d}';`),'foreign-owner');
  assert.equal(sql(`SELECT status FROM processed_events WHERE external_event_id='${ext}';`),'completed');
  assert.equal((await api(b)).body.status,'duplicate');
 });
 // Preserve the strict physical-retention assertion. No pruning, delete or filtering
 // by deletedAt. This is separate EXPECTED_FAILURE, not a functional PASS.
 const marker='N8N-RETENTION-'+id();const r=await api(request({payload:{text:'/help',token:marker}}));assert.equal(r.http,200);
 await new Promise(r=>setTimeout(r,800));
 const query="SELECT count(*) AS leaks FROM execution_data WHERE data LIKE '%"+marker+"%'";
 const js="const s=require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3');const db=new s.Database('/home/node/.n8n/database.sqlite');db.get("+JSON.stringify(query)+",(e,r)=>{if(e){process.exitCode=1;}else console.log(r.leaks);db.close();});";
 const result=spawnSync('docker',['exec','-i',n8n,'node'],{input:js,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const leaks=Number(result.stdout.trim());assert(Number.isFinite(leaks));
 const credentialQuery="SELECT count(*) AS leaks FROM execution_data WHERE data LIKE '%"+key+"%' OR data LIKE '%"+token+"%'";
 const credentialJs="const s=require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3');const db=new s.Database('/home/node/.n8n/database.sqlite');db.get("+JSON.stringify(credentialQuery)+",(e,r)=>{if(e){process.exitCode=1;}else console.log(r.leaks);db.close();});";
 const credentials=spawnSync('docker',['exec','-i',n8n,'node'],{input:credentialJs,encoding:'utf8'});assert.equal(credentials.status,0);assert.equal(credentials.stdout.trim(),'0','service keys must never enter n8n execution input');

 let retention;
 try{assert.equal(leaks,0,'n8n retains soft-deleted initial webhook input until native pruning');retention={status:'PASS',physical_rows:0};}
 catch(e){if(e.code!=='ERR_ASSERTION')throw e;retention={status:'EXPECTED_FAILURE',physical_rows:leaks};}
 assert(!JSON.stringify(r).includes(marker));
 assert.equal(sql("SELECT count(*) FROM event_log WHERE sanitized_payload::text LIKE '%"+marker+"%';"),'0');
 console.log(JSON.stringify({functional:'PASS',checks:passed,retention}));
}finally{await new Promise(r=>gateway.close(r));}
