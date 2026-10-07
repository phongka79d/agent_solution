import { describe, expect, it } from 'vitest';

import { classifyTurnModule, salesRequirementsFor, shouldUseSalesAdvisor } from './turn-classifier.js';

describe('classifyTurnModule', () => {
  it('routes the demo shopping prompt to Sales without a provider classification', () => {
    expect(classifyTurnModule('I need a laptop under 20 million VND for graphic design.', undefined)).toBe('sales');
    expect(classifyTurnModule('Tư vấn điện thoại dưới 20 triệu để chơi game', undefined)).toBe('sales');
  });

  it('keeps support first when the same message also reports a problem with an existing order', () => {
    expect(classifyTurnModule('My laptop order is broken and not working', undefined)).toBe('support');
    expect(classifyTurnModule('Where is my order? I still need a laptop', undefined)).toBe('support');
  });

  it('leaves an unclassified message with Customer Care', () => {
    expect(classifyTurnModule('Hello, are you there?', undefined)).toBe('support');
    expect(classifyTurnModule('Hello', 'marketing')).toBe('marketing');
  });

  it('routes a generic commercial request without a tenant catalog or currency assumption', () => {
    expect(classifyTurnModule('Recommend a camera for travel under USD 1000', undefined)).toBe('sales');
  });

  it('refuses an explicitly unknown automatic intent', () => {
    expect(() => classifyTurnModule('Hello', 'auto')).toThrow();
  });
});

describe('salesRequirementsFor', () => {
  it('parses a bounded generic budget with its stated ISO-4217-style currency', () => {
    expect(salesRequirementsFor('Recommend a camera under USD 1,500 for travel')).toEqual({
      category: 'cameras',
      budget: { amount: 1_500, currency: 'USD' },
      use_case: 'travel',
    });
  });
  it('parses Vietnamese budget expressions and currency symbols properly', () => {
    expect(salesRequirementsFor('Tư vấn laptop dưới 20 triệu để làm đồ họa')).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
      use_case: 'lam do hoa',
    });
    expect(salesRequirementsFor('Tư vấn laptop dưới 20tr để làm đồ họa')).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
      use_case: 'lam do hoa',
    });
    expect(salesRequirementsFor('Tư vấn laptop dưới 20.000.000₫')).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
    });
    expect(salesRequirementsFor('Tư vấn laptop dưới 20.000.000đ')).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
    });
    expect(salesRequirementsFor('Tư vấn laptop dưới 20 triệu đ')).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
    });
    expect(salesRequirementsFor('Tư vấn laptop dưới 20 triệu đồng')).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
    });
  });

  it('does not treat an English connector as a currency code', () => {
    expect(salesRequirementsFor('Recommend a laptop under 1000 for travel')).toEqual({
      category: 'laptops',
      use_case: 'travel',
    });
  });

  it('admits partial understanding so Sales can clarify missing preferences', () => {
    expect(salesRequirementsFor('Recommend a printer')).toEqual({
      category: 'printers',
    });
  });

  it('does not accept provider-supplied amounts without a source in the message', () => {
    expect(salesRequirementsFor('Recommend a printer', {
      category: 'printers',
      budget: { amount: 10, currency: 'USD' },
    })).toEqual({
      category: 'printers',
    });
  });
  it('maps may tinh to laptops and detects direct use cases in Vietnamese', () => {
    expect(salesRequirementsFor('Tư vấn máy tính đồ họa dưới 20 triệu')).toEqual({
      category: 'laptops',
      use_case: 'graphic design',
      budget: { amount: 20_000_000, currency: 'VND' },
    });
    expect(salesRequirementsFor('Tìm chuột văn phòng dưới 500k')).toEqual({
      category: 'accessories',
      use_case: 'office',
      budget: { amount: 500_000, currency: 'VND' },
    });
  });
  it('keeps direct inventory and price questions out of advisor clarification', () => {
    expect(shouldUseSalesAdvisor('Is SKU-LOCAL-1 in stock?', salesRequirementsFor('Is SKU-LOCAL-1 in stock?'))).toBe(false);
    expect(shouldUseSalesAdvisor('What is the price of this laptop?', salesRequirementsFor('What is the price of this laptop?'))).toBe(false);
    expect(shouldUseSalesAdvisor('Recommend a laptop under USD 1000', salesRequirementsFor('Recommend a laptop under USD 1000'))).toBe(true);
  });
});
