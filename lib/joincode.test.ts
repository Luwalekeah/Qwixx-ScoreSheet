import { describe, it, expect } from 'vitest';
import { ALPHABET, normalizeJoinCode, CODE_LENGTH } from './joincode';
import { generateJoinCode } from './joincodeGenerate';

describe('joincode alphabet', () => {
  it('has exactly 30 unambiguous characters', () => {
    expect(ALPHABET.length).toBe(30);
    for (const excluded of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(ALPHABET.includes(excluded)).toBe(false);
    }
  });

  it('generateJoinCode produces codes drawn from the alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateJoinCode();
      expect(code).toHaveLength(CODE_LENGTH);
      for (const ch of code) {
        expect(ALPHABET.includes(ch)).toBe(true);
      }
    }
  });

  it('normalizeJoinCode uppercases and strips whitespace and hyphens', () => {
    expect(normalizeJoinCode('ab34-cd')).toBe('AB34CD');
    expect(normalizeJoinCode(' AB 34 CD ')).toBe('AB34CD');
  });

  it('normalizeJoinCode rejects strings not exactly six alphabet characters', () => {
    expect(normalizeJoinCode('AB34C')).toBe(null);
    expect(normalizeJoinCode('AB34CDE')).toBe(null);
    expect(normalizeJoinCode('AB34C0')).toBe(null);
    expect(normalizeJoinCode('AB34CI')).toBe(null);
  });
});
