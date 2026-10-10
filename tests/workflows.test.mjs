import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflows = fs.readdirSync(path.join(root, 'workflows')).sort()
  .map(f => JSON.parse(fs.readFileSync(path.join(root, 'workflows', f))));
const require = createRequire(import.meta.url);
const node = (index, name) => workflows[index].nodes.find(n => n.name === name);
function run(index, name, json, prior = {}) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(
    `(function(){${node(index, name).parameters.jsCode}})()`,
    { $json: json, $execution: { id: 'test-execution' }, require,
      $: name => ({ first: () => ({ json: prior[name] }) }) }, { timeout: 1000 })));
}
const allowed = { auth: { allowed: true, registration_required: false },
  context: { state: 'new', status: 'active', processing_lock: false, expired: false } };
const route = (payload, extra = {}) => run(4, 'Deterministic Router', { ...allowed, payload, ...extra })[0].json.routing;
function intake(body, headers = {}) {
  let value = run(0, 'Normalize Input', { body, headers })[0].json;
  value = run(0, 'Generate IDs', value)[0].json;
  return run(0, 'Sanitize Payload', value)[0].json;
}

test('all workflow JSON, Code syntax, links, passthrough and privacy settings', () => {
  assert.equal(workflows.length, 5);
  const ids = new Set(workflows.map(w => w.id));
  for (const w of workflows) {
    const names = new Set(w.nodes.map(n => n.name));
    assert.equal(names.size, w.nodes.length);
    assert.equal(new Set(w.nodes.map(n => n.id)).size, w.nodes.length);
    assert.equal(w.settings.saveDataErrorExecution, 'none');
    assert.equal(w.settings.saveDataSuccessExecution, 'none');
    assert.equal(w.settings.saveExecutionProgress, false);
    assert.equal(w.settings.saveManualExecutions, false);
    for (const [source, connections] of Object.entries(w.connections)) {
      assert(names.has(source));
      for (const branch of connections.main) for (const c of branch) assert(names.has(c.node));
    }
    for (const n of w.nodes) {
      if (n.parameters.jsCode) new Function(n.parameters.jsCode);
      if (n.type.endsWith('.webhook')) assert.match(n.webhookId, /^[a-f0-9-]{36}$/);
      if (n.type.endsWith('.executeWorkflow')) {
        assert(ids.has(n.parameters.workflowId.value));
        assert.equal(n.parameters.options.waitForSubWorkflow, true);
        assert.equal(n.onError, 'continueErrorOutput');
      }
      if (n.type.endsWith('.executeWorkflowTrigger')) assert.equal(n.parameters.inputSource, 'passthrough');
      if (n.type.endsWith('.postgres')) {
        assert.match(n.parameters.query, /\$1::jsonb/);
        assert.equal(n.parameters.options.queryReplacement, '={{ [JSON.stringify($json)] }}');
      }
    }
  }
  assert.equal(workflows[0].connections['Reservation Acquired'].main[1][0].node, 'Safe Response');
});

test('stable IDs include Telegram zero update and chat scope; bigint precision is preserved', () => {
  assert.equal(intake({update_id: 0, message: {from: {id: '9007199254740993'}, text: '/start'}}).event_id, 'tg_0');
  const a = intake({message: {from: {id: 1}, chat: {id: 10}, message_id: 7}});
  const b = intake({message: {from: {id: 1}, chat: {id: 11}, message_id: 7}});
  assert.notEqual(a.event_id, b.event_id);
  assert.equal(a.user_id, '1');
  assert.equal(intake({event_id: 'precision', user_id: '9007199254740993'}).user_id, '9007199254740993');
  assert.equal(intake({user_id: '1'}, {'idempotency-key': 'header-id'}).event_id, 'webhook_header-id');
  const first = intake({event_id:'same'});
  const second = intake({event_id:'same'});
  assert.notEqual(first.execution_id,second.execution_id);
  assert.notEqual(first.correlation_id,second.correlation_id);
});

test('reject unstable/malformed IDs, unsafe numbers and oversized bigint', () => {
  for (const p of [[], null, {}, {event_id:'invalid id'}, {event_id:'x',user_id:9007199254740992},
    {event_id:'x',user_id:'9223372036854775808'}, {event_id:'x',user_id:'1; DROP TABLE users'},
    {event_id:'x',user_id:{}}, {event_id:'x'.repeat(161)}]) {
    assert.equal(intake(p).valid, false);
  }
});

