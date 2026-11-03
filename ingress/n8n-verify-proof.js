// n8n Code node, before normalization/reservation. Key is runtime env only.
const reject = () => [{json:{body:{},ingress_verified:false,error_code:'ingress_unverified'}}];
try {
  const crypto = require('crypto');
  const key = $env.DIS_GATEWAY_HMAC_KEY;
  const headers = $json.headers ?? {};
  const timestamp = headers['x-dis-proof-time'];
  const signature = headers['x-dis-proof'];
  const body = $json.body;
  if (typeof key !== 'string' || key.length < 32 || !body || typeof body !== 'object' || Array.isArray(body)) return reject();
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return reject();
  const age = Math.floor(Date.now()/1000)-Number(timestamp);
  if (age > 300 || age < -30) return reject();
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
    return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  }
  const expected = crypto.createHmac('sha256',key).update(`dis-core-ingress:v1\n${timestamp}\n${canonical(body)}`).digest();
  if (!crypto.timingSafeEqual(Buffer.from(signature,'hex'),expected)) return reject();
  return [{json:{body,ingress_verified:true}}];
} catch { return reject(); }
