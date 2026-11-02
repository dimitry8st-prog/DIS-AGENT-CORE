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

function trusted(extra = {}) {
  return {
    ingress: { authenticated_source: true, end_user_authenticated: false },
    channel: 'telegram',
    project_id: 'proj_demo',
    bot_id: 'bot_a',
    source_id: 'telegram-demo-a',
    user_id: '1',
    dialogue_id: '1',
    external_event_id: '42',
    event_type: 'message',
    payload: {},
    ...extra,
  };
}

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

test('scoped IDs isolate bots; external id preserved; bigint precision kept', () => {
  const a = intake(trusted({ external_event_id: '0', user_id: '9007199254740993', dialogue_id: '9007199254740993' }));
  assert.equal(a.event_id, 'telegram|proj_demo|bot_a|0');
  assert.equal(a.external_event_id, '0');
  assert.equal(a.user_id, '9007199254740993');
  const b = intake(trusted({ bot_id: 'bot_b', external_event_id: '0' }));
  assert.notEqual(a.event_id, b.event_id);
  const d1 = intake(trusted({ dialogue_id: '10', external_event_id: '10:7', payload: { text: 'x' } }));
  const d2 = intake(trusted({ dialogue_id: '11', external_event_id: '11:7', payload: { text: 'x' } }));
  assert.notEqual(d1.event_id, d2.event_id);
  assert.notEqual(d1.dialogue_id, d2.dialogue_id);
  const first = intake(trusted({ external_event_id: 'same' }));
  const second = intake(trusted({ external_event_id: 'same' }));
  assert.notEqual(first.execution_id, second.execution_id);
  assert.notEqual(first.correlation_id, second.correlation_id);
  assert.equal(first.event_id, second.event_id);
});

test('reject untrusted bypass, malformed scope and unsafe ids', () => {
  assert.equal(intake({ update_id: 1, message: { from: { id: 1 } } }).valid, false);
  assert.equal(intake(trusted({ ingress: { authenticated_source: false } })).valid, false);
  assert.equal(intake(trusted({ project_id: 'bad id' })).valid, false);
  assert.equal(intake(trusted({ bot_id: 'x|y' })).valid, false);
  assert.equal(intake(trusted({ user_id: '9223372036854775808' })).valid, false);
  assert.equal(intake(trusted({ user_id: '1; DROP TABLE users' })).valid, false);
  assert.equal(intake(trusted({ user_id: {} })).valid, false);
  assert.equal(intake(trusted({ external_event_id: 'x'.repeat(161) })).valid, false);
  assert.equal(intake(trusted({ external_event_id: 'invalid id' })).valid, false);
});

test('drop arbitrary payload and PII; preserve intentional newline in routing text', () => {
  const j = intake(trusted({
    external_event_id: 'privacy',
    payload: { text: 'hello\nworld', password: 'secret', nested: { token: 'secret' }, email: 'private@example.com' },
  }));
  assert.deepEqual(j.payload, { text: 'hello\nworld' });
  assert(!('headers' in j));
  assert(!('event_key' in j));
  assert(!JSON.stringify(j).includes('secret'));
});

test('command and callback priority over context; unknown commands/callbacks stay safe', () => {
  const context = { state: 'awaiting_payment', status: 'active', expired: false };
  for (const [text, expected] of [['/start', 'auth'], ['/help', 'support'], ['/pay', 'payment'],
    ['/payment', 'payment'], ['/status', 'order_status'], ['/help@my_bot details', 'support']]) {
    assert.equal(route({ text }, { context }).route, expected);
  }
  for (const [callback_data, expected] of [['pay:1', 'payment'], ['approve:1', 'approval'], ['order:1', 'order']]) {
    assert.equal(route({ callback_data }, { context }).route, expected);
  }
  assert.equal(route({ text: '/unrecognized' }, { context }).route, 'unknown');
  assert.equal(route({ callback_data: 'unrecognized:1' }, { context }).route, 'unknown');
});