test('drop all headers, arbitrary payload and PII; preserve intentional newline in routing text', () => {
  const j = intake({event_id:'privacy',user_id:'1',text:'hello\nworld',password:'secret',
    nested:{token:'secret'},email:'private@example.com'}, {authorization:'secret'});
  assert.deepEqual(j.payload, {text:'hello\nworld'});
  assert(!('headers' in j));
  assert(!('event_key' in j));
  assert(!JSON.stringify(j).includes('secret'));
});

test('command and callback priority over context; unknown commands/callbacks stay safe', () => {
  const context = {state:'awaiting_payment',status:'active',expired:false};
  for (const [text, expected] of [['/start','auth'],['/help','support'],['/pay','payment'],
    ['/payment','payment'],['/status','order_status'],['/help@my_bot details','support']]) {
    assert.equal(route({text},{context}).route, expected);
  }
  for (const [callback_data, expected] of [['pay:1','payment'],['approve:1','approval'],['order:1','order']]) {
    assert.equal(route({callback_data},{context}).route, expected);
  }
  assert.equal(route({text:'/unrecognized'},{context}).route,'unknown');
  assert.equal(route({callback_data:'unrecognized:1'},{context}).route,'unknown');
});

test('context priority, deterministic free text and classification marker without LLM calls', () => {
  for (const [state, expected] of [['awaiting_payment','payment'],['awaiting_approval','approval'],['awaiting_input','context_input']]) {
    assert.equal(route({text:'some text'}, {context:{state,status:'active'}}).route, expected);
  }
  for (const [text, expected] of [['оплата','payment_support'],['заказ','order'],['помощь','support']]) {
    assert.equal(route({text}).route, expected);
  }
  assert.deepEqual(route({text:'arbitrary free text'}), {route:'ai_classification',reason:'free text requires classifier',llm_required:true});
  assert.equal(route({}).route,'unknown');
});

test('auth and context guards; expired state never routes by old state', () => {
  assert.equal(route({text:'/pay'}, {auth:{allowed:false,registration_required:true}}).route,'auth');
  assert.equal(route({text:'/pay'}, {auth:{allowed:false,registration_required:false}}).reason,'access_denied');
  assert.equal(route({text:'/pay'}, {context:{processing_lock:true,stale:false}}).reason,'context_busy');
  assert.equal(route({text:'/pay'}, {context:{processing_lock:true,stale:true}}).reason,'context_stale');
  assert.equal(route({text:'hello'}, {context:{state:'awaiting_payment',status:'active',expired:true}}).reason,'context_expired');
  assert.equal(route({text:'/help'}, {context:{state:'expired',status:'active',expired:true}}).route,'support');
});

test('responses are allowlisted; no raw SQL errors, payload or context data', () => {
  const base = intake({event_id:'response',user_id:'1',text:'SECRET-MARKER'});
  const j = {...base,...allowed,routing:route({}),context:{...allowed.context,payload:{token:'SECRET-MARKER'}}};
  const result = run(0,'Safe Response',j)[0].json;
  assert.equal(result.http_status,200);
  assert.equal(result.body.routing.route,'unknown');
  assert(!JSON.stringify(result).includes('SECRET-MARKER'));
  assert(!('payload' in result.body));
  const error = run(0,'Safe Response',{...j,error_code:'database_unavailable',error:'password=SECRET-MARKER'})[0].json;
  assert.equal(error.http_status,503);
  assert.equal(error.body.error,'core_processing_error');
  assert(!JSON.stringify(error).includes('SECRET-MARKER'));
});

test('duplicate/busy/failed reservations produce terminal responses', () => {
  const base = intake({event_id:'terminal'});
  for (const [idempotency, status, http] of [[{duplicate:true},'duplicate',200],
    [{busy:true},'busy',409],[{failed:true},'previous_failed',409]]) {
    const result = run(0,'Safe Response',{...base,idempotency})[0].json;
    assert.equal(result.body.status,status);
    assert.equal(result.http_status,http);
  }
});
