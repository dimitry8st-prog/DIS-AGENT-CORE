# HARDENING REPORT — scoped ingress (02.11.2026)

## Baseline

| Item | Value |
|---|---|
| Repo | https://github.com/dimitry8st-prog/DIS-AGENT-CORE |
| Base main SHA | `95b823dc69b93ae12ab8c22c0d0abd65d87b71a0` (10.10.2026) |
| Branch | `hardening/scoped-ingress` |
| AGENTS.md | absent |
| Baseline JS tests | 10/10 PASS before changes |

## Changes (summary)

1. **ingress/** — Telegram webhook secret + API HMAC service auth; source→project/bot binding; rate/size/timeout; loopback upstream only; secret headers stripped.
2. **db/003_scoped_ingress.sql** — scoped columns, `bot_context_scoped`, legacy map + dry-run/apply; updated `dis_core_*` functions with scope checks.
3. **WF-00** — accepts only `ingress.authenticated_source` contract; composite `event_id`.
4. **tests** — workflow (11), ingress (10), SQL scoped (2) + CI.
5. **Docs** — README, STUCK_EVENT_DIAGNOSIS, this report, RETURN_REPORT.

## Results

| Check | Result |
|---|---|
| `node --test tests/workflows.test.mjs` | PASS (11) |
| `node --test ingress/test/*.test.mjs` | PASS (10) |
| `DIS_TEST_PSQL_DOCKER=… node --test tests/sql_scoped.test.mjs` | PASS (2) on local `postgres:16` |
| Migration 003 re-apply | PASS |
| Legacy map dry-run / apply preserves status | PASS |
| Cross-bot same external id independent | PASS |
| Cross-project context locks independent | PASS |
| Missing/wrong/foreign credential before upstream | PASS |
| Scope spoof reject | PASS |
| `tests/run_cloud.py` / full n8n 2.42.6 E2E | **NOT RUN** (must not on shared infra; private image) → **BLOCKED** |
| n8n soft-delete physical retention | **EXPECTED_FAILURE** (unchanged; not weakened) |

## Confidentiality guarantee (honest)

- Achieved: credentials rejected/stripped at ingress; not forwarded to n8n; responses/logs allowlisted in WF Safe Response path.
- Residual: n8n internal execution_data soft-delete; free-text PII/secrets inside message text.

## Next technical step

1. Wire ingress in front of a private n8n 2.42.6 stand; re-run soft-delete probe as EXPECTED_FAILURE.
2. Operator-filled legacy maps for any pre-scope production-like data.
3. Do **not** claim production-ready; no payments/LLM/registration in this stage.
