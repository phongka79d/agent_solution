/**
 * @file Barrel of the eight Sales domain rows of `implement/05-skill-system-specifications.md` §4.2
 * (skills 8-15), in the order the specification lists them.
 */

import type { PlatformSkillDependencies, PlatformSkillRow } from '../../contracts/index.js';
import { createSalesCheckPrice } from './check-price.js';
import { createSalesCheckStock } from './check-stock.js';
import { createSalesCreateCart } from './create-cart.js';
import { createSalesCreateOrder } from './create-order.js';
import { createSalesRecommendProduct } from './recommend-product.js';
import { createSalesRetrieveCustomer } from './retrieve-customer.js';
import { createSalesSearchProduct } from './search-product.js';
import { createSalesSendMessage } from './send-message.js';

/**
 * Builds the eight Sales rows in §4.2 order: skills 8-15.
 *
 * @param deps Injected tool port and clock, shared by every row.
 * @returns The rows in specification order — `search_product`, `check_stock`, `check_price`,
 *   `retrieve_customer`, `recommend_product`, `create_cart`, `create_order`, `send_message`.
 */
export function createSalesSkills(
  deps: PlatformSkillDependencies,
): readonly PlatformSkillRow<unknown, unknown>[] {
  return [
    createSalesSearchProduct(deps),
    createSalesCheckStock(deps),
    createSalesCheckPrice(deps),
    createSalesRetrieveCustomer(deps),
    createSalesRecommendProduct(deps),
    createSalesCreateCart(deps),
    createSalesCreateOrder(deps),
    createSalesSendMessage(deps),
  ];
}
