import crypto from 'crypto';
import { createComponentLogger } from '../lib/logger';

const log = createComponentLogger('encryption-service');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

/**
 * Get the encryption key from env.
 * Returns null if not configured (dev fallback: store plaintext with prefix).
 */
function getKey(): Buffer | null {
    const hex = process.env.ENCRYPTION_KEY;
    if (!hex) return null;
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
        log.warn({ length: buf.length }, 'ENCRYPTION_KEY must be 32 bytes (64 hex chars); disabling encryption');
        return null;
    }
    return buf;
}

const PLAINTEXT_PREFIX = 'UNENCRYPTED:';

/**
 * Encrypt a plaintext string.
 * Returns "base64(iv):base64(authTag):base64(ciphertext)".
 * If ENCRYPTION_KEY not set, stores as "UNENCRYPTED:<plaintext>" with a warning.
 */
export function encrypt(plaintext: string): string {
    const key = getKey();
    if (!key) {
        log.warn('ENCRYPTION_KEY not set — storing API key in plaintext (dev only)');
        return `${PLAINTEXT_PREFIX}${plaintext}`;
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted.toString('base64'),
    ].join(':');
}

/**
 * Decrypt a stored string produced by encrypt().
 * Returns the original plaintext.
 */
export function decrypt(stored: string): string {
    if (stored.startsWith(PLAINTEXT_PREFIX)) {
        return stored.slice(PLAINTEXT_PREFIX.length);
    }

    const key = getKey();
    if (!key) {
        throw new Error('ENCRYPTION_KEY not set but stored value is encrypted');
    }

    const parts = stored.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted format — expected "iv:authTag:ciphertext"');
    }

    const [ivB64, authTagB64, encryptedB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encryptedBuf = Buffer.from(encryptedB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(authTag);

    return decipher.update(encryptedBuf).toString('utf8') + decipher.final('utf8');
}
