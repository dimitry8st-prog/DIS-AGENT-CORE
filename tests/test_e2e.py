"""HTTP end-to-end execution of the imported WF-00...WF-04 in cloud n8n."""
import concurrent.futures
import json
import subprocess
import time
import unittest
import urllib.error
import urllib.request
import uuid

from cloud_setup import ARTIFACTS, DB, N8N, PG, ROLE, URL, command, ready, sql


class EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ready()
        cls.prefix = 'e2e-' + uuid.uuid4().hex
        cls.next_user = 1000000000000 + int(uuid.uuid4().hex[:10], 16)
        cls.next_event = 0

    def event(self, **fields):
        type(self).next_event += 1
        return {'event_id':f'{self.prefix}-{self.next_event}',**fields}

    def fixture(self, state=None, expired=False, lock=False, stale=False, active=True):
        type(self).next_user += 1
        external = str(self.next_user)
        internal = sql(f"INSERT INTO users(telegram_id,status) VALUES({external},'{ 'active' if active else 'blocked' }') RETURNING id;").splitlines()[0]
        if state is not None:
            expiry = "now() - interval '1 minute'" if expired else "now() + interval '1 hour'"
            locked_at = "now() - interval '11 minutes'" if stale else 'now()'
            sql(f"INSERT INTO bot_context(user_id,state,expires_at,processing_lock,locked_at,lock_owner,payload) "
                f"VALUES('{internal}','{state}',{expiry},{str(lock).lower()},"
                f"{locked_at if lock else 'null'},{chr(39)+'fixture-owner'+chr(39) if lock else 'null'},"
                "'{\"token\":\"E2E-SECRET-MARKER\"}');")
        return external, internal

    def request(self, body, headers=None):
        request = urllib.request.Request(URL + '/webhook/dis-agent-core-test',
            data=json.dumps(body).encode(), method='POST',
            headers={'Content-Type':'application/json',**(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=45)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read().decode()
            self.assertNotIn('E2E-SECRET-MARKER',raw)
            self.assertNotIn('SQL-ERROR-SECRET-MARKER',raw)
            result = json.loads(raw)
            self.assertIn('correlation_id',result, f'n8n did not return the chain contract: HTTP {response.status}')
            return response.status,result

    def assert_completed(self, response, route=None):
        code, body = response
        self.assertEqual(code,200,body)
        self.assertEqual(body['status'],'completed',body)
        if route: self.assertEqual(body['routing']['route'],route,body)
        self.assertEqual(sql(f"SELECT status FROM processed_events WHERE event_id='{body['event_id']}';"),'completed')
        return body

    def test_regular_known_user_duplicate_and_side_effects(self):
        external, internal = self.fixture('awaiting_input')
        event = self.event(user_id=external,text='/help')
        first = self.assert_completed(self.request(event),'support')
        code,second = self.request(event)
        self.assertEqual(code,200)
        self.assertTrue(second['duplicate'])
        self.assertEqual(second['status'],'duplicate')
        self.assertEqual(first['correlation_id'],second['correlation_id'])
        self.assertNotIn('routing',second)
        self.assertEqual(sql(f"SELECT user_id FROM processed_events WHERE event_id='{first['event_id']}';"),internal)
        self.assertEqual(sql(f"SELECT count(*) FROM event_log WHERE event_id='{first['event_id']}';"),'1')
        self.assertEqual(sql(f"SELECT count(*) FROM application_log WHERE correlation_id='{first['correlation_id']}';"),'1')
        self.assertEqual(sql(f"SELECT processing_lock FROM bot_context WHERE user_id='{internal}';"),'f')

    def test_simultaneous_identical_event_returns_busy_then_duplicate(self):
        external, internal = self.fixture('awaiting_input')
        event = self.event(user_id=external,text='/help')
        app = 'hold_' + uuid.uuid4().hex
        # Hold the context row only in this test DB so the first HTTP execution
        # remains processing while a second real HTTP request arrives.
        blocker = subprocess.Popen(['docker','exec','-i',PG,'psql','-X','-v','ON_ERROR_STOP=1',
            '-U','disdev','-d',DB,'-At'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        blocker.stdin.write(f"SET application_name='{app}'; BEGIN; SELECT user_id FROM bot_context WHERE user_id='{internal}' FOR UPDATE; SELECT pg_sleep(5); COMMIT;")
        blocker.stdin.close()
        deadline = time.monotonic() + 5
        while sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{app}' AND wait_event='PgSleep';") != '1':
            if time.monotonic() > deadline: self.fail('Test context lock was not acquired')
            time.sleep(0.05)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                first_future = pool.submit(self.request,event)
                deadline = time.monotonic() + 4
                event_id = 'webhook_' + event['event_id']
                while sql(f"SELECT status FROM processed_events WHERE event_id='{event_id}';") != 'processing':
                    if time.monotonic() > deadline: self.fail('First event was not reserved')
                    time.sleep(0.05)
                code,busy = self.request(event)
                self.assertEqual(code,409,busy)
                self.assertEqual(busy['status'],'busy')
                self.assertTrue(busy['busy'])
                self.assertNotIn('routing',busy)
                first = self.assert_completed(first_future.result(),'support')
            self.assertEqual(busy['correlation_id'],first['correlation_id'])
            code,duplicate = self.request(event)
            self.assertEqual(code,200)
            self.assertTrue(duplicate['duplicate'])
            self.assertEqual(sql(f"SELECT count(*) FROM event_log WHERE event_id='{event_id}';"),'1')
            self.assertEqual(sql(f"SELECT count(*) FROM application_log WHERE correlation_id='{first['correlation_id']}';"),'1')
        finally:
            blocker.wait(timeout=10)
            blocker.stdout.close()
            blocker.stderr.close()

    def test_unknown_user_has_registration_required_without_inserting_user(self):
        external = '9223372036854775807'
        code,body = self.request(self.event(user_id=external,text='/pay'))
        self.assertEqual(code,200,body)
        self.assertEqual(body['status'],'registration_required')
        self.assertTrue(body['auth']['registration_required'])
        self.assertEqual(body['routing']['route'],'auth')
        self.assertFalse(body['context']['exists'])
        self.assertEqual(sql(f'SELECT count(*) FROM users WHERE telegram_id={external};'),'0')

    def test_expired_context_and_command_priority(self):
        external,internal = self.fixture('awaiting_payment',expired=True)
        body = self.assert_completed(self.request(self.event(user_id=external,text='hello')),'unknown')
        self.assertTrue(body['context']['expired'])
        self.assertEqual(body['context']['state'],'expired')
        self.assertEqual(body['routing']['reason'],'context_expired')
        self.assert_completed(self.request(self.event(user_id=external,text='/help')),'support')
        self.assertEqual(sql(f"SELECT state FROM bot_context WHERE user_id='{internal}';"),'awaiting_payment')

    def test_processing_and_stale_context_remain_locked_by_original_owner(self):
        for stale,expected in [(False,'context_busy'),(True,'context_stale')]:
            external,internal = self.fixture('awaiting_input',lock=True,stale=stale)
            code,body = self.request(self.event(user_id=external,text='/help'))
            self.assertEqual(code,409,body)
            self.assertEqual(body['status'],expected)
            self.assertEqual(body['routing']['route'],'unknown')
            self.assertEqual(body['context']['stale'],stale)
            self.assertEqual(sql(f"SELECT lock_owner FROM bot_context WHERE user_id='{internal}';"),'fixture-owner')

    def test_known_user_without_context_and_blocked_user(self):
        external,_ = self.fixture()
        body = self.assert_completed(self.request(self.event(user_id=external,text='hello')),'ai_classification')
        self.assertFalse(body['context']['exists'])
        self.assertTrue(body['routing']['llm_required'])
        external,_ = self.fixture(active=False)
        code,body = self.request(self.event(user_id=external,text='/pay'))
        self.assertEqual(code,403,body)
        self.assertFalse(body['auth']['allowed'])
        self.assertEqual(body['routing']['route'],'unknown')

    def test_commands_callbacks_context_and_free_text(self):
        external,_ = self.fixture('new')
        for payload,route in [({'text':'/start'},'auth'),({'text':'/help'},'support'),
            ({'text':'/pay'},'payment'),({'text':'/status'},'order_status'),
            ({'callback_data':'pay:42'},'payment'),({'callback_data':'approve:42'},'approval'),
            ({'callback_data':'order:42'},'order'),({'text':'нужна помощь'},'support'),
            ({'text':'произвольный свободный текст'},'ai_classification')]:
            with self.subTest(payload=payload):
                self.assert_completed(self.request(self.event(user_id=external,**payload)),route)
        for state,route in [('awaiting_input','context_input'),('awaiting_payment','payment'),('awaiting_approval','approval')]:
            external,_ = self.fixture(state)
            self.assert_completed(self.request(self.event(user_id=external,text='hello')),route)

    def test_telegram_message_and_callback_contract(self):
        external,_ = self.fixture('new')
        event = self.event()
        # event_id is supplied for stable unique fixtures; a native update_id is
        # exercised separately, including zero in the static contract tests.
        event['message'] = {'from':{'id':int(external)},'chat':{'id':42},'message_id':1,'text':'/help'}
        body = self.assert_completed(self.request(event),'support')
        self.assertEqual(body['source'],'telegram')
        self.assertEqual(body['user_id'],external)
        event = self.event(callback_query={'id':'callback-'+uuid.uuid4().hex,'from':{'id':int(external)},'data':'pay:42'})
        body = self.assert_completed(self.request(event),'payment')
        self.assertEqual(body['event_type'],'callback_query')

    def test_unknown_route_and_invalid_event_have_safe_responses(self):
        external,_ = self.fixture('new')
        for payload in [{},{'text':'/unknown'},{'callback_data':'unknown:42'}]:
            body = self.assert_completed(self.request(self.event(user_id=external,**payload)),'unknown')
            self.assertEqual(body['message'],'Событие принято; маршрут не определён.')
        code,body = self.request({'user_id':external,'text':'/help'})
        self.assertEqual(code,400,body)
        self.assertEqual(body['status'],'invalid_event')

    def test_secret_payload_is_absent_from_responses_and_persisted_logs(self):
        external,_ = self.fixture('new')
        event = self.event(user_id=external,text='E2E-SECRET-MARKER',password='E2E-SECRET-MARKER',
            token='E2E-SECRET-MARKER',nested={'secret':'E2E-SECRET-MARKER'},email='private@example.invalid')
        body = self.assert_completed(self.request(event,{'Authorization':'Bearer E2E-SECRET-MARKER',
            'Cookie':'token=E2E-SECRET-MARKER','X-API-Key':'E2E-SECRET-MARKER'}),'ai_classification')
        rows = sql(f"SELECT row_to_json(t) FROM event_log t WHERE event_id='{body['event_id']}';\n"
                   f"SELECT row_to_json(t) FROM application_log t WHERE correlation_id='{body['correlation_id']}';")
        self.assertNotIn('E2E-SECRET-MARKER',rows)
        self.assertNotIn('private@example.invalid',rows)
        mapping = json.loads((ARTIFACTS/'mapping.json').read_text())
        ids = ','.join("'"+i+"'" for i in mapping['workflow_ids'].values())
        # Inspect only execution payloads, never the n8n credential table/config.
        query = f"SELECT count(*) AS leaks FROM execution_data d JOIN execution_entity e ON e.id=d.executionId WHERE e.deletedAt IS NULL AND e.workflowId IN ({ids}) AND (d.data LIKE '%E2E-SECRET-MARKER%' OR d.data LIKE '%SQL-ERROR-SECRET-MARKER%')"
        js = "const s=require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3'); const db=new s.Database('/home/node/.n8n/database.sqlite'); db.get("+json.dumps(query)+",(e,r)=>{if(e){console.error(e.message);process.exitCode=1;}else console.log(r.leaks);db.close();});"
        self.assertEqual(command('docker','exec','-i',N8N,'node',input=js).strip(),'0')
        logs = command('docker','logs',N8N)
        self.assertNotIn('E2E-SECRET-MARKER',logs)
        self.assertNotIn('SQL-ERROR-SECRET-MARKER',logs)

    @unittest.expectedFailure
    def test_n8n_internal_soft_deleted_input_retention_limitation(self):
        # Known n8n 2.42.6 behavior: save=none soft-deletes initial input; it does
        # not erase physical execution_data immediately. Keep this strict check
        # visible as an expected failure, distinct from application log checks.
        external,_ = self.fixture('new')
        marker = 'N8N-RETENTION-' + uuid.uuid4().hex
        self.assert_completed(self.request(self.event(user_id=external,text='/help',token=marker)),'support')
        query = "SELECT count(*) AS leaks FROM execution_data WHERE data LIKE '%" + marker + "%'"
        js = "const s=require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3'); const db=new s.Database('/home/node/.n8n/database.sqlite'); db.get("+json.dumps(query)+",(e,r)=>{if(e)process.exitCode=1;else console.log(r.leaks);db.close();});"
        # No manual deletion or shorter global pruning: existing data is preserved.
        self.assertEqual(command('docker','exec','-i',N8N,'node',input=js).strip(),'0',
            'n8n retains soft-deleted initial webhook input until native pruning')

    def test_postgres_query_error_after_reservation_is_failed_once(self):
        external,_ = self.fixture('new')
        event = self.event(user_id=external,text='/help')
        sql(f'REVOKE SELECT ON users FROM {ROLE};')
        try:
            code,body = self.request(event)
            self.assertEqual(code,503,body)
            self.assertEqual(body['status'],'failed')
            self.assertEqual(body['error'],'core_processing_error')
        finally:
            sql(f'GRANT SELECT ON users TO {ROLE};')
        event_id = 'webhook_' + event['event_id']
        self.assertEqual(sql(f"SELECT status FROM processed_events WHERE event_id='{event_id}';"),'failed')
        self.assertEqual(sql(f"SELECT count(*) FROM failed_events WHERE event_id='{event_id}';"),'1')

    def test_postgres_sensitive_exception_inside_child_is_not_logged(self):
        external,_ = self.fixture('new')
        event = self.event(user_id=external,text='/help')
        sql("CREATE OR REPLACE FUNCTION dis_core_auth(p JSONB) RETURNS JSONB LANGUAGE plpgsql VOLATILE AS $$ BEGIN RAISE EXCEPTION 'SQL-ERROR-SECRET-MARKER'; END; $$;")
        try:
            code,body = self.request(event)
            self.assertEqual(code,503,body)
            self.assertEqual(body['error'],'core_processing_error')
        finally:
            from cloud_setup import ROOT
            sql((ROOT/'db/002_core_processing.sql').read_text())
        event_id = 'webhook_' + event['event_id']
        self.assertEqual(sql(f"SELECT status FROM processed_events WHERE event_id='{event_id}';"),'failed')
        self.assertNotIn('SQL-ERROR-SECRET-MARKER',command('docker','logs',N8N))
        code,retry = self.request(event)
        self.assertEqual(code,409,retry)
        self.assertEqual(retry['status'],'previous_failed')
        self.assertEqual(sql(f"SELECT count(*) FROM failed_events WHERE event_id='{event_id}';"),'1')

    def test_postgres_completion_error_releases_owned_context_and_redacts_error(self):
        external,internal = self.fixture('new')
        event = self.event(user_id=external,text='/help')
        event_id = 'webhook_' + event['event_id']
        name = 'e2e_fail_' + uuid.uuid4().hex
        sql(f"CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
            f"IF NEW.event_id='{event_id}' AND NEW.status='completed' THEN "
            "RAISE EXCEPTION 'SQL-ERROR-SECRET-MARKER'; END IF; RETURN NEW; END; $$;\n"
            f'CREATE TRIGGER {name} BEFORE UPDATE ON processed_events FOR EACH ROW EXECUTE FUNCTION {name}();')
        try:
            code,body = self.request(event)
            self.assertEqual(code,503,body)
            self.assertEqual(body['status'],'failed')
        finally:
            # Remove only this run's newly created fault injection, never data.
            sql(f'DROP TRIGGER {name} ON processed_events; DROP FUNCTION {name}();')
        self.assertEqual(sql(f"SELECT status FROM processed_events WHERE event_id='{event_id}';"),'failed')
        self.assertEqual(sql(f"SELECT processing_lock FROM bot_context WHERE user_id='{internal}';"),'f')
        self.assertEqual(sql(f"SELECT count(*) FROM failed_events WHERE event_id='{event_id}';"),'1')
        rows = sql(f"SELECT row_to_json(t) FROM failed_events t WHERE event_id='{event_id}';")
        self.assertNotIn('SQL-ERROR-SECRET-MARKER',rows)
        self.assertNotIn('SQL-ERROR-SECRET-MARKER',command('docker','logs',N8N))

    def test_postgres_unavailable_returns_503_then_recovers(self):
        external,_ = self.fixture('new')
        event = self.event(user_id=external,text='/help')
        command('docker','stop',PG)
        try:
            code,body = self.request(event)
            self.assertEqual(code,503,body)
            self.assertEqual(body['status'],'failed')
        finally:
            command('docker','start',PG)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    sql('SELECT 1;')
                    break
                except RuntimeError:
                    time.sleep(0.5)
            else:
                self.fail('Test PostgreSQL did not recover')
        # No database can record failure while unavailable before reservation.
        self.assertEqual(sql(f"SELECT count(*) FROM processed_events WHERE event_id='webhook_{event['event_id']}';"),'0')
        self.assert_completed(self.request(event),'support')

    def test_postgres_outage_after_reservation_keeps_fence_until_reviewed_recovery(self):
        external,internal = self.fixture('new')
        event = self.event(user_id=external,text='/help')
        event_id = 'webhook_' + event['event_id']
        app = 'outage_' + uuid.uuid4().hex
        blocker = subprocess.Popen(['docker','exec','-i',PG,'psql','-X','-v','ON_ERROR_STOP=1',
            '-U','disdev','-d',DB,'-At'], stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        blocker.stdin.write(f"SET application_name='{app}'; BEGIN; SELECT user_id FROM bot_context WHERE user_id='{internal}' FOR UPDATE; SELECT pg_sleep(30); COMMIT;")
        blocker.stdin.close()
        try:
            deadline = time.monotonic() + 5
            while sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{app}' AND wait_event='PgSleep';") != '1':
                if time.monotonic() > deadline: self.fail('Test outage lock was not acquired')
                time.sleep(0.05)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(self.request,event)
                deadline = time.monotonic() + 5
                while sql(f"SELECT status FROM processed_events WHERE event_id='{event_id}';") != 'processing':
                    if time.monotonic() > deadline: self.fail('Event was not reserved before outage')
                    time.sleep(0.05)
                command('docker','stop',PG)
                code,body = first.result()
                self.assertEqual(code,503,body)
                self.assertEqual(body['status'],'failed')
        finally:
            command('docker','start',PG)
            blocker.wait(timeout=15)
            blocker.stdout.close()
            blocker.stderr.close()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    sql('SELECT 1;')
                    break
                except RuntimeError:
                    time.sleep(0.5)
        self.assertEqual(sql(f"SELECT status FROM processed_events WHERE event_id='{event_id}';"),'processing')
        self.assertEqual(sql(f"SELECT count(*) FROM failed_events WHERE event_id='{event_id}';"),'0')
        code,busy = self.request(event)
        self.assertEqual(code,409,busy)
        self.assertTrue(busy['busy'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
