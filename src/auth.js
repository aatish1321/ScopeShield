import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, requiredText } from './validation.js';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let active = 0;

export function credentials(body, signup = false) {
  const email = requiredText(body?.email, 'Email', 254).toLowerCase();
  const password = body?.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128 || Buffer.byteLength(password) > 1024) {
    throw new AppError(400, 'Use a password of 15–128 characters. A long passphrase works well.');
  }
  return { email, password, ...(signup ? { name: requiredText(body.name, 'Name', 80) } : {}) };
}

async function passwordKey(password, salt) {
  if (active >= 4) throw new AppError(429, 'Sign-in is busy. Please try again shortly.');
  active++;
  try { return await derive(password, salt, 64, options); }
  finally { active--; }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await passwordKey(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  // Unknown accounts still do the expensive derivation to avoid a fast email probe.
  const [salt, expected] = (stored || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await passwordKey(password, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && Boolean(stored);
}

export const publicUser = user => ({ name: user.name, email: user.email });
