import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptApiKey, decryptApiKey } from '../src/crypto';
import { SafeProviderError } from '../src/safe-http';

const secret = randomBytes(32).toString('base64');
const raw = 'sk-private-test-fixture-never-an-actual-key';
const owner = 'test-user-1';
function safeFailure(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SafeProviderError);
    assert.equal(error.code, code);
    assert.equal('cause' in error, false);
    const exposed = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    assert.equal(exposed.includes(raw), false);
    assert.equal(exposed.includes(secret), false);
    return true;
  });
}

test('AES-256-GCM round-trip uses random nonce and never stores plaintext', () => {
  const one = encryptApiKey(raw, owner, secret);
  const two = encryptApiKey(raw, owner, secret);
  assert.notEqual(one, two);
  assert.match(one, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  assert.equal(one.includes(raw), false);
  assert.equal(decryptApiKey(one, owner, secret), raw);
  assert.equal(decryptApiKey(two, owner, secret), raw);
});

test('encrypted key is authenticated to its owner and encryption secret', () => {
  const cipher = encryptApiKey(raw, owner, secret);
  safeFailure(() => decryptApiKey(cipher, 'other-user', secret), 'KEY_DECRYPTION_FAILED');
  safeFailure(() => decryptApiKey(cipher, owner, randomBytes(32).toString('base64')), 'KEY_DECRYPTION_FAILED');
});

test('nonce, tag, ciphertext, version and truncation tampering are rejected', () => {
  const original = encryptApiKey(raw, owner, secret);
  for (const index of [1, 2, 3]) {
    const parts = original.split('.');
    const value = Buffer.from(parts[index], 'base64url');
    value[0] ^= 0x01;
    parts[index] = value.toString('base64url');
    safeFailure(() => decryptApiKey(parts.join('.'), owner, secret), 'KEY_DECRYPTION_FAILED');
  }
  for (const cipher of ['', original.replace('v1.', 'v2.'), original.slice(0, -2), original + '.extra', 'v1.eA.eA.eA']) {
    safeFailure(() => decryptApiKey(cipher, owner, secret), 'KEY_DECRYPTION_FAILED');
  }
});

test('encryption secret must be canonical base64 and exactly 32 bytes', () => {
  for (const invalid of ['', 'x'.repeat(32), randomBytes(16).toString('base64'), secret + '\n', secret.replace(/=$/, ''), '*'.repeat(43) + '=']) {
    safeFailure(() => encryptApiKey(raw, owner, invalid), 'ENCRYPTION_CONFIGURATION');
    safeFailure(() => decryptApiKey('invalid', owner, invalid), 'ENCRYPTION_CONFIGURATION');
  }
});

test('empty owner and unsafe or oversize key are rejected without leaking input', () => {
  safeFailure(() => encryptApiKey(raw, '', secret), 'KEY_ENCRYPTION_FAILED');
  for (const invalid of ['', 'sk-header\r\ninjection', 'x'.repeat(4097)]) {
    safeFailure(() => encryptApiKey(invalid, owner, secret), 'KEY_ENCRYPTION_FAILED');
  }
});
