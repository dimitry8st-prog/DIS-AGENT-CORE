# HARDENING REPORT — scoped ingress

Verification date of this report: **2026-11-03**.  
Historical cloud validation results from **2026-10-10** remain in `docs/CORE_WORKFLOWS_REPORT.md` / `docs/validation-results.json` and are **not** reused as today’s PASS evidence.

## Baseline

| Item | Value |
|---|---|
| Repo | https://github.com/dimitry8st-prog/DIS-AGENT-CORE |
| Base main SHA | `95b823dc69b93ae12ab8c22c0d0abd65d87b71a0` |
| Docs pilot branch | `docs/antigravity-codex-pilot` @ `fb2cfbf` (unchanged by this work) |
| Work branch | `hardening/scoped-ingress` |
| AGENTS.md | absent |
| Reviewed tip (Request changes) | `2c8b750` |
| Prior branch tip before this continuation | `2c8b750` |

## Implemented in code

1. **ingress/** — Telegram webhook secret (`X-Telegram-Bot-Api-Secret-Token`, ≠ bot token) + API HMAC service auth; server-bound `project_id`/`bot_id`/`channel`; closed without config; body/rate/timeout limits; secret headers stripped; loopback upstream only.
2. **db/003_scoped_ingress.sql** — additive scope columns, `bot_context_scoped`, legacy maps + dry-run/apply; partial unique on confirmed scope identity; `dis_core_reserve` matches by scope (legacy `tg_42` ≡ WF-00 composite) under advisory lock + unique index; apply refuses `scope_identity_conflicts` without deletes; no rewrite of 001/002; no mass unlock/retry; no auto-assign of unknown scope.
3. **WF-00** — accepts only `ingress.authenticated_source` contract; composite `event_id = channel|project|bot|external`.
4. **prepare-import.py** — rejects public webhook exposure; writes `INGRESS_CONTRACT.json`.
5. **tests + CI + teststand** — JS/ingress/SQL/prepare-import; GitHub Actions without production secrets.
6. **docs/STUCK_EVENT_DIAGNOSIS.md** — operator evidence before any recovery.

## Results (2026-11-03 run)

| Check | Result |
|---|---|
| `node --test tests/workflows.test.mjs tests/prepare_import.test.mjs` | **PASS** (13) |
| `node --test ingress/test/*.test.mjs` | **PASS** (11) |
| `DIS_TEST_PSQL_DOCKER=teststand-postgres-1 node --test tests/sql_scoped.test.mjs` | **PASS** (8) on isolated `postgres:16` |
| Migration 003 re-apply | **PASS** |
| Legacy scope apply → composite `event_id` must not re-reserve | **PASS** (regression; BEFORE acquired=true → AFTER duplicate) |
| Concurrent reserve one-scope | **PASS** (exactly one acquired) |
| Concurrent distinct `event_id`, same confirmed scope | **PASS** (exactly one acquired) |
| Dry-run `scope_identity_conflicts`; apply refuses without deletes | **PASS** |
| Unknown / blocked user; expired context; foreign lock | **PASS** |
| DB fault before reserve (no row) / after reserve (stays `processing`) | **PASS** (isolated DB only) |
| Credential / secret markers in Safe Response & ingress responses | **PASS** |
| `tests/run_cloud.py` on shared infra | **NOT RUN → BLOCKED** (stops Postgres / fault-injects shared service) |
| Full n8n 2.42.6 E2E soft-delete probe | **BLOCKED** (private image); known limitation remains **EXPECTED_FAILURE** and was **not** weakened |

## Confidentiality (honest)

- **Achieved:** credentials rejected/stripped at ingress before n8n; secret headers not forwarded; HTTP/Safe Response allowlist; SQL logs store `{}` payload.
- **Residual / open:** n8n `save=none` soft-delete of input in `execution_data` until pruning (EXPECTED_FAILURE). Free-text message body may still contain PII/secrets — ingress does not scrub message text.

## Migration / rollback

```sh
psql … -f db/001_core.sql
psql … -f db/002_core_processing.sql
psql … -f db/003_scoped_ingress.sql
SELECT dis_core_legacy_event_scope_dry_run();  -- then explicit map, then apply
```

Rollback without data loss: stop ingress, unpublish WF-00; leave tables/data; do not DROP/TRUNCATE/`processed_events` mass-reset.

## Next technical step

Wire ingress to a **private** n8n 2.42.6 stand; re-run soft-delete probe as EXPECTED_FAILURE; fill legacy maps only with operator evidence. Do not claim production-ready.
