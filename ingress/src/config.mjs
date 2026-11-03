import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.length < 16) {
    throw new Error(`missing or weak secret env: ${name}`);
  }
  return value;
}

export function loadConfig(path = process.env.DIS_INGRESS_CONFIG) {
  if (!path) {
    throw new Error('DIS_INGRESS_CONFIG is required; refusing to start with open ingress');
  }
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    throw new Error('sources[] must be non-empty; refuse open ingress');
  }
  const upstream = raw.n8n_upstream_url;
  if (!upstream || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(upstream)) {
    throw new Error('n8n_upstream_url must target loopback only');
  }
  const sources = new Map();
  for (const source of raw.sources) {
    if (!ID.test(source.project_id) || !ID.test(source.bot_id) || !ID.test(source.id)) {
      throw new Error(`invalid project_id/bot_id/id for source ${source.id}`);
    }
    if (!source.path?.startsWith('/ingress/')) {
      throw new Error(`source path must start with /ingress/: ${source.id}`);
    }
    if (sources.has(source.path)) throw new Error(`duplicate path ${source.path}`);
    const secret = requireEnv(source.secret_env);
    sources.set(source.path, {
      ...source,
      channel: source.channel,
      secret,
      may_assert_user_id: source.channel === 'api' ? Boolean(source.may_assert_user_id) : false,
    });
  }
  const internalKey=requireEnv('DIS_GATEWAY_HMAC_KEY');
  if(internalKey.length<32) throw new Error('weak internal proof key');
  if([...sources.values()].some(source=>source.secret===internalKey)) throw new Error('internal key must differ from external credentials');
  return {
    internal_proof_secret: internalKey,
    bind: raw.bind ?? '127.0.0.1',
    port: Number(raw.port ?? 8080),
    max_body_bytes: Number(raw.max_body_bytes ?? 65536),
    upstream_timeout_ms: Number(raw.upstream_timeout_ms ?? 15000),
    rate_limit: {
      window_ms: Number(raw.rate_limit?.window_ms ?? 60000),
      max: Number(raw.rate_limit?.max ?? 120),
    },
    n8n_upstream_url: upstream,
    sources,
  };
}

export function buildEventId(channel, projectId, botId, externalKey) {
  // Pipe separator is forbidden inside validated ID segments.
  return `${channel}|${projectId}|${botId}|${externalKey}`;
}
