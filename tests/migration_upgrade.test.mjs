import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const container=process.env.DIS_TEST_PSQL_DOCKER;
const url=process.env.DIS_TEST_DATABASE_URL;
const hasDb=Boolean(container||url);
function sql(db,text){
 const target=url ? new URL(url) : null; if(target) target.pathname='/'+db;
 const args=container ? ['exec','-i',container,'psql','-U','dis','-d',db,'-v','ON_ERROR_STOP=1','-At'] : [target.toString(),'-v','ON_ERROR_STOP=1','-At'];
 const r=spawnSync(container?'docker':'psql',args,{input:text,encoding:'utf8'});
 if(r.status!==0)throw new Error(r.stderr); return r.stdout.trim();
}
function content(name){return readFileSync(new URL('../db/'+name,import.meta.url),'utf8');}
function call(db,p){return JSON.parse(sql(db,"SELECT dis_core_reserve('"+JSON.stringify(p).replaceAll("'","''")+"'::jsonb);"));}
for(const baseline of ['fresh','2c8b750','91be882'])test(`upgrade ${baseline}: 004 twice preserves all legacy statuses, IDs, correlations`,{skip:!hasDb&&'BLOCKED: isolated PostgreSQL required'},()=>{
 const db='upgrade_'+randomUUID().replaceAll('-',''); sql('dis_core_test',`CREATE DATABASE ${db};`);
 sql(db,content('001_core.sql'));sql(db,content('002_core_processing.sql'));
 const old=baseline==='fresh'?content('003_scoped_ingress.sql'):spawnSync('git',['show',baseline+':db/003_scoped_ingress.sql'],{encoding:'utf8'}).stdout;
 assert(old.includes('dis_core_reserve')); sql(db,old);
 for(const state of ['completed','processing','failed']){
  sql(db,`INSERT INTO processed_events(event_id,source,status,correlation_id) VALUES('tg_${state}','telegram','${state}','COR-${state}');
  INSERT INTO legacy_event_scope_map(event_id,channel,project_id,bot_id,external_event_id,confirmed_by) VALUES('tg_${state}','telegram','p','b','${state}','test');`);
 }
 sql(db,'SELECT dis_core_legacy_event_scope_apply();');
 sql(db,content('004_review_fixes.sql'));sql(db,content('004_review_fixes.sql'));
 for(const state of ['completed','processing','failed']){
  const p={event_id:`telegram|p|b|${state}`,source:'telegram',channel:'telegram',project_id:'p',bot_id:'b',external_event_id:state,correlation_id:'new',execution_id:randomUUID()};
  const x=call(db,p);assert.equal(x.idempotency.acquired,false); assert.equal(x.idempotency[{completed:'duplicate',processing:'busy',failed:'failed'}[state]],true);
  assert.equal(x.correlation_id,'COR-'+state);assert.equal(x.idempotency.existing_event_id,'tg_'+state);
 }
 assert.equal(sql(db,'SELECT count(*) FROM processed_events;'),'3');
});
test('004 refuses conflicting historical data atomically without picking/deleting a row',{skip:!hasDb&&'BLOCKED: isolated PostgreSQL required'},()=>{
 const db='conflict_'+randomUUID().replaceAll('-','');sql('dis_core_test',`CREATE DATABASE ${db};`);
 sql(db,content('001_core.sql'));sql(db,content('002_core_processing.sql'));
 sql(db,spawnSync('git',['show','2c8b750:db/003_scoped_ingress.sql'],{encoding:'utf8'}).stdout);
 sql(db,`INSERT INTO processed_events(event_id,source,status,correlation_id,channel,project_id,bot_id,external_event_id) VALUES ('old1','telegram','completed','COR1','telegram','p','b','x'),('old2','telegram','failed','COR2','telegram','p','b','x');`);
 assert.throws(()=>sql(db,content('004_review_fixes.sql')),/scope_identity_conflict/);
 assert.equal(sql(db,'SELECT count(*) FROM processed_events;'),'2');
 assert.equal(sql(db,"SELECT string_agg(status,',' ORDER BY event_id) FROM processed_events;"),'completed,failed');
});
