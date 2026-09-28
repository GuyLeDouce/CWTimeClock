import 'server-only';
import {
  randomBytes,
  createHash,
  createHmac,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function privateKey(value: string) {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-'))
    throw new Error('Set a random APP_SECRET of at least 32 characters.');
  return createHmac('sha256', secret).update(value).digest('hex');
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string | null) {
  const match =
    typeof stored === 'string' ? /^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/.exec(stored) : null;
  // Still perform the password derivation for missing or malformed credentials.
  // A manually entered password is never treated as a valid stored hash.
  const salt = match?.[1] ?? '0'.repeat(32);
  const expected = match?.[2] ?? '0'.repeat(128);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const target = Buffer.from(expected, 'hex');
  return timingSafeEqual(key, target) && match !== null;
}
