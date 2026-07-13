import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

export function encrypt(text: string): string {
    const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    if (!encryptionKey) {
        throw new Error('TOKEN_ENCRYPTION_KEY is not defined in environment variables');
    }

    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a string encrypted with the encrypt function.
 */
export function decrypt(hash: string): string {
    const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    if (!encryptionKey) {
        throw new Error('TOKEN_ENCRYPTION_KEY is not defined in environment variables');
    }

    const parts = hash.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted hash format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');

    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted as any, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Generates a random 32-character hex secret for use as an HMAC key.
 */
export function generateWebhookSecret(): string {
    return crypto.randomBytes(32).toString('hex');
}
