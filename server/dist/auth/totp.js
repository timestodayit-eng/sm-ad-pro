import { createHmac, randomBytes, randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { sha256, safeEqual } from '../lib/crypto.js';
/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits): what Google Authenticator, Microsoft Authenticator and Authy use. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0)
        out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}
export function base32Decode(s) {
    const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}
export const newSecret = () => base32Encode(randomBytes(20));
export function hotp(secret, counter) {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
    const off = h[h.length - 1] & 0xf;
    const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % 1_000_000).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);
/**
 * Checks a code against the previous, current and next 30 s window (clock drift).
 * Returns the matched step so callers can refuse re-use of the same code (replay).
 */
export function verifyTotp(secret, code, lastStep, now = Date.now()) {
    const c = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(c))
        return null;
    const step = currentStep(now);
    for (const s of [step - 1, step, step + 1]) {
        if (lastStep != null && s <= lastStep)
            continue;
        if (safeEqual(hotp(secret, s), c))
            return s;
    }
    return null;
}
export function otpauthUrl(secret, account, issuer) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
export const qrSvg = (url) => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
/** Ten single-use recovery codes like "7KQ4-MZ2P". Only their hashes are stored. */
export function newRecoveryCodes() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const plain = Array.from({ length: 10 }, () => {
        const s = Array.from({ length: 8 }, () => chars[randomInt(chars.length)]).join('');
        return `${s.slice(0, 4)}-${s.slice(4)}`;
    });
    return { plain, hashed: plain.map(hashRecovery) };
}
export const hashRecovery = (code) => sha256(`recovery:${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
//# sourceMappingURL=totp.js.map