import 'server-only';
import { randomBytes } from 'node:crypto';
import { ALPHABET, CODE_LENGTH } from './joincode';

const REJECTION_CEILING = 240; // largest multiple of 30 below 256

export function generateJoinCode(): string {
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH);
    for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) {
      const byte = bytes[i];
      if (byte >= REJECTION_CEILING) continue;
      out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}
