"""Real PostgreSQL checks in the isolated cloud test database; never deletes data."""
import concurrent.futures
import json
import threading
import unittest
import uuid

from cloud_setup import DB, ROOT, ROLE, sql


def literal(value):
    return "'" + json.dumps(value, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def function(name, value, extra=''):
    # Exercise the same non-superuser connection role used by n8n.
    return json.loads(sql(f'SET ROLE {ROLE}; SELECT {name}({literal(value)}{extra});').splitlines()[-1])


class SQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert DB == 'dis_core_workflows_test'
        cls.prefix = 'sql-' + uuid.uuid4().hex

    def contract(self, suffix, dialogue_id=None):
        external = self.prefix + '-' + suffix
        dialogue = dialogue_id or f'dlg-{suffix}'
        return {
            'event_id': f'webhook|proj_demo|bot_a|{external}',
            'external_event_id': external,
            'channel': 'webhook',
            'project_id': 'proj_demo',
            'bot_id': 'bot_a',
            'source_id': 'api-demo',
            'dialogue_id': dialogue,
            'correlation_id': 'COR-' + uuid.uuid4().hex,
            'source': 'webhook',
            'event_type': 'message',
            'execution_id': uuid.uuid4().hex,
            'user_id': None,
            'valid': True,
            'payload': {'token': 'SQL-SECRET-MARKER'},
        }

    def test_migrations_repeat_and_preserve_data(self):
        j = function('dis_core_reserve', self.contract('migration'))
        sql((ROOT/'db/001_core.sql').read_text())
        sql((ROOT/'db/002_core_processing.sql').read_text())
        sql((ROOT/'db/003_scoped_ingress.sql').read_text())
        self.assertEqual(sql(f"SELECT status FROM processed_events WHERE event_id='{j['event_id']}';"), 'processing')
        # 001:7 tables + legacy_event_scope_map + legacy_context_scope_map + bot_context_scoped
        self.assertEqual(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"), '10')

    def test_atomic_concurrent_reservation(self):
        j = self.contract('race')
        barrier = threading.Barrier(2)
        def reserve(i):
            barrier.wait()
            return function('dis_core_reserve', {**j,'execution_id':f'race-{i}'})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, range(2)))
        self.assertEqual(sum(r['idempotency']['acquired'] for r in results), 1)
        self.assertEqual(sum(r['idempotency']['busy'] for r in results), 1)
        self.assertEqual(sql(f"SELECT count(*) FROM event_log WHERE event_id='{j['event_id']}';"), '1')

    def test_owner_only_completion_duplicate_and_no_repeated_side_effects(self):
        j = function('dis_core_reserve', self.contract('owner'))
        intruder = function('dis_core_finish', {**j,'execution_id':'other'})
        self.assertFalse(intruder['persistence']['recorded'])
        result = function('dis_core_finish', j)
        self.assertTrue(result['persistence']['recorded'])
        self.assertFalse(function('dis_core_finish', j)['persistence']['recorded'])
        retry = function('dis_core_reserve', {**j,'correlation_id':'COR-other','execution_id':'other'})
        self.assertTrue(retry['idempotency']['duplicate'])
        self.assertEqual(retry['correlation_id'],j['correlation_id'])
        self.assertEqual(sql(f"SELECT count(*) FROM application_log WHERE correlation_id='{j['correlation_id']}';"), '1')

    def test_failure_is_recorded_once_and_not_automatically_retried(self):
        j = function('dis_core_reserve', self.contract('failure'))
        self.assertTrue(function('dis_core_finish', j, ', true')['persistence']['recorded'])
        self.assertFalse(function('dis_core_finish', j, ', true')['persistence']['recorded'])
        self.assertTrue(function('dis_core_reserve', j)['idempotency']['failed'])
        self.assertEqual(sql(f"SELECT count(*) FROM failed_events WHERE event_id='{j['event_id']}';"), '1')

    def test_unknown_user_null_context_always_returns_one_contract(self):
        j = function('dis_core_auth', self.contract('unknown'))
        self.assertTrue(j['auth']['registration_required'])
        self.assertFalse(j['auth']['allowed'])
        j = function('dis_core_context',j)
        self.assertFalse(j['context']['exists'])
        self.assertEqual(j['context']['state'],'new')

    def test_lock_ownership_release(self):
        user = sql("INSERT INTO users DEFAULT VALUES RETURNING id;").splitlines()[0]
        dialogue = f'dlg-context-{uuid.uuid4().hex[:8]}'
        sql(
            "INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,state,payload) "
            f"VALUES('proj_demo','bot_a','webhook','{dialogue}','{user}','awaiting_input',"
            "'{\"token\":\"SQL-SECRET-MARKER\"}');"
        )
        j = function('dis_core_reserve', self.contract('context', dialogue_id=dialogue))
        j['auth'] = {'allowed': True, 'user': {'id': user}}
        j = function('dis_core_context', j)
        self.assertTrue(j['context']['lock_acquired'])
        self.assertEqual(j['context']['payload'], {})
        other = function('dis_core_context', {**j, 'execution_id': 'other'})
        self.assertTrue(other['context']['processing_lock'])
        self.assertFalse(other['context']['lock_acquired'])
        function('dis_core_finish', {**j, 'execution_id': 'other'})
        self.assertEqual(sql(
            "SELECT processing_lock FROM bot_context_scoped "
            f"WHERE project_id='proj_demo' AND bot_id='bot_a' AND channel='webhook' AND dialogue_id='{dialogue}';"
        ), 't')
        function('dis_core_finish', j)
        self.assertEqual(sql(
            "SELECT processing_lock FROM bot_context_scoped "
            f"WHERE project_id='proj_demo' AND bot_id='bot_a' AND channel='webhook' AND dialogue_id='{dialogue}';"
        ), 'f')

    def test_stale_missing_timestamp_is_not_silently_reclaimed(self):
        user = sql("INSERT INTO users DEFAULT VALUES RETURNING id;").splitlines()[0]
        dialogue = f'dlg-stale-{uuid.uuid4().hex[:8]}'
        sql(
            "INSERT INTO bot_context_scoped(project_id,bot_id,channel,dialogue_id,user_id,processing_lock,lock_owner) "
            f"VALUES('proj_demo','bot_a','webhook','{dialogue}','{user}',true,'unrelated-owner');"
        )
        j = self.contract('stale', dialogue_id=dialogue)
        j['auth'] = {'allowed': True, 'user': {'id': user}}
        result = function('dis_core_context', j)
        self.assertTrue(result['context']['stale'])
        self.assertFalse(result['context']['lock_acquired'])
        self.assertEqual(sql(
            "SELECT lock_owner FROM bot_context_scoped "
            f"WHERE project_id='proj_demo' AND bot_id='bot_a' AND channel='webhook' AND dialogue_id='{dialogue}';"
        ), 'unrelated-owner')

    def test_logs_never_store_secret_payload(self):
        j = function('dis_core_reserve',self.contract('privacy'))
        function('dis_core_finish',j,', true')
        rows = sql(f"SELECT row_to_json(t) FROM event_log t WHERE event_id='{j['event_id']}';\n"
                   f"SELECT row_to_json(t) FROM application_log t WHERE correlation_id='{j['correlation_id']}';\n"
                   f"SELECT row_to_json(t) FROM failed_events t WHERE event_id='{j['event_id']}';")
        self.assertNotIn('SQL-SECRET-MARKER',rows)
        self.assertIn('Core processing failed',rows)


if __name__ == '__main__':
    unittest.main(verbosity=2)
