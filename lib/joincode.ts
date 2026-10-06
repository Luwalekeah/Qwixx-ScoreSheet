// Client-safe: alphabet, length, and normalisation. No node imports here, so
// this module can be imported from Client Components (e.g. to render the
// allowed-character hint) without pulling node:crypto into the browser
// bundle. generateJoinCode lives in lib/joincodeGenerate.ts, which is
// server-only.

// 26 letters minus I, L, O, U, plus 10 digits minus 0, 1. 30 characters,
// so nothing is ambiguous read aloud in a room or typed on a phone keyboard.
export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

const VALID_CODE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export function normalizeJoinCode(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[\s-]/g, '');
  if (!VALID_CODE.test(normalized)) return null;
  return normalized;
}
