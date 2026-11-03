# HARDENING REPORT — independent-review fixes

Date: 2026-11-03. Branch: `hardening/scoped-ingress`. PR: https://github.com/dimitry8st-prog/DIS-AGENT-CORE/pull/1

## Baseline and scope

Started from the actual remote tip `91be8829dc4d5d22aae39f97d13d0f62573d601a`.
The original working copy was clean and preserved; implementation used a separate
worktree. No AGENTS.md exists in the checked revision. No production credentials,
remote data, locks or services were changed. No merge or deployment was performed.

Historical results dated 2026-10-10 are not treated as current PASS evidence.
This report accompanies the review-fix commit; resolve its exact tip with
`git rev-parse HEAD` rather than recursively committing a report containing its own SHA.

## Findings, reproduction, and fixes

| Review item | Before on 91be882 | Implemented result |
|---|---|---|
| Foreign context | Actual router/Safe Response Code bodies: rejected=true → support → HTTP 200/completed | Router stops normal routing; HTTP 403/rejected; no foreign context state/payload disclosed |
| Internal authenticity | Fabricated authenticated_source passed Normalize Input | Full-contract HMAC verified by first n8n Code node before reservation; no proof/wrong key/tampering rejected |
| Numeric ID coercion | Raw HTTP JSON with user ID 9007199254740993 returned 200 after rounding | Safe-integer check precedes String; malformed, fractional, unsafe and out-of-range IDs rejected |
| Upgrade path | No forward migration; installed 003 from 2c8b750 could re-reserve a migrated legacy event | New 004 upgrades both 003 variants and fresh schema; legacy ID/status/correlation retained |
| Real n8n E2E | CI job only echoed BLOCKED and exited successfully; Compose default silently used 1.70.1 | Actual isolated Docker runner in CI, exact n8n 2.42.6+digest, gateway → imported workflows → PostgreSQL → HTTP, then reimport |

The new three finding regressions were run against the unmodified baseline:
**FAIL 3/3** (route support instead of unknown; forged flag accepted; unsafe HTTP
number accepted). After implementation these regressions pass. The full before
context output was also reproduced as `{route:support,http:200,status:completed}`.
Additional proof/key tests extend coverage rather than replacing the baseline assertions.

### Context denial and reservation lifecycle

SQL already produced `context.rejected=true` on a different context owner. WF-04
now routes unknown/user_scope_mismatch; Safe Response returns 403/rejected and
omits foreign state/payload. The event's own reservation is completed terminally:
this means the rejection was handled, not that a business action succeeded.
A repeat returns duplicate with the existing correlation. The foreign lock owner
and state are unchanged. This path is verified through the imported n8n nodes,
not only by mocking the SQL response.

### Authenticated internal hop

The gateway creates a canonical JSON HMAC with a versioned domain prefix and
signed timestamp. All meaningful contract fields, including payload/project/bot/
user/dialogue/event/source, are covered. The key is a separate runtime secret,
not a workflow literal or request header. External and internal keys must differ.
Direct body flags are insufficient. Valid redelivery remains idempotent; proofs
older than 300s or more than 30s into the future are rejected. Gateway re-signs
legitimate late external retries. Keep clocks synchronized.

For n8n 2.42.6 the tested Code runtime requires `crypto` allowed and environment
access enabled. n8n remains private, with host ports bound only to loopback in
the test stand. Only trusted administrators may edit n8n workflows/runtime;
this mechanism does not isolate a key from an administrator who can execute
arbitrary Code nodes. Only an explicit header allowlist is forwarded and upstream
redirects are rejected. The internal key and external credential were searched
for in actual n8n execution_data and were absent.

### Forward migration

003 is byte-for-byte unchanged. Apply 004 after 001/002/003. 004 does not run
legacy mapping automatically or reset/replay old events. It installs the unique
confirmed-scope guard and updated reservation/mapping helpers. Duplicate confirmed
rows abort migration atomically; runtime duplicate-scope and conflicting event-key
lookups explicitly refuse rather than selecting an arbitrary row.

Upgrade tests cover fresh schema, 003 from 2c8b750, and 003 from 91be882, repeated
004, completed/processing/failed, data preservation, conflicting rows and concurrency.
A separate before/after SQL reproduction confirms 2c8b750 acquired a second legacy
reservation, while 004 returns duplicate with the original correlation. The same
reproduction preserves the already-correct behavior of 91be882.

## Verification commands and status

| Command / observation | Status |
|---|---|
| Original JS/ingress/import suites before changes | PASS 24 |
| Added baseline finding regressions before changes | FAIL 3, expected reproductions |
| `node --test tests/workflows.test.mjs tests/prepare_import.test.mjs tests/review_regressions.test.mjs ingress/test/*.test.mjs` | PASS 29 |
| `DIS_TEST_PSQL_DOCKER=OWNED_TEST_CONTAINER node --test tests/sql_scoped.test.mjs tests/migration_upgrade.test.mjs` | PASS 12 |
| `python3 tests/run_review_e2e.py`, first import | PASS 7 functional scenarios + EXPECTED_FAILURE 1 (physical retention row) |
| Same runner, reimport and second full HTTP pass | PASS 7 functional scenarios + EXPECTED_FAILURE 1 (physical retention row) |
| Strict physical input-retention assertion | EXPECTED_FAILURE; not removed or filtered by deletedAt |
| Production deployment, production data/secret access | NOT RUN, outside scope |
| Independent PR acceptance / merge | Not performed; reserved for reviewer |

Runner requires Docker and exact n8n 2.42.6, checks CLI version, creates fresh
private resources and cleans up only those resources. Failure to obtain the
required stand is BLOCKED with nonzero exit. CI no longer reports an echo-only
step as E2E. Each SQL suite invocation creates fresh uniquely named test databases;
fixtures including deliberate conflicts are preserved, not cleared to make a
re-run green.

Early runner attempts failed on a changing Docker-assigned host port after
restart and on psql command-tag parsing in a fixture. Both runner defects were
corrected before the successful full pass; they are not counted as E2E success.
A first SQL re-run against retained conflict fixtures also failed; per-run database
isolation fixed that without weakening conflict assertions or deleting rows.

## Confidentiality and remaining limits

The strict existing retention test in tests/test_e2e.py is unchanged. The new real
E2E additionally performs the same zero-physical-row assertion on a marker placed
in pre-sanitization input, with no manual deletion, pruning change, or deletedAt
filter. Failures of that assertion are reported separately as EXPECTED_FAILURE,
not a functional PASS. This does not establish the absence of arbitrary secrets
on n8n disk; free text may contain sensitive content. Full confidentiality remains
an architectural limitation and is not declared fixed by this PR.

The isolated stand verifies functionality and imports, not production deployment,
all future versions, or third-party authentication of an end user. API credentials
authenticate a service explicitly allowed to assert user IDs. Live credentials,
public editor exposure and business actions remain outside this task.

Evidence: docs/review-validation.json contains actual final results, before/after
upgrade observations, image/version, and hashes of tested source files. The exact
updated PR SHA is provided in the final handoff. Independent verdict is left to
the reviewer.
