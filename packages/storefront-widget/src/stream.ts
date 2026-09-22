const DATA_FIELD = 'data:';

/**
 * Extracts the payload of every `data:` field in one SSE chunk. Other fields
 * (`event:`, `id:`, `retry:`), comments, and blank separators are dropped.
 */
export function parseSseChunk(chunk: string): readonly string[] {
  const payloads: string[] = [];

  for (const line of chunk.split(/\r?\n/)) {
    if (!line.startsWith(DATA_FIELD)) {
      continue;
    }

    // SSE removes one optional space after the field colon.
    payloads.push(line.slice(DATA_FIELD.length).replace(/^ /, ''));
  }

  return payloads;
}
