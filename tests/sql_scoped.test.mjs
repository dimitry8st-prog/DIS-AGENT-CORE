/**
 * PostgreSQL integration for scoped ingress (migrations 001–003).
 * Requires DIS_TEST_DATABASE_URL, e.g. postgres://dis:dis@127.0.0.1:55432/dis_core_test
 * Marks BLOCKED (skip) when URL is absent — does not mock E2E.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DIS_TEST_DATABASE_URL || '';
const docker = process.env.DIS_TEST_PSQL_DOCKER || '';
const hasDb = Boolean(url || docker);

function psql(sqlText) {
  const r = docker
    ? spawnSync('docker', ['exec', '-i', docker, 'psql', '-U', 'dis', '-d', 'dis_core_test', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sqlText], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
    : spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sqlText], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || 'psql failed');
  }
  // Take first non-empty data line; ignore INSERT/UPDATE tags if present.
  const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !/^(INSERT|UPDATE|DELETE|SELECT)\b/i.test(s));
  return line ?? '';
}

function applyMigrations() {
  for (const file of ['001_core.sql', '002_core_processing.sql', '003_scoped_ingress.sql']) {
    const hostPath = path.join(root, 'db', file);
    let r;
    if (docker) {
      const dest = `/tmp/${file}`;
      const cp = spawnSync('docker', ['cp', hostPath, `${docker}:${dest}`], { encoding: 'utf8' });
      if (cp.status !== 0) throw new Error(`docker cp ${file}: ${cp.stderr}`);
      r = spawnSync('docker', ['exec', docker, 'psql', '-U', 'dis', '-d', 'dis_core_test', '-v', 'ON_ERROR_STOP=1', '-f', dest], {
        encoding: 'utf8',
      });
    } else {
      r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', hostPath], {
        encoding: 'utf8',
      });
    }
    if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
  }
}

function call(fn, payload, extra = '') {
  const lit = "'" + JSON.stringify(payload).replaceAll("'", "''") + "'::jsonb";
  return JSON.parse(psql(`SELECT ${fn}(${lit}${extra});`));
}

test('postgres scoped integration available or BLOCKED', { skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset' }, () => {
  assert.ok(docker || url.startsWith('postgres'));
});

test('migrations apply twice; legacy dry-run; cross-bot independence; context isolation', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, () => {
  applyMigrations();
  applyMigrations();

  const dry = JSON.parse(psql('SELECT dis_core_legacy_event_scope_dry_run();'));
  assert.equal(dry.auto_assign, false);

  const ext = randomUUID().slice(0, 8);
  const base = {
    correlation_id: 'COR-' + randomUUID(),
    source: 'telegram',
    event_type: 'message',
    execution_id: randomUUID(),
    channel: 'telegram',
    project_id: 'proj_demo',
    bot_id: 'bot_a',
    external_event_id: ext,
    source_id: 'telegram-demo-a',
    user_id: null,
    dialogue_id: '7',
  };
  const a = call('dis_core_reserve', { ...base, event_id: `telegram|proj_demo|bot_a|${ext}` });
  assert.equal(a.idempotency.acquired, true);
  const b = call('dis_core_reserve', {
    ...base,
    bot_id: 'bot_b',
    event_id: `telegram|proj_demo|bot_b|${ext}`,
    execution_id: randomUUID(),
  });
  assert.equal(b.idempotency.acquired, true);

  const dup = call('dis_core_reserve', {
    ...base,
    event_id: `telegram|proj_demo|bot_a|${ext}`,
    execution_id: randomUUID(),
  });
  assert.equal(dup.idempotency.busy, true);

  // Concurrent-ish second finish owner fencing
  assert.equal(call('dis_core_finish', { ...a, execution_id: 'intruder' }).persistence.recorded, false);
  assert.equal(call('dis_core_finish', a).persistence.recorded, true);
  const again = call('dis_core_reserve', { ...a, execution_id: randomUUID() });
  assert.equal(again.idempotency.duplicate, true);

  // Two dialogues / projects for same user: independent locks
  const tg = String(BigInt('5' + Date.now().toString().slice(-12)));
  const user = psql(`INSERT INTO users(telegram_id) VALUES (${tg}) RETURNING id;`);
  assert.match(user, /^[0-9a-f-]{36}$/i);
  psql(`INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,state)
    VALUES('proj_a','bot_a','telegram','d1','${user}','awaiting_input'),
          ('proj_b','bot_a','telegram','d2','${user}','awaiting_payment');`);

  const c1 = {
    ...base,
    event_id: 'telegram|proj_a|bot_a|c1',
    project_id: 'proj_a',
    bot_id: 'bot_a',
    external_event_id: 'c1',
    dialogue_id: 'd1',
    execution_id: randomUUID(),
    auth: { allowed: true, user: { id: user } },
  };
  call('dis_core_reserve', c1);
  const locked = call('dis_core_context', c1);
  assert.equal(locked.context.lock_acquired, true);

  const c2 = {
    ...c1,
    event_id: 'telegram|proj_b|bot_a|c2',
    project_id: 'proj_b',
    external_event_id: 'c2',
    dialogue_id: 'd2',
    execution_id: randomUUID(),
  };
  call('dis_core_reserve', c2);
  const other = call('dis_core_context', c2);
  assert.equal(other.context.lock_acquired, true);
  assert.equal(other.context.state, 'awaiting_payment');

  // Missing scope rejected before side effects
  const rejected = call('dis_core_reserve', {
    event_id: 'no-scope',
    correlation_id: 'COR-x',
    source: 'telegram',
    execution_id: 'x',
  });
  assert.equal(rejected.idempotency.rejected, true);

  // Legacy event without scope: map explicitly, apply does not change status/event_id
  const legacyId = 'tg_legacy_' + randomUUID().slice(0, 8);
  psql(`INSERT INTO processed_events(event_id,source,status,correlation_id)
    VALUES('${legacyId}','telegram','completed','COR-legacy');`);
  const before = psql(`SELECT status FROM processed_events WHERE event_id='${legacyId}';`);
  assert.equal(before, 'completed');
  psql(`INSERT INTO legacy_event_scope_map(event_id,channel,project_id,bot_id,external_event_id,confirmed_by)
    VALUES('${legacyId}','telegram','proj_legacy','bot_legacy','99','operator-test');`);
  const applied = JSON.parse(psql('SELECT dis_core_legacy_event_scope_apply();'));
  assert.ok(applied.updated >= 1);
  assert.equal(applied.event_ids_preserved, true);
  assert.equal(psql(`SELECT status FROM processed_events WHERE event_id='${legacyId}';`), 'completed');
  assert.equal(psql(`SELECT project_id FROM processed_events WHERE event_id='${legacyId}';`), 'proj_legacy');
  // Remap must not reopen for processing
  const reopen = call('dis_core_reserve', {
    event_id: legacyId,
    correlation_id: 'COR-new',
    source: 'telegram',
    execution_id: randomUUID(),
    channel: 'telegram',
    project_id: 'proj_legacy',
    bot_id: 'bot_legacy',
    external_event_id: '99',
  });
  assert.equal(reopen.idempotency.duplicate, true);
});
