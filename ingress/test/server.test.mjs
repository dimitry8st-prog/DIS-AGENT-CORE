import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from '../src/server.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import http from 'node:http';

const SECRET_A = 'telegram-bot-a-webhook-secret-xx';
const SECRET_B = 'telegram-bot-b-webhook-secret-yy';
const API_SECRET = 'api-service-hmac-secret-zzzzzz';

function setupConfig(upstreamUrl) {
  process.env.DIS_GATEWAY_HMAC_KEY='isolated-test-proof-key-not-real-secret';
  process.env.TELEGRAM_BOT_A_WEBHOOK_SECRET = SECRET_A;
  process.env.TELEGRAM_BOT_B_WEBHOOK_SECRET = SECRET_B;
  process.env.API_SERVICE_HMAC_SECRET = API_SECRET;
  const dir = mkdtempSync(join(tmpdir(), 'dis-ingress-'));
  const path = join(dir, 'sources.json');
  writeFileSync(path, JSON.stringify({
    bind: '127.0.0.1',
    port: 0,
    max_body_bytes: 4096,
    upstream_timeout_ms: 2000,
    rate_limit: { window_ms: 60000, max: 1000 },
    n8n_upstream_url: upstreamUrl,
    sources: [
      {
        id: 'telegram-demo-a',
        channel: 'telegram',
        project_id: 'proj_demo',
        bot_id: 'bot_a',
        path: '/ingress/telegram/bot_a',
        secret_env: 'TELEGRAM_BOT_A_WEBHOOK_SECRET',
      },
      {
        id: 'telegram-demo-b',
        channel: 'telegram',
        project_id: 'proj_demo',
        bot_id: 'bot_b',
        path: '/ingress/telegram/bot_b',
        secret_env: 'TELEGRAM_BOT_B_WEBHOOK_SECRET',
      },
      {
        id: 'api-demo',
        channel: 'api',
        project_id: 'proj_demo',
        bot_id: 'api_main',
        path: '/ingress/api/service',
        auth: 'hmac-sha256',
        secret_env: 'API_SERVICE_HMAC_SECRET',
        may_assert_user_id: true,
      },
    ],
  }));
  process.env.DIS_INGRESS_CONFIG = path;
  return loadConfig(path);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function post(port, path, body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

test('valid telegram source reaches upstream with scoped trusted contract; secrets stripped', async () => {
  let captured;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured = {
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'completed' }));
    });
  });
  const upPort = await listen(upstream);
  const config = setupConfig(`http://127.0.0.1:${upPort}/webhook/dis-agent-core`);
  const gateway = createServer(config);
  const port = await listen(gateway);
  try {
    const result = await post(port, '/ingress/telegram/bot_a', {
      update_id: 42,
      message: { from: { id: 7 }, chat: { id: 7 }, text: 'SECRET-MARKER hello' },
    }, { 'x-telegram-bot-api-secret-token': SECRET_A });
    assert.equal(result.status, 200);
    assert.equal(captured.body.event_id, 'telegram|proj_demo|bot_a|42');
    assert.equal(captured.body.external_event_id, '42');
    assert.equal(captured.body.project_id, 'proj_demo');
    assert.equal(captured.body.bot_id, 'bot_a');
    assert.equal(captured.body.ingress.authenticated_source, true);
    assert.equal(captured.body.ingress.end_user_authenticated, false);
    assert.equal(captured.headers['x-telegram-bot-api-secret-token'], undefined);
    assert.equal(captured.headers['x-dis-signature'], undefined);
  } finally {
    gateway.close();
    upstream.close();
  }
});

test('missing, wrong and foreign telegram credentials are rejected before upstream', async () => {
  let hit = 0;
  const upstream = http.createServer((_req, res) => {
    hit += 1;
    res.end('{}');
  });
  const upPort = await listen(upstream);
  const config = setupConfig(`http://127.0.0.1:${upPort}/webhook/dis-agent-core`);
  const gateway = createServer(config);
  const port = await listen(gateway);
  const update = { update_id: 1, message: { from: { id: 1 }, chat: { id: 1 }, text: 'x' } };
  try {
    assert.equal((await post(port, '/ingress/telegram/bot_a', update)).status, 401);
    assert.equal((await post(port, '/ingress/telegram/bot_a', update, {
      'x-telegram-bot-api-secret-token': 'wrong-secret-value!!',
    })).status, 401);
    // Bot B secret on Bot A path = foreign credential
    assert.equal((await post(port, '/ingress/telegram/bot_a', update, {
      'x-telegram-bot-api-secret-token': SECRET_B,
    })).status, 401);
    assert.equal(hit, 0);
  } finally {
    gateway.close();
    upstream.close();
  }
});

