/**
 * Access layer over `sick-catalog-dataset/catalog.enriched.json`.
 *
 * The enriched catalog is a committed build artifact produced by
 * `scripts/enrich-catalog.mjs`, not something parsed at runtime. This module
 * only indexes it and answers lookups.
 */
import { readFileSync } from 'node:fs';

import type { EnrichedProduct } from './types.js';

export class Catalog {
  readonly all: readonly EnrichedProduct[];
  readonly products: readonly EnrichedProduct[];
  readonly accessories: readonly EnrichedProduct[];
  readonly #byOrderNumber: Map<string, EnrichedProduct>;

  constructor(rows: readonly EnrichedProduct[]) {
    this.all = rows;
    this.products = rows.filter((r) => r.row_type === 'product');
    this.accessories = rows.filter((r) => r.row_type === 'accessory');
    this.#byOrderNumber = new Map(rows.map((r) => [r.order_number, r]));
  }

  get(orderNumber: string): EnrichedProduct | undefined {
    return this.#byOrderNumber.get(orderNumber);
  }

  has(orderNumber: string): boolean {
    return this.#byOrderNumber.has(orderNumber);
  }

  /** Mounting brackets, cables, reflectors and the like that ship with this SKU's family. */
  accessoriesFor(product: EnrichedProduct, limit = 6): EnrichedProduct[] {
    const found: EnrichedProduct[] = [];
    for (const orderNumber of product.accessory_order_numbers) {
      const accessory = this.#byOrderNumber.get(orderNumber);
      if (accessory) found.push(accessory);
      if (found.length >= limit) break;
    }
    return found;
  }
}

/** Load the enriched catalog artifact from disk. */
export function loadCatalog(path: string): Catalog {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Enriched catalog at ${path} is not a JSON array`);
  }
  return new Catalog(parsed as EnrichedProduct[]);
}
