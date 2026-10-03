import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { messages } from './i18n/index.js';
import { statusView } from './status-view.js';

const VOCABULARY_PROPERTIES: Record<string, true> = {
  status: true,
  state: true,
  ownership: true,
  data_class: true,
  lifecycle_state: true,
};

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

interface VocabularyEntry {
  readonly property: string;
  readonly code: string;
  readonly path: string;
}

function vocabularyEnums(document: JsonValue): VocabularyEntry[] {
  const entries: VocabularyEntry[] = [];

  const visit = (value: JsonValue, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;

    const object = value as JsonObject;
    const properties = object.properties;
    if (properties !== undefined && properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      const schemaProperties = properties as JsonObject;
      for (const [property, schema] of Object.entries(schemaProperties)) {
        if (
          VOCABULARY_PROPERTIES[property] !== true ||
          schema === null ||
          typeof schema !== 'object' ||
          Array.isArray(schema)
        ) continue;
        const schemaObject = schema as JsonObject;
        const enumValues = schemaObject.enum;
        if (schemaObject.type !== 'string' || !Array.isArray(enumValues)) continue;
        for (const code of enumValues) {
          if (typeof code === 'string') entries.push({ property, code, path: `${path}.properties.${property}` });
        }
      }
    }

    for (const [key, child] of Object.entries(object)) visit(child, `${path}.${key}`);
  };

  visit(document, '$');
  return entries;
}

describe('OpenAPI status vocabulary', () => {
  it('gives every status-like string enum a localized statusView label', async () => {
    const document = JSON.parse(
      await readFile(new URL('../../api-contract/openapi.json', import.meta.url), 'utf8'),
    ) as JsonValue;
    const entries = vocabularyEnums(document);
    const missingLabels: string[] = [];
    expect(entries.length).toBeGreaterThan(0);
    for (const { property, code, path } of entries) {
      const view = property === 'data_class'
        ? statusView('data_class', code)
        : property === 'ownership'
          ? statusView('conversation', code)
          : statusView(code);
      const context = `${path} enum value ${code}`;
      if (view.label_key === 'status.unknown') {
        missingLabels.push(context);
        continue;
      }
      const viLabel = messages.vi[view.label_key];
      expect(viLabel, `${context} needs a Vietnamese label`).toBeDefined();
      expect(messages.en[view.label_key], `${context} needs an English label`).toBeDefined();
      if (viLabel === undefined) continue;
      expect(viLabel, `${context} must not render its raw code`).not.toBe(code);
      expect(viLabel, `${context} must not expose internal status codes`).not.toMatch(
        /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
      );
      expect(viLabel, `${context} must not expose the internal tenant term`).not.toMatch(/\btenant\b/i);
    }
    expect(missingLabels).toEqual([]);
  });
});
