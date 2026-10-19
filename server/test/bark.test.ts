import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { it } from 'node:test';
import { encryptForBark } from '../src/integrations/bark.js';

it('encrypts so the Bark app (AES-256-CBC, text IV) can decrypt', () => {
  const key = 'k'.repeat(32);
  const { ciphertext, iv } = encryptForBark({ title: 'Hi', body: 'there' }, key);
  assert.match(iv, /^[A-Za-z0-9]{16}$/);
  const d = createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
  const plain = Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString();
  assert.deepEqual(JSON.parse(plain), { title: 'Hi', body: 'there' });
});
