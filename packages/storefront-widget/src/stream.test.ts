import { describe, expect, it } from 'vitest';

import { parseSseChunk } from './stream.js';

describe('parseSseChunk', () => {
  it('extracts the payload of every data line and ignores other fields', () => {
    const chunk = 'event: delta\nid: 7\ndata: {"token":"hello"}\ndata: [DONE]\n\n';

    expect(parseSseChunk(chunk)).toEqual(['{"token":"hello"}', '[DONE]']);
  });

  it('returns nothing for a chunk without data lines', () => {
    expect(parseSseChunk(': keep-alive\n\n')).toEqual([]);
  });
});
