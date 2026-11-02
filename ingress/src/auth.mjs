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

export function extractTelegramUserAndDialogue(update) {
  const from = update?.message?.from ?? update?.callback_query?.from ?? null;
  const chat = update?.message?.chat ?? update?.callback_query?.message?.chat ?? null;
  const user_id = from?.id != null ? String(from.id) : null;
  const dialogue_id = chat?.id != null ? String(chat.id) : user_id;
  let external_event_id = update?.update_id ?? update?.callback_query?.id;
  if (external_event_id === undefined && update?.message?.message_id != null && chat?.id != null) {
    external_event_id = `${chat.id}:${update.message.message_id}`;
  }
  return {
    user_id,
    dialogue_id,
    external_event_id: external_event_id != null ? String(external_event_id) : null,
    text: update?.message?.text,
    callback_data: update?.callback_query?.data,
  };
}
