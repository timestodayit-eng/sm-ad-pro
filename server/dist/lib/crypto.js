import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { AppError } from './errors.js';
// scrypt parameters: N=2^15, r=8, p=1 (about 32 MiB, ~100 ms). No native build needed on Hostinger.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function scrypt(pw, salt, len, opts) {
    return new Promise((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}
export async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 64, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt')
        return false;
    const [, n, r, p, saltB64, keyB64] = parts;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT.maxmem,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
}
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('hex');
export const sha256 = (v) => createHash('sha256').update(v).digest('hex');
export const hmac = (secret, v) => createHmac('sha256', secret).update(v).digest('hex');
export function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
/** AES-256-GCM for Meta tokens at rest. Output: base64(iv | tag | ciphertext). */
export function encryptSecret(plain, keyB64) {
    const key = Buffer.from(keyB64, 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}
/**
 * Decrypts a value stored with encryptSecret. AES-GCM refuses to decrypt with another key, so a failure here almost
 * always means the TOKEN_ENCRYPTION_KEY hosting setting is not the one the value was stored with (lost or changed
 * on a redeploy). That is said plainly instead of an "unexpected server error".
 */
export function decryptSecret(payload, keyB64, what = 'this value') {
    try {
        const key = Buffer.from(keyB64, 'base64');
        const buf = Buffer.from(payload, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    }
    catch (err) {
        throw new AppError({
            code: 'ENCRYPTION_KEY_MISMATCH',
            message: `The TOKEN_ENCRYPTION_KEY hosting setting is not the key ${what} was encrypted with.`,
            status: 500,
            category: 'configuration',
            hint: 'Restore the original TOKEN_ENCRYPTION_KEY in the hosting environment (Hostinger → your app → Environment variables) and restart the app. If it is lost for good, sign in with a recovery code, set up two-step login again under Security and reconnect Meta under Ad Accounts.',
            cause: err,
        });
    }
}
//# sourceMappingURL=crypto.js.map