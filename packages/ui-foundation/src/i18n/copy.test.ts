import { describe, expect, it } from 'vitest';

import { enMessages } from './en.js';
import { viMessages } from './vi.js';

const BANNED_WORDS = /\b(tenant|telemetry|fleet)\b/i;
const UPPER_SNAKE = /[A-Z][A-Z0-9]*_[A-Z0-9]+/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('message catalog', () => {
  it('keeps Vietnamese and English keys in parity', () => {
    const viKeys = Object.keys(viMessages).sort();
    const enKeys = Object.keys(enMessages).sort();
    expect(enKeys).toEqual(viKeys);
  });

  it('never leaks machine vocabulary, raw codes or identifiers into visible Vietnamese copy', () => {
    const offenders: string[] = [];
    for (const [key, value] of Object.entries(viMessages)) {
      if (BANNED_WORDS.test(value)) offenders.push(`${key}: banned word in "${value}"`);
      if (UPPER_SNAKE.test(value)) offenders.push(`${key}: raw code in "${value}"`);
      if (UUID.test(value)) offenders.push(`${key}: identifier in "${value}"`);
    }
    expect(offenders).toEqual([]);
  });

  it('labels the unknown status in the product vocabulary', () => {
    expect(viMessages['status.unknown']).toBe('Không xác định');
    expect(enMessages['status.unknown']).toBe('Unknown');
  });
});
