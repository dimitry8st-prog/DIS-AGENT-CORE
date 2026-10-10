#!/usr/bin/env python3
"""Prepare ONLY the existing cloud Docker test stack, never an arbitrary n8n URL."""
import json
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
import importlib.util

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path('/workspace/dis-agent-dev/core-test')
N8N = 'dis-core-n8n'
PG = 'dis-core-postgres'
DB = 'dis_core_workflows_test'
ROLE = 'dis_core_workflows_test'
URL = 'http://127.0.0.1:5678'


def command(*args, input=None):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f'Command failed: {args[:4]}\n{result.stdout}')
    return result.stdout


def sql(query, db=DB):
    return command('docker', 'exec', '-i', PG, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                   '-U', 'disdev', '-d', db, '-At', input=query).strip()


def cli(*args, expected):
    output = command('docker', 'exec', '-e', 'N8N_DIAGNOSTICS_ENABLED=false', N8N, 'n8n', *args)
    # n8n import catches some failures with exit 0. Check its documented result too.
    if expected not in output:
        raise RuntimeError(f'n8n operation was not confirmed: {output}')
    return output


def ready():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(URL + '/healthz/readiness', timeout=2) as response:
                if json.load(response)['status'] == 'ok':
                    return
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(1)
    raise RuntimeError('Cloud n8n did not become ready')


def reimport():
    cli('import:workflow', '--separate', '--input=/tmp/dis-core-fixed', expected='Successfully imported 5 workflows')
    mapping = json.loads((ARTIFACTS / 'mapping.json').read_text())
    # n8n 2.42.6 has explicit published versions. Restart after CLI publication.
    for num in range(4, -1, -1):
        cli('publish:workflow', '--id=' + mapping['workflow_ids'][f'disCoreWF0{num}'],
            expected='Please restart n8n')
    command('docker', 'restart', N8N)
    ready()
    # HTTP health can precede publication/webhook reconciliation. Confirm the
    # actual endpoint with an invalid event (no DB reservation or side effects).
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        request = urllib.request.Request(URL + '/webhook/dis-agent-core-test', data=b'{}',
                                         headers={'Content-Type':'application/json'}, method='POST')
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        except OSError:
            time.sleep(1)
            continue
        with response:
            try:
                data = json.load(response)
                if response.status == 400 and data.get('status') == 'invalid_event':
                    return
            except ValueError:
                pass
        time.sleep(1)
    raise RuntimeError('Published cloud test webhook did not become ready')


def setup():
    if not Path('/workspace/DIS-AGENT-CORE').is_dir() or ROOT != Path('/workspace/DIS-AGENT-CORE'):
        raise RuntimeError('This helper is restricted to the prepared cloud checkout')
    ready()
    version = command('docker', 'exec', N8N, 'n8n', '--version').strip()
    if version != '2.42.6':
        raise RuntimeError('Expected tested n8n 2.42.6, got ' + version)
    # Inspect public metadata, not credentials. Preserve the initial exports.
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    cli('export:workflow', '--all', '--output=/tmp/dis-core-before.json', expected='Successfully exported')
    before_path = ARTIFACTS / ('before-' + str(time.time_ns()) + '.json')
    command('docker', 'cp', N8N + ':/tmp/dis-core-before.json', str(before_path))
    before = json.loads(before_path.read_text())
    mapping = {'workflow_ids': {}, 'postgres_credential': {'id': 'disCoreTestPg',
               'name': 'DIS Core cloud test PostgreSQL'}, 'webhook_path': 'dis-agent-core-test'}
    for i in range(5):
        name = json.loads(next((ROOT / 'workflows').glob(f'WF-0{i}*.json')).read_text())['name']
        matches = [w['id'] for w in before if w['name'] == name]
        if len(matches) > 1:
            raise RuntimeError('Ambiguous workflow name; provide an explicit reviewed ID mapping')
        mapping['workflow_ids'][f'disCoreWF0{i}'] = matches[0] if matches else f'disCoreWF0{i}'
    (ARTIFACTS / 'mapping.json').write_text(json.dumps(mapping, indent=2) + '\n')
    if sql(f"SELECT 1 FROM pg_database WHERE datname='{DB}';", db='postgres') != '1':
        sql(f'CREATE DATABASE {DB};', db='postgres')
    if sql(f"SELECT 1 FROM pg_roles WHERE rolname='{ROLE}';", db='postgres') != '1':
        sql(f'CREATE ROLE {ROLE} LOGIN;', db='postgres')
    sql((ROOT / 'db/001_core.sql').read_text())
    sql((ROOT / 'db/002_core_processing.sql').read_text())
    sql(f'GRANT CONNECT ON DATABASE {DB} TO {ROLE};\n'
        f'GRANT USAGE ON SCHEMA public TO {ROLE};\n'
        f'GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO {ROLE};\n'
        f'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {ROLE};\n'
        f'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {ROLE};\n'
        f"ALTER ROLE {ROLE} IN DATABASE {DB} SET statement_timeout='10s';")
    credential = [{'id': 'disCoreTestPg', 'name': mapping['postgres_credential']['name'],
        'type': 'postgres', 'data': {'host': PG, 'database': DB, 'user': ROLE,
        'password': '', 'port': 5432, 'ssl': 'disable', 'allowUnauthorizedCerts': False,
        'maxConnections': 10, 'sshTunnel': False}}]
    (ARTIFACTS / 'test-credential.json').write_text(json.dumps(credential))
    command('docker', 'cp', str(ARTIFACTS / 'test-credential.json'), N8N + ':/tmp/dis-core-test-credential.json')
    cli('import:credentials', '--input=/tmp/dis-core-test-credential.json', expected='Successfully imported 1 credential')
    spec = importlib.util.spec_from_file_location('prepare_import', ROOT / 'scripts/prepare-import.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.prepare(ROOT / 'workflows', ARTIFACTS / 'workflows', mapping)
    command('docker', 'exec', N8N, 'mkdir', '-p', '/tmp/dis-core-fixed')
    # docker cp of a directory into an existing directory nests it, leaving old
    # top-level exports unchanged. Copy each file explicitly on every import.
    for path in (ARTIFACTS / 'workflows').glob('*.json'):
        command('docker', 'cp', str(path), N8N + ':/tmp/dis-core-fixed/' + path.name)
    reimport()
    cli('export:workflow', '--all', '--output=/tmp/dis-core-after.json', expected='Successfully exported')
    command('docker', 'cp', N8N + ':/tmp/dis-core-after.json', str(ARTIFACTS / 'after.json'))
    for workflow in json.loads((ARTIFACTS / 'after.json').read_text()):
        if workflow['id'] in mapping['workflow_ids'].values():
            assert workflow['settings']['saveDataErrorExecution'] == 'none'
            assert workflow['settings']['saveDataSuccessExecution'] == 'none'
            if workflow['id'] == mapping['workflow_ids']['disCoreWF00']:
                webhook = next(n for n in workflow['nodes'] if n['type'].endswith('.webhook'))
                assert webhook['webhookId']
                assert webhook['parameters']['path'] == 'dis-agent-core-test'
    print(f'Cloud test chain imported: n8n {version}, isolated DB {DB}, five existing IDs retained.')


if __name__ == '__main__':
    setup()
