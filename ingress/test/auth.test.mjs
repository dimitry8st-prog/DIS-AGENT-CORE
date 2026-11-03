import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegramSecret, verifyServiceHmac, extractTelegramUserAndDialogue } from '../src/auth.mjs';
import { buildEventId } from '../src/config.mjs';

test('telegram secret uses timing-safe compare; bot token is not the secret', () => {
  assert.equal(verifyTelegramSecret('abc1234567890123', 'abc1234567890123'), true);
  assert.equal(verifyTelegramSecret('wrong', 'abc1234567890123'), false);
  assert.equal(verifyTelegramSecret(undefined, 'abc1234567890123'), false);
});

test('API service HMAC authenticates the sending service, not the end user', () => {
  const secret = 'test-service-secret-32chars!!';
  const body = Buffer.from('{"user_id":"1"}');
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyServiceHmac(body, sig, secret), true);
  assert.equal(verifyServiceHmac(body, 'sha256=deadbeef', secret), false);
});

test('scoped event ids isolate identical external ids across bots', () => {
  const a = buildEventId('telegram', 'proj_demo', 'bot_a', '42');
  const b = buildEventId('telegram', 'proj_demo', 'bot_b', '42');
  assert.equal(a, 'telegram|proj_demo|bot_a|42');
  assert.notEqual(a, b);
});

test('telegram extraction keeps dialogue for private and group chats', () => {
  const privateChat = extractTelegramUserAndDialogue({
    update_id: 42,
    message: { from: { id: 7 }, chat: { id: 7, type: 'private' }, text: 'hi' },
  });
  assert.equal(privateChat.external_event_id, '42');
  assert.equal(privateChat.dialogue_id, '7');
  const group = extractTelegramUserAndDialogue({
    update_id: 43,
    message: { from: { id: 7 }, chat: { id: -100123, type: 'supergroup' }, text: 'hi' },
  });
  assert.equal(group.dialogue_id, '-100123');
  assert.equal(group.user_id, '7');
});
