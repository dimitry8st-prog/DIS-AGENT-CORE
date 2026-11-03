import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Telegram Bot API webhook secret_token header. Not the bot API token. */
export function verifyTelegramSecret(headerValue, configuredSecret) {
  return safeEqual(headerValue, configuredSecret);
}

/**
 * Trusted sending-service authentication for Web/API.
 * Header: X-DIS-Signature: sha256=<hex hmac of raw body>
 * This authenticates the calling service, not the end user.
 */
export function verifyServiceHmac(rawBody, headerValue, configuredSecret) {
  if (typeof headerValue !== 'string' || !headerValue.startsWith('sha256=')) return false;
  const provided = headerValue.slice('sha256='.length);
  const expected = createHmac('sha256', configuredSecret).update(rawBody).digest('hex');
  return safeEqual(provided, expected);
}

export function integerId(value, signed = true) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Object.assign(new Error('invalid_id'), {code:400});
  if (typeof value !== 'number' && typeof value !== 'string') throw Object.assign(new Error('invalid_id'), {code:400});
  const text=String(value);
  if (!/^(?:0|-?[1-9]\d{0,19})$/.test(text)) throw Object.assign(new Error('invalid_id'), {code:400});
  const id=BigInt(text);
  if (id < (signed ? -9223372036854775808n : 0n) || id > 9223372036854775807n) throw Object.assign(new Error('invalid_id'), {code:400});
  return text;
}

export function contractId(value) {
  if (typeof value === 'number') return integerId(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw Object.assign(new Error('invalid_id'), {code:400});
  if (/^-?\d+$/.test(value)) return integerId(value);
  return value;
}

export function extractTelegramUserAndDialogue(update) {
  const from = update?.message?.from ?? update?.callback_query?.from ?? null;
  const chat = update?.message?.chat ?? update?.callback_query?.message?.chat ?? null;
  const user_id = from?.id != null ? integerId(from.id) : null;
  const dialogue_id = chat?.id != null ? integerId(chat.id) : user_id;
  let external_event_id = update?.update_id ?? update?.callback_query?.id;
  if (update?.update_id != null) external_event_id=integerId(update.update_id, false);
  else if (external_event_id != null) external_event_id=contractId(external_event_id);
  if (external_event_id === undefined && update?.message?.message_id != null && chat?.id != null) {
    external_event_id = `${integerId(chat.id)}:${integerId(update.message.message_id, false)}`;
  }
  return {
    user_id,
    dialogue_id,
    external_event_id: external_event_id != null ? String(external_event_id) : null,
    text: update?.message?.text,
    callback_data: update?.callback_query?.data,
  };
}
