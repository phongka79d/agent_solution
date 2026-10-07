import { describe, expect, it } from 'vitest';

import { createTranslator, messages, t } from './index.js';

describe('i18n', () => {
  it('falls back from Vietnamese to English and then to the key', () => {
    expect(t('auth.email')).toBe('Email');
    const original = messages.vi['fallback.only_en'];
    messages.vi['fallback.only_en'] = '';
    messages.en['fallback.only_en'] = 'English fallback';
    expect(t('fallback.only_en')).toBe('');
    delete messages.vi['fallback.only_en'];
    expect(t('fallback.only_en', undefined, 'vi')).toBe('English fallback');
    expect(t('fallback.missing')).toBe('fallback.missing');
    if (original !== undefined) messages.vi['fallback.only_en'] = original;
  });

  it('interpolates values and supports bound translators', () => {
    expect(t('company.activity.run_completed', { run_id: 'run-42' })).toContain('run-42');
    expect(createTranslator('en')('company.activity.run_stage_entered', { run_id: 7, stage: 'review' })).toBe(
      'Run 7 entered stage review.',
    );
  });
});
