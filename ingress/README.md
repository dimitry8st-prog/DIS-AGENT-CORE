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
# set a DIFFERENT DIS_GATEWAY_HMAC_KEY (>=32 chars) in gateway AND private n8n runtime
set DIS_INGRESS_CONFIG=/secure/path/sources.json
node src/server.mjs
```

Upstream `n8n_upstream_url` must be loopback. Secret headers are never forwarded.

## Tests

```sh
node --test test/*.test.mjs
```

## Authenticated internal hop

Gateway signs the complete canonical JSON contract, not a client-provided flag.
`x-dis-proof-time` and `x-dis-proof` carry the timestamp and HMAC, never the key.
The n8n `Verify Ingress Proof` Code node authenticates these before WF-00 reserves
an event; mismatches/missing proof return 401. Changing project, bot, user,
dialogue, event or payload invalidates the proof. Key is runtime env only;
allow crypto and `$env` in this private n8n instance as documented in root README.
Never give untrusted users workflow-editor access or open the n8n webhook publicly.
Service authentication still does not itself authenticate the end user.

IDs are validated before coercion. Numeric values must be safe integers;
numeric string IDs must fit signed BIGINT, and Telegram update/message IDs must
be nonnegative. Opaque API event/dialogue strings have a 160-character allowlist.
