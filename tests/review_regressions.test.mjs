import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import http from 'node:http';
import {createServer} from '../ingress/src/server.mjs';
import {signInternal} from '../ingress/src/internal-proof.mjs';

const require=createRequire(import.meta.url);
const wf=JSON.parse(readFileSync(new URL('../workflows/WF-00_SYS_Event_Intake.json',import.meta.url)));
const router=JSON.parse(readFileSync(new URL('../workflows/WF-04_CORE_Router.json',import.meta.url)));
const key='isolated-review-proof-key-not-a-real-secret';
function run(w,name,json){return JSON.parse(JSON.stringify(vm.runInNewContext(
  `(function(){${w.nodes.find(n=>n.name===name).parameters.jsCode}})()`,
  {$json:json,$execution:{id:'review'},require,Buffer,$env:{DIS_GATEWAY_HMAC_KEY:key}}, {timeout:1000})))[0].json;}
const body={channel:'telegram',project_id:'proj_demo',bot_id:'bot_a',source_id:'demo',user_id:'1',dialogue_id:'1',external_event_id:'42',payload:{text:'/help'},ingress:{authenticated_source:true}};

test('review: rejected SQL context cannot route support or return completed',()=>{
  const j={...body,valid:true,event_id:'review',auth:{allowed:true},context:{exists:true,state:'new',status:'active',rejected:true,reason:'user_scope_mismatch',processing_lock:false,payload:{secret:'foreign-context-marker'}}};
  const routed=run(router,'Deterministic Router',j);
  assert.equal(routed.routing.route,'unknown');
  const response=run(wf,'Safe Response',routed);
  assert.equal(response.http_status,403);
  assert.equal(response.body.status,'rejected');
  assert(!JSON.stringify(response).includes('foreign-context-marker'));
});

test('review: fabricated authenticated_source without proof cannot enter WF-00',()=>{
  const node=wf.nodes.find(n=>n.name==='Verify Ingress Proof');
  const envelope=node?run(wf,node.name,{body,headers:{}}):{body,headers:{}};
  const normalized=run(wf,'Normalize Input',envelope);
  assert.equal(normalized.valid,false);
});

test('review: real Code verifier authenticates full contract and replay; rejects tampering/expiry/missing key',()=>{
  function verify(b,h,env={DIS_GATEWAY_HMAC_KEY:key}){
    const code=wf.nodes.find(n=>n.name==='Verify Ingress Proof').parameters.jsCode;
    return vm.runInNewContext(`(function(){${code}})()`,{$json:{body:b,headers:h},$env:env,require,Buffer})[0].json;
  }
  const headers=signInternal(body,key);
  assert.equal(verify(body,headers).ingress_verified,true);
  assert.equal(verify(Object.fromEntries(Object.entries(body).reverse()),headers).ingress_verified,true);
  assert.equal(verify(body,headers).ingress_verified,true);
  for(const f of ['project_id','bot_id','user_id','dialogue_id','external_event_id','source_id','channel']){
    const result=verify({...body,[f]:'tampered'},headers);
    assert.equal(result.ingress_verified,false,f);
    assert(!JSON.stringify(result).includes(key));
  }
  assert.equal(verify({...body,payload:{text:'/pay'}},headers).ingress_verified,false);
  assert.equal(verify(body,signInternal(body,'wrong-proof-key-with-at-least-32-bytes')).ingress_verified,false);
  assert.equal(verify(body,headers,{}).ingress_verified,false);
  assert.equal(verify(body,signInternal(body,key,String(Math.floor(Date.now()/1000)-301))).ingress_verified,false);
  assert.equal(verify(body,signInternal(body,key,String(Math.floor(Date.now()/1000)+60))).ingress_verified,false);
  assert.equal(wf.connections.Webhook.main[0][0].node,'Verify Ingress Proof');
  assert.equal(wf.connections['Verify Ingress Proof'].main[0][0].node,'Normalize Input');
});

test('review: internal key is mandatory, strong and separate from external credentials',()=>{
  const config={sources:new Map([['/ingress/api/test',{secret:key}]])};
  for(const candidate of [undefined,'short',key])assert.throws(()=>createServer({...config,internal_proof_secret:candidate}),/internal/);
});

test('review: unsafe HTTP numeric Telegram user id rejected before rounding to string',async()=>{
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end('{}');});});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const gateway=createServer({n8n_upstream_url:`http://127.0.0.1:${upstream.address().port}/`,internal_proof_secret:key,max_body_bytes:4096,upstream_timeout_ms:2000,rate_limit:{window_ms:60000,max:100},sources:new Map([['/ingress/telegram/a',{id:'demo',channel:'telegram',project_id:'proj_demo',bot_id:'bot_a',secret:'telegram-test-only'}]])});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
  try{
    const response=await fetch(`http://127.0.0.1:${gateway.address().port}/ingress/telegram/a`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'telegram-test-only'},body:'{"update_id":0,"message":{"from":{"id":9007199254740993},"chat":{"id":-100},"text":"/help"}}'});
    assert.equal(response.status,400);
  }finally{await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>upstream.close(r))]);}
});
