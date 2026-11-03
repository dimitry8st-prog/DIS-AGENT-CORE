/**
 * PostgreSQL integration for scoped ingress (migrations 001–003).
 * Requires DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER.
 * Marks BLOCKED (skip) when absent — does not mock E2E / does not stop shared Postgres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
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
  const line = r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !/^(INSERT|UPDATE|DELETE|SELECT)\b/i.test(s));
  return line ?? '';
}

function psqlAsync(sqlText) {
  return new Promise((resolve, reject) => {
    const cmd = docker ? 'docker' : 'psql';
    const args = docker
      ? ['exec', '-i', docker, 'psql', '-U', 'dis', '-d', 'dis_core_test', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sqlText]
      : [url, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sqlText];
    const child = spawn(cmd, args, { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || 'psql failed'));
      const line = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !/^(INSERT|UPDATE|DELETE|SELECT)\b/i.test(s));
      resolve(line ?? '');
    });
  });
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
      r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', hostPath], { encoding: 'utf8' });
    }
    if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
  }
}

function call(fn, payload, extra = '') {
  const lit = "'" + JSON.stringify(payload).replaceAll("'", "''") + "'::jsonb";
  return JSON.parse(psql(`SELECT ${fn}(${lit}${extra});`));
}

function scopedContract(extra = {}) {
  const channel = extra.channel || 'telegram';
  const project_id = extra.project_id || 'proj_demo';
  const bot_id = extra.bot_id || 'bot_a';
  const external_event_id = extra.external_event_id || randomUUID().slice(0, 12);
  const event_id = extra.event_id || `${channel}|${project_id}|${bot_id}|${external_event_id}`;
  return {
    correlation_id: 'COR-' + randomUUID(),
    source: channel,
    event_type: 'message',
    execution_id: randomUUID(),
    source_id: 'telegram-demo-a',
    user_id: null,
    dialogue_id: '7',
    payload: { token: 'SQL-SECRET-MARKER' },
    ...extra,
    channel,
    project_id,
    bot_id,
    external_event_id,
    event_id,
  };
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

  const a = call('dis_core_reserve', scopedContract());
  assert.equal(a.idempotency.acquired, true);
  const ext = a.external_event_id;
  const b = call('dis_core_reserve', scopedContract({
    bot_id: 'bot_b',
    external_event_id: ext,
  }));
  assert.equal(b.idempotency.acquired, true);

  const dup = call('dis_core_reserve', scopedContract({ external_event_id: ext }));
  assert.equal(dup.idempotency.busy, true);

  assert.equal(call('dis_core_finish', { ...a, execution_id: 'intruder' }).persistence.recorded, false);
  assert.equal(call('dis_core_finish', a).persistence.recorded, true);
  assert.equal(call('dis_core_reserve', { ...a, execution_id: randomUUID() }).idempotency.duplicate, true);

  const tg = String(BigInt('5' + Date.now().toString().slice(-12)));
  const user = psql(`INSERT INTO users(telegram_id) VALUES (${tg}) RETURNING id;`);
  assert.match(user, /^[0-9a-f-]{36}$/i);
  const d1 = 'd1-' + randomUUID().slice(0, 8);
  const d2 = 'd2-' + randomUUID().slice(0, 8);
  psql(`INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,state)
    VALUES('proj_a','bot_a','telegram','${d1}','${user}','awaiting_input'),
          ('proj_b','bot_a','telegram','${d2}','${user}','awaiting_payment');`);

  const c1 = scopedContract({
    project_id: 'proj_a',
    dialogue_id: d1,
    auth: { allowed: true, user: { id: user } },
  });
  call('dis_core_reserve', c1);
  assert.equal(call('dis_core_context', c1).context.lock_acquired, true);

  const c2 = scopedContract({
    project_id: 'proj_b',
    dialogue_id: d2,
    auth: { allowed: true, user: { id: user } },
  });
  call('dis_core_reserve', c2);
  const other = call('dis_core_context', c2);
  assert.equal(other.context.lock_acquired, true);
  assert.equal(other.context.state, 'awaiting_payment');

  assert.equal(call('dis_core_reserve', {
    event_id: 'no-scope', correlation_id: 'COR-x', source: 'telegram', execution_id: 'x',
  }).idempotency.rejected, true);

  const legacyId = 'tg_legacy_' + randomUUID().slice(0, 8);
  const legacyExt = '99-' + randomUUID().slice(0, 8);
  const legacyCorr = 'COR-legacy-' + randomUUID().slice(0, 8);
  psql(`INSERT INTO processed_events(event_id,source,status,correlation_id)
    VALUES('${legacyId}','telegram','completed','${legacyCorr}');`);
  psql(`INSERT INTO legacy_event_scope_map(event_id,channel,project_id,bot_id,external_event_id,confirmed_by)
    VALUES('${legacyId}','telegram','proj_legacy','bot_legacy','${legacyExt}','operator-test');`);
  const applied = JSON.parse(psql('SELECT dis_core_legacy_event_scope_apply();'));
  assert.ok(applied.updated >= 1);
  assert.equal(applied.event_ids_preserved, true);
  assert.equal(psql(`SELECT status FROM processed_events WHERE event_id='${legacyId}';`), 'completed');
  assert.equal(call('dis_core_reserve', scopedContract({
    event_id: legacyId,
    project_id: 'proj_legacy',
    bot_id: 'bot_legacy',
    external_event_id: legacyExt,
  })).idempotency.duplicate, true);

  // New WF-00 composite key must collide with confirmed legacy scope (not only old event_id).
  const compositeId = `telegram|proj_legacy|bot_legacy|${legacyExt}`;
  const afterMigrate = call('dis_core_reserve', scopedContract({
    event_id: compositeId,
    project_id: 'proj_legacy',
    bot_id: 'bot_legacy',
    external_event_id: legacyExt,
  }));
  assert.equal(afterMigrate.idempotency.acquired, false);
  assert.equal(afterMigrate.idempotency.duplicate, true);
  assert.equal(afterMigrate.correlation_id, legacyCorr);
  assert.equal(afterMigrate.idempotency.existing_event_id, legacyId);
  assert.equal(psql(`SELECT count(*) FROM processed_events WHERE external_event_id='${legacyExt}'
    AND project_id='proj_legacy' AND bot_id='bot_legacy' AND channel='telegram';`), '1');
  assert.equal(psql(`SELECT event_id FROM processed_events WHERE event_id='${legacyId}';`), legacyId);
  assert.equal(psql(`SELECT correlation_id FROM processed_events WHERE event_id='${legacyId}';`), legacyCorr);

  assert.equal(psql(`SELECT sanitized_payload::text FROM event_log WHERE event_id='${a.event_id}';`), '{}');
});

test('legacy scope apply then composite event_id: no second reservation (regression)', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, () => {
  applyMigrations();
  // Mirrors legacy key tg_42 vs WF-00 composite telegram|project|bot|42.
  const ext = '42-' + randomUUID().slice(0, 8);
  const oldId = 'tg_' + ext;
  const corr = 'COR-tg42-' + randomUUID().slice(0, 8);
  psql(`INSERT INTO processed_events(event_id,source,status,correlation_id)
    VALUES('${oldId}','telegram','completed','${corr}');`);
  psql(`INSERT INTO legacy_event_scope_map(event_id,channel,project_id,bot_id,external_event_id,confirmed_by)
    VALUES('${oldId}','telegram','proj_demo','bot_a','${ext}','operator-regression');`);
  assert.equal(JSON.parse(psql('SELECT dis_core_legacy_event_scope_apply();')).updated >= 1, true);

  const neu = call('dis_core_reserve', scopedContract({
    event_id: `telegram|proj_demo|bot_a|${ext}`,
    project_id: 'proj_demo',
    bot_id: 'bot_a',
    external_event_id: ext,
  }));
  assert.equal(neu.idempotency.acquired, false, 'must not re-reserve after legacy scope apply');
  assert.equal(neu.idempotency.duplicate, true);
  assert.equal(neu.correlation_id, corr);
  assert.equal(neu.idempotency.existing_event_id, oldId);
});

test('concurrent reserve: distinct event_id same confirmed scope — exactly one acquired', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, async () => {
  applyMigrations();
  const ext = 'race-scope-' + randomUUID().slice(0, 8);
  const scope = { channel: 'telegram', project_id: 'proj_demo', bot_id: 'bot_a', external_event_id: ext };
  const p0 = scopedContract({ ...scope, event_id: `telegram|proj_demo|bot_a|${ext}` });
  const p1 = scopedContract({ ...scope, event_id: `tg_${ext}` });
  const lit0 = "'" + JSON.stringify(p0).replaceAll("'", "''") + "'::jsonb";
  const lit1 = "'" + JSON.stringify(p1).replaceAll("'", "''") + "'::jsonb";
  const [r0, r1] = await Promise.all([
    psqlAsync(`SELECT dis_core_reserve(${lit0});`),
    psqlAsync(`SELECT dis_core_reserve(${lit1});`),
  ]);
  const results = [JSON.parse(r0), JSON.parse(r1)];
  assert.equal(results.filter((r) => r.idempotency.acquired).length, 1);
  assert.equal(results.filter((r) => !r.idempotency.acquired).length, 1);
  assert.equal(psql(`SELECT count(*) FROM processed_events WHERE project_id='proj_demo'
    AND bot_id='bot_a' AND channel='telegram' AND external_event_id='${ext}';`), '1');
});

test('legacy dry-run reports scope identity conflicts without deleting rows', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, () => {
  applyMigrations();
  const a = 'tg_conflict_a_' + randomUUID().slice(0, 6);
  const b = 'tg_conflict_b_' + randomUUID().slice(0, 6);
  psql(`INSERT INTO processed_events(event_id,source,status,correlation_id)
    VALUES('${a}','telegram','completed','COR-a'),('${b}','telegram','completed','COR-b');`);
  psql(`INSERT INTO legacy_event_scope_map(event_id,channel,project_id,bot_id,external_event_id,confirmed_by)
    VALUES('${a}','telegram','proj_c','bot_c','same-ext','op'),
          ('${b}','telegram','proj_c','bot_c','same-ext','op');`);
  const dry = JSON.parse(psql('SELECT dis_core_legacy_event_scope_dry_run();'));
  assert.ok(dry.scope_identity_conflicts >= 1);
  assert.equal(dry.auto_assign, false);
  const applied = JSON.parse(psql('SELECT dis_core_legacy_event_scope_apply();'));
  assert.equal(applied.updated, 0);
  assert.equal(applied.refused_due_to_conflicts, true);
  assert.equal(psql(`SELECT count(*) FROM processed_events WHERE event_id IN ('${a}','${b}');`), '2');
  assert.equal(psql(`SELECT count(*) FROM processed_events WHERE event_id='${a}' AND project_id IS NULL;`), '1');
});

test('concurrent reserve in one scope: exactly one acquired', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, async () => {
  applyMigrations();
  const payload = scopedContract();
  const lit = "'" + JSON.stringify(payload).replaceAll("'", "''") + "'::jsonb";
  const q0 = `SELECT dis_core_reserve((${lit} || jsonb_build_object('execution_id','race-0-${randomUUID()}')) );`;
  const q1 = `SELECT dis_core_reserve((${lit} || jsonb_build_object('execution_id','race-1-${randomUUID()}')) );`;
  const [r0, r1] = await Promise.all([psqlAsync(q0), psqlAsync(q1)]);
  const results = [JSON.parse(r0), JSON.parse(r1)];
  assert.equal(results.filter((r) => r.idempotency.acquired).length, 1);
  assert.equal(results.filter((r) => r.idempotency.busy).length, 1);
  assert.equal(psql(`SELECT count(*) FROM event_log WHERE event_id='${payload.event_id}';`), '1');
});

test('unknown and blocked users; expired context; foreign lock', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, () => {
  applyMigrations();
  const unknown = call('dis_core_auth', scopedContract({ user_id: '999000111' }));
  assert.equal(unknown.auth.registration_required, true);
  assert.equal(unknown.auth.allowed, false);
  assert.equal(call('dis_core_context', unknown).context.exists, false);

  const tg = String(BigInt('6' + Date.now().toString().slice(-12)));
  psql(`INSERT INTO users(telegram_id,status) VALUES (${tg},'blocked') RETURNING id;`);
  const blocked = call('dis_core_auth', scopedContract({ user_id: tg }));
  assert.equal(blocked.auth.found, true);
  assert.equal(blocked.auth.allowed, false);

  const activeTg = String(BigInt('7' + Date.now().toString().slice(-12)));
  const active = psql(`INSERT INTO users(telegram_id,status) VALUES (${activeTg},'active') RETURNING id;`);
  const dlgExp = 'dlg-exp-' + randomUUID().slice(0, 8);
  psql(`INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,state,status,expires_at)
    VALUES('proj_demo','bot_a','telegram','${dlgExp}','${active}','awaiting_payment','active', now() - interval '1 minute');`);
  const exp = scopedContract({
    dialogue_id: dlgExp,
    auth: { allowed: true, user: { id: active } },
  });
  call('dis_core_reserve', exp);
  const expired = call('dis_core_context', exp);
  assert.equal(expired.context.expired, true);
  assert.equal(expired.context.lock_acquired, true);

  const lockedUser = psql(`INSERT INTO users(telegram_id) VALUES (${BigInt('8' + Date.now().toString().slice(-12))}) RETURNING id;`);
  const dlgForeign = 'dlg-foreign-' + randomUUID().slice(0, 8);
  psql(`INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,processing_lock,lock_owner,locked_at)
    VALUES('proj_demo','bot_a','telegram','${dlgForeign}','${lockedUser}',true,'foreign-owner', now());`);
  const foreign = scopedContract({
    dialogue_id: dlgForeign,
    auth: { allowed: true, user: { id: lockedUser } },
  });
  call('dis_core_reserve', foreign);
  const held = call('dis_core_context', foreign);
  assert.equal(held.context.processing_lock, true);
  assert.equal(held.context.lock_acquired, false);
  assert.equal(held.context.stale, false);
});

test('DB fault before/after reserve on isolated DB; status not falsely completed', {
  skip: !hasDb && 'DIS_TEST_DATABASE_URL or DIS_TEST_PSQL_DOCKER unset',
}, () => {
  applyMigrations();
  const before = scopedContract();
  psql(`CREATE OR REPLACE FUNCTION dis_core_reserve(p JSONB) RETURNS JSONB
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'password=SQL-SECRET-MARKER simulated'; END; $$;`);
  assert.throws(() => call('dis_core_reserve', before));
  assert.equal(psql(`SELECT count(*) FROM processed_events WHERE event_id='${before.event_id}';`), '0');
  applyMigrations();

  const after = scopedContract();
  assert.equal(call('dis_core_reserve', after).idempotency.acquired, true);
  psql(`CREATE OR REPLACE FUNCTION dis_core_finish(p JSONB, is_failure BOOLEAN DEFAULT false) RETURNS JSONB
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'password=SQL-SECRET-MARKER simulated'; END; $$;`);
  assert.throws(() => call('dis_core_finish', after));
  assert.equal(psql(`SELECT status FROM processed_events WHERE event_id='${after.event_id}';`), 'processing');
  applyMigrations();
  assert.equal(call('dis_core_reserve', { ...after, execution_id: randomUUID() }).idempotency.busy, true);
  assert.equal(call('dis_core_finish', after).persistence.recorded, true);
});