test('context priority, deterministic free text and classification marker without LLM calls', () => {
  for (const [state, expected] of [['awaiting_payment', 'payment'], ['awaiting_approval', 'approval'], ['awaiting_input', 'context_input']]) {
    assert.equal(route({ text: 'some text' }, { context: { state, status: 'active' } }).route, expected);
  }
  for (const [text, expected] of [['оплата', 'payment_support'], ['заказ', 'order'], ['помощь', 'support']]) {
    assert.equal(route({ text }).route, expected);
  }
  assert.deepEqual(route({ text: 'arbitrary free text' }), { route: 'ai_classification', reason: 'free text requires classifier', llm_required: true });
  assert.equal(route({}).route, 'unknown');
});

test('auth and context guards; expired state never routes by old state', () => {
  assert.equal(route({ text: '/pay' }, { auth: { allowed: false, registration_required: true } }).route, 'auth');
  assert.equal(route({ text: '/pay' }, { auth: { allowed: false, registration_required: false } }).reason, 'access_denied');
  assert.equal(route({ text: '/pay' }, { context: { processing_lock: true, stale: false } }).reason, 'context_busy');
  assert.equal(route({ text: '/pay' }, { context: { processing_lock: true, stale: true } }).reason, 'context_stale');
  assert.equal(route({ text: 'hello' }, { context: { state: 'awaiting_payment', status: 'active', expired: true } }).reason, 'context_expired');
  assert.equal(route({ text: '/help' }, { context: { state: 'expired', status: 'active', expired: true } }).route, 'support');
});

test('responses are allowlisted; no raw SQL errors, payload or context data', () => {
  const base = intake(trusted({ external_event_id: 'response', payload: { text: 'SECRET-MARKER' } }));
  const j = { ...base, ...allowed, routing: route({}), context: { ...allowed.context, payload: { token: 'SECRET-MARKER' } } };
  const result = run(0, 'Safe Response', j)[0].json;
  assert.equal(result.http_status, 200);
  assert.equal(result.body.routing.route, 'unknown');
  assert.equal(result.body.project_id, 'proj_demo');
  assert.equal(result.body.external_event_id, 'response');
  assert(!JSON.stringify(result).includes('SECRET-MARKER'));
  assert(!('payload' in result.body));
  const error = run(0, 'Safe Response', { ...j, error_code: 'database_unavailable', error: 'password=SECRET-MARKER' })[0].json;
  assert.equal(error.http_status, 503);
  assert.equal(error.body.error, 'core_processing_error');
  assert(!JSON.stringify(error).includes('SECRET-MARKER'));
});

test('duplicate/busy/failed reservations produce terminal responses', () => {
  const base = intake(trusted({ external_event_id: 'terminal' }));
  for (const [idempotency, status, http] of [[{ duplicate: true }, 'duplicate', 200],
    [{ busy: true }, 'busy', 409], [{ failed: true }, 'previous_failed', 409]]) {
    const result = run(0, 'Safe Response', { ...base, idempotency })[0].json;
    assert.equal(result.body.status, status);
    assert.equal(result.http_status, http);
  }
});

test('negative group dialogue ids and distinct scoped composites remain valid', () => {
  const group = intake(trusted({
    dialogue_id: '-100',
    external_event_id: '-100:7',
    user_id: '1',
  }));
  assert.equal(group.valid, true);
  assert.equal(group.event_id, 'telegram|proj_demo|bot_a|-100:7');
  const a = intake(trusted({ external_event_id: '1:9007199254740992', dialogue_id: '1' }));
  const b = intake(trusted({ external_event_id: '1:9007199254740993', dialogue_id: '1' }));
  assert.equal(a.valid, true);
  assert.equal(b.valid, true);
  assert.notEqual(a.event_id, b.event_id);
});

test('two projects for one user keep independent event namespaces', () => {
  const p1 = intake(trusted({ project_id: 'proj_a', external_event_id: 'shared', user_id: '55', dialogue_id: '55' }));
  const p2 = intake(trusted({ project_id: 'proj_b', external_event_id: 'shared', user_id: '55', dialogue_id: '55' }));
  assert.notEqual(p1.event_id, p2.event_id);
  assert.equal(p1.user_id, p2.user_id);
});
