import { describe, expect, it } from 'vitest';
import { parseFaqMarkdown, scoreFaqMatch, type FaqEntry } from './faq-parser.js';

describe('faq-parser', () => {
  const sampleFaq: FaqEntry = {
    faq_id: 'FAQ-001',
    question: 'Chính sách đổi trả hàng như thế nào?',
    approved_answer: 'Khách hàng có thể đổi trả hàng trong vòng 30 ngày kể từ ngày nhận hàng.',
    source_file: 'customer-care/faq.md',
  };

  it('scores 0 for empty or whitespace query', () => {
    expect(scoreFaqMatch(sampleFaq, [], '')).toBe(0);
    expect(scoreFaqMatch(sampleFaq, ['   '], '   ')).toBe(0);
    expect(scoreFaqMatch(sampleFaq, [], '   ')).toBe(0);
    expect(scoreFaqMatch(sampleFaq, [''], 'unrelated question')).toBe(0);
    expect(scoreFaqMatch(sampleFaq, ['   '], 'unrelated question')).toBe(0);
  });

  it('scores 1.0 for full phrase match in question regardless of case', () => {
    expect(scoreFaqMatch(sampleFaq, ['chính', 'sách'], 'chính sách đổi trả')).toBe(1.0);
    expect(scoreFaqMatch(sampleFaq, ['chinh', 'sach'], 'CHÍNH SÁCH ĐỔI TRẢ')).toBe(1.0);
  });

  it('scores token matches proportionally and handles case insensitivity', () => {
    const score = scoreFaqMatch(sampleFaq, ['ĐỔI', 'TRẢ', 'KHÔNG_CÓ'], 'đổi trả không có');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1.0);
  });

  it('parses FAQ markdown entries correctly', () => {
    const markdown = `
# Customer Care FAQ

### FAQ-01: How to track order?
Approved answer: Use the tracking link sent to your email.

### FAQ-02: What are shipping options?
Approved answer: Standard and express delivery are available.
`;
    const result = parseFaqMarkdown(markdown, 'test.md');
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]?.faq_id).toBe('FAQ-01');
    expect(result.entries[0]?.approved_answer).toContain('Use the tracking link');
    expect(result.entries[1]?.faq_id).toBe('FAQ-02');
  });
});
