#!/usr/bin/env python3
"""Install, validate SQL and execute the real chain twice, including reimport."""
import json
import hashlib
import unittest
from datetime import datetime, timezone

from cloud_setup import ARTIFACTS, ROOT, reimport, setup


def suite(pattern):
    tests = unittest.defaultTestLoader.discover(str(ROOT/'tests'), pattern=pattern)
    result = unittest.TextTestRunner(verbosity=2).run(tests)
    return result, {
        'executed':result.testsRun,
        'passed':result.testsRun - len(result.failures) - len(result.errors)
            - len(result.expectedFailures) - len(result.skipped) - len(result.unexpectedSuccesses),
        'failed':[case.id() for case,_ in result.failures],
        'errors':[case.id() for case,_ in result.errors],
        'expected_failures':[case.id() for case,_ in result.expectedFailures],
        'skipped':[case.id() for case,_ in result.skipped],
        'unexpected_successes':[case.id() for case in result.unexpectedSuccesses],
    }


def main():
    setup()
    hashes = {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
              for directory in ['workflows','db'] for p in sorted((ROOT/directory).glob('*')) if p.is_file()}
    results = {'completed_at_utc':None,'n8n_version':'2.42.6',
               'database':'dis_core_workflows_test','source_sha256':hashes}
    for phase,pattern in [('sql','test_sql.py'),('first_import','test_e2e.py'),('reimport','test_e2e.py')]:
        if phase == 'reimport':
            reimport()
        result,summary = suite(pattern)
        results[phase] = summary
        if not result.wasSuccessful():
            (ARTIFACTS/'results.json').write_text(json.dumps(results,indent=2)+'\n')
            return 1
    results['completed_at_utc'] = datetime.now(timezone.utc).isoformat()
    (ARTIFACTS/'results.json').write_text(json.dumps(results,indent=2)+'\n')
    print('Functional checks completed for both imports. Internal n8n input retention remains an expected failure.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
