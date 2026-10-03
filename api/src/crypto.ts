import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SafeProviderError } from './safe-http';

function encryptionKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    throw new SafeProviderError('ENCRYPTION_CONFIGURATION');
  }
  const key = Buffer.from(secret, 'base64');
  if (key.length !== 32 || key.toString('base64') !== secret) throw new SafeProviderError('ENCRYPTION_CONFIGURATION');
  return key;
}

function context(userId: string): Buffer {
  if (typeof userId !== 'string' || !userId || userId.length > 200) throw new Error();
  return Buffer.from(`travelfolio:provider-api-key:v1:${userId}`, 'utf8');
}

/** AES-256-GCM with fresh 96-bit nonce and user-bound additional authenticated data. */
export function encryptApiKey(raw: string, userId: string, secret: string): string {
  const key = encryptionKey(secret);
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(context(userId));
    const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  } catch { throw new SafeProviderError('KEY_ENCRYPTION_FAILED'); }
  finally { key.fill(0); }
}

export function decryptApiKey(ciphertext: string, userId: string, secret: string): string {
  const key = encryptionKey(secret);
  try {
    if (typeof ciphertext !== 'string' || ciphertext.length > 24_000) throw new Error();
    const parts = ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const [nonce, tag, encrypted] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
    if (nonce.length !== 12 || tag.length !== 16 || !encrypted.length ||
        [nonce, tag, encrypted].some((p, i) => p.toString('base64url') !== parts[i + 1])) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(context(userId));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    try {
      const raw = plain.toString('utf8');
      if (!raw || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error();
      return raw;
    } finally { plain.fill(0); }
  } catch { throw new SafeProviderError('KEY_DECRYPTION_FAILED'); }
  finally { key.fill(0); }
}
