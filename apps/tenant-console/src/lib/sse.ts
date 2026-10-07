export type Receipt = {
  readonly task_id: string;
  readonly status?: string;
  readonly evidence_ids?: readonly string[];
  readonly evidence_reference?: unknown;
  readonly answer?: string;
};

/** Parses complete and partial SSE reads without losing a chunk boundary. */
export function parseSseChunks(chunks: readonly string[]): Receipt | null {
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const raw = line.trim().replace(/^data:\s?/, '').trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).task_id === 'string') return value as Receipt;
      } catch { /* malformed or split event; continue buffering */ }
    }
  }
  const raw = buffer.trim().replace(/^data:\s?/, '').trim();
  if (!raw || raw === '[DONE]') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).task_id === 'string' ? value as Receipt : null;
  } catch { return null; }
}
