# Ingress gateway (trusted source layer)

HTTP entry **in front of** n8n WF-00. Authenticates the **sending endpoint/service**, not the end user.

## Auth modes

| Channel | Credential | Header |
|---|---|---|
| Telegram | Webhook `secret_token` (≠ bot API token) | `X-Telegram-Bot-Api-Secret-Token` |
| Web/API | HMAC-SHA256 of raw body | `X-DIS-Signature: sha256=<hex>` |

`project_id`, `bot_id`, `channel` come only from server-side source config. Client fields cannot override them.

Without configured sources / secrets the process refuses to start (closed by default).

## Run (loopback only)

```sh
cp config/sources.example.json /secure/path/sources.json
# set TELEGRAM_BOT_A_WEBHOOK_SECRET, TELEGRAM_BOT_B_WEBHOOK_SECRET, API_SERVICE_HMAC_SECRET (>=16 chars)
set DIS_INGRESS_CONFIG=/secure/path/sources.json
node src/server.mjs
```

Upstream `n8n_upstream_url` must be loopback. Secret headers are never forwarded.

## Tests

```sh
node --test test/*.test.mjs
```
