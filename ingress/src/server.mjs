import http from 'node:http';
import { loadConfig, buildEventId } from './config.mjs';
import {
  verifyTelegramSecret,
  verifyServiceHmac,
  extractTelegramUserAndDialogue,
  integerId,
  contractId,
} from './auth.mjs';
import { signInternal } from './internal-proof.mjs';
import { createRateLimiter } from './rate-limit.mjs';

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!settled) {
          settled = true;
          reject(Object.assign(new Error('payload_too_large'), { code: 413 }));
        }
        // Drain without destroying so the handler can still send HTTP 413.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function clientKey(req) {
  return req.socket.remoteAddress || 'unknown';
}

export function createServer(config) {
  if (typeof config.internal_proof_secret !== 'string' || config.internal_proof_secret.length < 32) throw new Error('missing internal proof key');
  if([...config.sources.values()].some(source=>source.secret===config.internal_proof_secret)) throw new Error('internal key must differ from external credentials');
  const allow = createRateLimiter(config.rate_limit);

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return json(res, 200, { ok: true, role: 'ingress' });
      }
      if (req.method !== 'POST') {
        return json(res, 405, { ok: false, error: 'method_not_allowed' });
      }

      const url = new URL(req.url, 'http://ingress.local');
      const source = config.sources.get(url.pathname);
      if (!source) {
        return json(res, 404, { ok: false, error: 'unknown_source' });
      }

      if (!allow(`${source.id}:${clientKey(req)}`)) {
        return json(res, 429, { ok: false, error: 'rate_limited' });
      }

      const raw = await readBody(req, config.max_body_bytes);
      if (source.channel === 'telegram') {
        const token = req.headers['x-telegram-bot-api-secret-token'];
        if (!verifyTelegramSecret(token, source.secret)) {
          return json(res, 401, { ok: false, error: 'unauthorized' });
        }
      } else if (source.channel === 'api') {
        if (!verifyServiceHmac(raw, req.headers['x-dis-signature'], source.secret)) {
          return json(res, 401, { ok: false, error: 'unauthorized' });
        }
      } else {
        return json(res, 400, { ok: false, error: 'unsupported_channel' });
      }

      let body;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: 'invalid_json' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res,400,{ok:false,error:'invalid_json_object'});

      // Client-supplied project/bot/channel must not override trusted source binding.
      if (
        (body.project_id && body.project_id !== source.project_id) ||
        (body.bot_id && body.bot_id !== source.bot_id) ||
        (body.channel && body.channel !== source.channel)
      ) {
        return json(res, 403, { ok: false, error: 'scope_mismatch' });
      }

      let user_id;
      let dialogue_id;
      let external_event_id;
      let payload = {};

      if (source.channel === 'telegram') {
        const extracted = extractTelegramUserAndDialogue(body);
        user_id = extracted.user_id;
        dialogue_id = extracted.dialogue_id;
        external_event_id = extracted.external_event_id;
        payload = {
          text: extracted.text,
          callback_data: extracted.callback_data,
        };
      } else {
        // Service may assert external user_id only when explicitly allowed for this source.
        if (!source.may_assert_user_id) {
          return json(res, 403, { ok: false, error: 'user_assertion_forbidden' });
        }
        user_id = body.user_id != null ? integerId(body.user_id) : null;
        dialogue_id =
          body.dialogue_id != null
            ? contractId(body.dialogue_id)
            : user_id;
        external_event_id =
          body.external_event_id != null
            ? contractId(body.external_event_id)
            : body.event_id != null
              ? contractId(body.event_id)
              : null;
        payload = body.payload ?? {};
      }

      if (!user_id || !dialogue_id || !external_event_id) {
        return json(res, 400, { ok: false, error: 'missing_identity_or_event' });
      }

      const event_id = buildEventId(
        source.channel,
        source.project_id,
        source.bot_id,
        external_event_id,
      );

      const trusted = {
        event_id,
        external_event_id: String(external_event_id),
        channel: source.channel,
        project_id: source.project_id,
        bot_id: source.bot_id,
        source_id: source.id,
        user_id: String(user_id),
        dialogue_id: String(dialogue_id),
        payload,
        ingress: {
          authenticated_source: true,
          end_user_authenticated: false,
          note:
            'Service/webhook credential verifies the trusted sender endpoint, not end-user identity.',
        },
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.upstream_timeout_ms);
      try {
        const upstreamHeaders = {
          'content-type': 'application/json',
          'x-dis-ingress': '1',
          'x-dis-source-id': source.id,
          ...signInternal(trusted, config.internal_proof_secret),
        };
        // Outbound headers are an explicit allowlist; client headers never pass through.
        const upstreamRes = await fetch(config.n8n_upstream_url, {
          method: 'POST',
          redirect: 'error',
          headers: upstreamHeaders,
          body: JSON.stringify(trusted),
          signal: controller.signal,
        });
        const text = await upstreamRes.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { ok: false, error: 'upstream_non_json', status: upstreamRes.status };
        }
        return json(res, upstreamRes.status, parsed);
      } catch (err) {
        const status = err?.name === 'AbortError' ? 504 : 502;
        return json(res, status, { ok: false, error: 'upstream_unavailable' });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (err?.code === 400) return json(res, 400, { ok: false, error: 'invalid_id' });
      if (err?.code === 413) return json(res, 413, { ok: false, error: 'payload_too_large' });
      // Never leak internals or secrets.
      return json(res, 500, { ok: false, error: 'internal_error' });
    }
  });
}

function main() {
  const config = loadConfig();
  if (config.bind !== '127.0.0.1' && config.bind !== 'localhost') {
    throw new Error('ingress must bind loopback only in this stage');
  }
  const server = createServer(config);
  server.listen(config.port, config.bind, () => {
    // eslint-disable-next-line no-console
    console.log(`ingress listening on http://${config.bind}:${config.port}`);
  });
}

const entry = process.argv[1] || '';
if (entry.endsWith('server.mjs')) {
  main();
}

export { main };
