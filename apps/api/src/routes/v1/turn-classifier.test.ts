import { describe, expect, it } from 'vitest';

import {
  classifyTurnModule,
  salesOrderRequestFor,
  salesRequirementsFor,
  shouldUseSalesAdvisor,
} from './turn-classifier.js';

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
  it('routes a human request from the sales try chat to Customer Care', () => {
    expect(classifyTurnModule('I want to speak to a person', undefined)).toBe('support');
  });

  it('routes a generic commercial request without a tenant catalog or currency assumption', () => {
    expect(classifyTurnModule('Recommend a camera for travel under USD 1000', undefined)).toBe('sales');
  });

  it('refuses an explicitly unknown automatic intent', () => {
    expect(() => classifyTurnModule('Hello', 'auto')).toThrow();
  });

  it('routes vertical catalog terms supplied by the tenant, without electronics terms', () => {
    const fmcg = ['Sữa bột', 'Tã bỉm'] as const;
    expect(classifyTurnModule('Sữa bột nào tốt cho bé sơ sinh?', undefined)).toBe('support');
    expect(classifyTurnModule('Sữa bột nào tốt cho bé sơ sinh?', undefined, fmcg)).toBe('sales');

    const fashion = ['Váy đầm', 'Áo sơ mi'] as const;
    expect(classifyTurnModule('Váy đầm dự tiệc', undefined, fashion)).toBe('sales');
  });
});

describe('salesRequirementsFor', () => {
  it('parses a bounded generic budget with its stated ISO-4217-style currency', () => {
    expect(salesRequirementsFor('Recommend a camera under USD 1,500 for travel')).toEqual({
      budget: { amount: 1_500, currency: 'USD' },
      use_case: 'travel',
    });
  });

  it('does not treat an English connector as a currency code', () => {
    expect(salesRequirementsFor('Recommend a laptop under 1000 for travel')).toEqual({
      use_case: 'travel',
    });
  });

  it('never parses a currency out of "for" when the amount has no explicit currency word or symbol', () => {
    const requirements = salesRequirementsFor('Recommend a laptop under 500 for gaming');
    expect(requirements?.budget).toBeUndefined();
    expect(requirements?.use_case).toBe('gaming');
  });

  it('accepts an explicit Vietnamese money word and scales it', () => {
    expect(salesRequirementsFor('dưới 20 triệu')).toEqual({
      budget: { amount: 20_000_000, currency: 'VND' },
    });
  });

  it('encodes no product lexicon itself: an electronics word alone yields no category', () => {
    expect(salesRequirementsFor('Recommend a laptop')).toBeUndefined();
  });

  it('uses tenant catalog terms for category hints', () => {
    expect(salesRequirementsFor('Sữa bột nào tốt cho bé sơ sinh?', undefined, ['Sữa bột', 'Tã bỉm']))
      .toMatchObject({ category: 'sữa bột' });
    expect(salesRequirementsFor('Váy đầm dự tiệc', undefined, ['Váy đầm', 'Áo sơ mi']))
      .toMatchObject({ category: 'váy đầm' });
  });

  it('fills a missing advisor category from the singular form of a tenant catalog label', () => {
    expect(salesRequirementsFor(
      'Recommend a laptop under 20 million VND for graphic design.',
      { use_case: 'graphic design' },
      ['Laptops'],
    )).toEqual({
      category: 'laptops',
      budget: { amount: 20_000_000, currency: 'VND' },
      use_case: 'graphic design',
    });
    expect(salesRequirementsFor('Recommend laptops', undefined, ['Laptop']))
      .toEqual({ category: 'laptop' });
    expect(salesRequirementsFor('Recommend laptopbags', undefined, ['Laptops']))
      .toBeUndefined();
  });

  it('treats provider-proposed category as primary over the regex fallback', () => {
    expect(salesRequirementsFor('Recommend a gift', {
      category: 'thực phẩm',
    })).toEqual({ category: 'thực phẩm' });
  });

  it('does not accept provider-supplied amounts without a source in the message', () => {
    expect(salesRequirementsFor('Recommend a printer', {
      category: 'printers',
      budget: { amount: 10, currency: 'USD' },
    })).toEqual({
      category: 'printers',
    });
  });

  it('keeps direct inventory and price questions out of advisor clarification', () => {
    expect(shouldUseSalesAdvisor('Is SKU-LOCAL-1 in stock?', salesRequirementsFor('Is SKU-LOCAL-1 in stock?'))).toBe(false);
    expect(shouldUseSalesAdvisor('What is the price of this laptop?', salesRequirementsFor('What is the price of this laptop?'))).toBe(false);
    expect(shouldUseSalesAdvisor('Recommend a laptop under USD 1000', salesRequirementsFor('Recommend a laptop under USD 1000'))).toBe(true);
  });
});

describe('salesOrderRequestFor', () => {
  it('extracts only explicit order details from the customer message', () => {
    expect(salesOrderRequestFor('Please order SKU-local-1 qty 3 with cash on delivery; price $0.01')).toEqual({
      sku_id: 'SKU-LOCAL-1',
      quantity: 3,
      payment_method: 'CVS_COD',
    });
  });

  it('defaults an omitted quantity to one and leaves an omitted SKU for clarification', () => {
    expect(salesOrderRequestFor('I want to order SKU-LOCAL-1')).toEqual({
      sku_id: 'SKU-LOCAL-1',
      quantity: 1,
    });
    expect(salesOrderRequestFor('Please order it')).toEqual({ quantity: 1 });
  });

  it('does not treat inquiry or ambiguous/invalid details as an order proposal', () => {
    expect(salesOrderRequestFor('Is SKU-LOCAL-1 in stock?')).toBeUndefined();
    expect(salesOrderRequestFor('Order SKU-LOCAL-1 qty 0')).toBeUndefined();
    expect(salesOrderRequestFor('Buy SKU-LOCAL-1 with COD and PayPal')).toBeUndefined();
  });
});
