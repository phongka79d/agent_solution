export interface FaqEntry {
  readonly faq_id: string;
  readonly question: string;
  readonly approved_answer: string;
  readonly source_file: string;
}

export interface ParsedFaqCorpus {
  readonly entries: readonly FaqEntry[];
}

/** Parses markdown FAQs into structured Q&A records. */
export function parseFaqMarkdown(content: string, source_file: string): ParsedFaqCorpus {
  // Strip frontmatter if present
  const body = content.replace(/^---[\s\S]*?---\r?\n/, '');
  const entries: FaqEntry[] = [];

  // Match headers: ## FAQ-1: Question or ### Question or Question / Answer blocks
  const sections = body.split(/(?=^#{1,4}\s+)/m);
  let idCounter = 1;

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0) continue;

    const lines = trimmed.split(/\r?\n/);
    const headerLine = lines[0] ?? '';
    const headerMatch = /^#{1,4}\s+(?:([A-Za-z0-9_-]+):\s*)?(.*)$/.exec(headerLine);
    if (!headerMatch) continue;

    let faq_id = headerMatch[1]?.trim() || `faq-${idCounter++}`;
    let question = headerMatch[2]?.trim() || '';
    const remainingText = lines.slice(1).join('\n').trim();

    // Check if remaining text has explicit Q: / A:
    const qaMatch = /^\*\*?Q(?:uestion)?:\*\*?\s*(.*?)\r?\n\*\*?A(?:nswer)?:\*\*?\s*([\s\S]*)$/i.exec(remainingText);
    let approved_answer = remainingText;

    if (qaMatch) {
      if (qaMatch[1] && qaMatch[1].trim().length > 0) {
        question = qaMatch[1].trim();
      }
      approved_answer = (qaMatch[2] ?? '').trim();
    } else {
      // Remove any leading "A:" or "**Answer:**"
      approved_answer = approved_answer.replace(/^\*\*?A(?:nswer)?:\*\*?\s*/i, '').trim();
    }

    if (question.length > 0 && approved_answer.length > 0) {
      entries.push({
        faq_id,
        question,
        approved_answer,
        source_file,
      });
    }
  }

  return { entries };
}

/** Deterministic token-overlap scoring for query matching. */
export function scoreFaqMatch(entry: FaqEntry, queryTokens: readonly string[], queryText: string): number {
  const normalizedQuery = queryText.trim().toLowerCase();
  const validTokens = queryTokens
    .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter((t) => t.length > 0);
  if (normalizedQuery.length === 0 || validTokens.length === 0) {
    return 0;
  }

  const qLower = entry.question.toLowerCase();
  const aLower = entry.approved_answer.toLowerCase();

  // Full phrase match in question gives maximum confidence
  if (qLower.includes(normalizedQuery)) {
    return 1.0;
  }

  // Count token matches
  let qMatches = 0;
  let aMatches = 0;
  for (const tokenLower of validTokens) {
    if (qLower.includes(tokenLower)) qMatches++;
    else if (aLower.includes(tokenLower)) aMatches++;
  }

  const qScore = qMatches / validTokens.length;
  const aScore = (aMatches / validTokens.length) * 0.4;
  const total = Math.min(1.0, qScore + aScore);

  return total;
}
