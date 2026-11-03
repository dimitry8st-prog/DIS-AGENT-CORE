import { createHmac } from 'node:crypto';

// Versioned, domain-separated canonical JSON. Sign every contract field.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
export function signInternal(body, key, timestamp = String(Math.floor(Date.now()/1000))) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('missing internal proof key');
  const mac = createHmac('sha256', key).update(`dis-core-ingress:v1\n${timestamp}\n${canonicalJson(JSON.parse(JSON.stringify(body)))}`).digest('hex');
  return {'x-dis-proof-time':timestamp, 'x-dis-proof':mac};
}