test('client project_id/bot_id/channel spoofing is rejected', async () => {
  let hit = 0;
  const upstream = http.createServer((_req, res) => { hit += 1; res.end('{}'); });
  const upPort = await listen(upstream);
  const config = setupConfig(`http://127.0.0.1:${upPort}/webhook/dis-agent-core`);
  const gateway = createServer(config);
  const port = await listen(gateway);
  try {
    const result = await post(port, '/ingress/telegram/bot_a', {
      update_id: 9,
      project_id: 'other_project',
      bot_id: 'bot_a',
      message: { from: { id: 1 }, chat: { id: 1 }, text: 'x' },
    }, { 'x-telegram-bot-api-secret-token': SECRET_A });
    assert.equal(result.status, 403);
    assert.equal(result.json.error, 'scope_mismatch');
    assert.equal(hit, 0);
  } finally {
    gateway.close();
    upstream.close();
  }
});

test('same update_id from two bots produces independent scoped events', async () => {
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upPort = await listen(upstream);
  const config = setupConfig(`http://127.0.0.1:${upPort}/webhook/dis-agent-core`);
  const gateway = createServer(config);
  const port = await listen(gateway);
  const update = { update_id: 42, message: { from: { id: 1 }, chat: { id: 1 }, text: 'x' } };
  try {
    await post(port, '/ingress/telegram/bot_a', update, { 'x-telegram-bot-api-secret-token': SECRET_A });
    await post(port, '/ingress/telegram/bot_b', update, { 'x-telegram-bot-api-secret-token': SECRET_B });
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0].event_id, bodies[1].event_id);
    assert.equal(bodies[0].external_event_id, '42');
    assert.equal(bodies[1].external_event_id, '42');
  } finally {
    gateway.close();
    upstream.close();
  }
});

test('API HMAC service auth may assert user_id; wrong signature rejected', async () => {
  let captured;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upPort = await listen(upstream);
  const config = setupConfig(`http://127.0.0.1:${upPort}/webhook/dis-agent-core`);
  const gateway = createServer(config);
  const port = await listen(gateway);
  const body = {
    user_id: '99',
    dialogue_id: '99',
    external_event_id: 'evt-1',
    payload: { text: '/help' },
  };
  const raw = JSON.stringify(body);
  try {
    const bad = await post(port, '/ingress/api/service', raw, { 'x-dis-signature': 'sha256=00' });
    assert.equal(bad.status, 401);
    const sig = 'sha256=' + createHmac('sha256', API_SECRET).update(raw).digest('hex');
    const ok = await post(port, '/ingress/api/service', raw, { 'x-dis-signature': sig });
    assert.equal(ok.status, 200);
    assert.equal(captured.event_id, 'api|proj_demo|api_main|evt-1');
    assert.equal(captured.ingress.end_user_authenticated, false);
  } finally {
    gateway.close();
    upstream.close();
  }
});

test('refuses to load config without sources or with non-loopback upstream', async () => {
  process.env.TELEGRAM_BOT_A_WEBHOOK_SECRET = SECRET_A;
  const dir = mkdtempSync(join(tmpdir(), 'dis-ingress-'));
  const badUp = join(dir, 'bad-up.json');
  writeFileSync(badUp, JSON.stringify({
    n8n_upstream_url: 'http://10.0.0.5:5678/webhook/x',
    sources: [{
      id: 'x', channel: 'telegram', project_id: 'p', bot_id: 'b',
      path: '/ingress/telegram/b', secret_env: 'TELEGRAM_BOT_A_WEBHOOK_SECRET',
    }],
  }));
  assert.throws(() => loadConfig(badUp), /loopback/);
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, JSON.stringify({ n8n_upstream_url: 'http://127.0.0.1:5678/webhook/x', sources: [] }));
  assert.throws(() => loadConfig(empty), /non-empty/);
});

test('oversized body rejected before upstream; response never echoes credentials', async () => {
  let hit = 0;
  const upstream = http.createServer((_req, res) => { hit += 1; res.end('{}'); });
  const upPort = await listen(upstream);
  const config = setupConfig(`http://127.0.0.1:${upPort}/webhook/dis-agent-core`);
  config.max_body_bytes = 64;
  const gateway = createServer(config);
  const port = await listen(gateway);
  try {
    const huge = {
      update_id: 1,
      message: { from: { id: 1 }, chat: { id: 1 }, text: 'x'.repeat(200) },
    };
    const result = await post(port, '/ingress/telegram/bot_a', huge, {
      'x-telegram-bot-api-secret-token': SECRET_A,
    });
    assert.equal(result.status, 413);
    assert.equal(result.json.error, 'payload_too_large');
    assert.equal(hit, 0);
    assert(!JSON.stringify(result).includes(SECRET_A));
  } finally {
    gateway.close();
    upstream.close();
  }
});
