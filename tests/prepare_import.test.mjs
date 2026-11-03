import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('prepare-import rejects public webhook exposure and writes ingress contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dis-prep-'));
  const mapping = join(dir, 'mapping.json');
  const output = join(dir, 'out');
  writeFileSync(mapping, JSON.stringify({
    workflow_ids: {
      disCoreWF00: 'a', disCoreWF01: 'b', disCoreWF02: 'c', disCoreWF03: 'd', disCoreWF04: 'e',
    },
    postgres_credential: { id: 'cred', name: 'test' },
    webhook_path: 'dis-agent-core',
    webhook_exposure: 'public',
    ingress_required: true,
  }));
  const bad = spawnSync('python', [join(root, 'scripts', 'prepare-import.py'), '--mapping', mapping, '--output', output], {
    encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);

  writeFileSync(mapping, JSON.stringify({
    workflow_ids: {
      disCoreWF00: 'a', disCoreWF01: 'b', disCoreWF02: 'c', disCoreWF03: 'd', disCoreWF04: 'e',
    },
    postgres_credential: { id: 'cred', name: 'test' },
    webhook_path: 'dis-agent-core-private',
    webhook_exposure: 'loopback_only',
    ingress_required: true,
  }));
  const ok = spawnSync('python', [join(root, 'scripts', 'prepare-import.py'), '--mapping', mapping, '--output', output], {
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  const contract = JSON.parse(readFileSync(join(output, 'INGRESS_CONTRACT.json'), 'utf8'));
  assert.equal(contract.ingress_required, true);
  assert.ok(contract.required_fields.includes('project_id'));
  rmSync(dir, { recursive: true, force: true });
});
