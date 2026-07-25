// Guards the contract between the extracted dataset, the image manifest, and the file the
// frontend fetches. These are the failures that would otherwise show up as silently broken
// images in the browser rather than as a red build.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(APP, '..', '..');
const IMAGE_DIR = path.join(APP, 'assets', 'products');

const catalog = JSON.parse(readFileSync(path.join(APP, 'data', 'catalog.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(REPO, 'sick-catalog-dataset', 'images.json'), 'utf8'));
const datasetOrders = new Set(
  readFileSync(path.join(REPO, 'sick-catalog-dataset', 'products.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).order_number)
);

// Every match method the detail panel in catalog.js knows how to describe. A new method added to
// the extractor without a matching note would render an empty explanation.
const DESCRIBED_METHODS = new Set(['row_aligned', 'page_hero', 'family_hero', 'family_hero_loose']);

describe('catalog.json', () => {
  it('covers every SKU in the dataset, exactly once', () => {
    const orders = catalog.products.map((p) => p.order_number);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders.length).toBe(datasetOrders.size);
    for (const o of orders) expect(datasetOrders.has(o)).toBe(true);
  });

  it('reports a summary that matches its own rows', () => {
    const withImage = catalog.products.filter((p) => p.image).length;
    expect(catalog.summary.total).toBe(catalog.products.length);
    expect(catalog.summary.with_image).toBe(withImage);
    expect(catalog.summary.coverage_pct).toBeCloseTo((withImage / catalog.products.length) * 100, 1);
    expect(catalog.summary.family_photo_count).toBe(
      catalog.products.filter((p) => p.image_is_family_photo).length
    );
  });

  it('lists every category its products use', () => {
    const used = new Set(catalog.products.map((p) => p.category));
    expect([...used].sort()).toEqual([...catalog.categories].sort());
  });
});

describe('product images', () => {
  const onDisk = new Set(readdirSync(IMAGE_DIR).filter((f) => f.endsWith('.webp')));

  it('resolves every referenced image to a file the browser can fetch', () => {
    const broken = catalog.products
      .filter((p) => p.image && !onDisk.has(p.image))
      .map((p) => `${p.order_number} -> ${p.image}`);
    expect(broken).toEqual([]);
    for (const p of catalog.products) {
      if (p.image) expect(existsSync(path.join(IMAGE_DIR, p.image))).toBe(true);
    }
  });

  it('ships no image that nothing references', () => {
    const referenced = new Set(catalog.products.filter((p) => p.image).map((p) => p.image));
    expect([...onDisk].filter((f) => !referenced.has(f))).toEqual([]);
  });

  it('agrees with the extraction manifest on which SKUs have a photo', () => {
    for (const p of catalog.products) {
      const entry = manifest.images[p.order_number];
      expect(entry, `missing manifest entry for ${p.order_number}`).toBeDefined();
      expect(p.image).toBe(entry.image ?? null);
    }
  });

  it('describes every match method the UI has to explain', () => {
    for (const p of catalog.products) {
      if (p.image) expect(DESCRIBED_METHODS.has(p.image_match)).toBe(true);
      else expect(p.image_match).toBeNull();
    }
  });

  it('never gives an accessory a photo of the sensor family', () => {
    // A mounting bracket must not inherit the sensor's hero photo; it only gets the thumbnail
    // sitting in its own catalog row.
    const wrong = catalog.products
      .filter((p) => p.row_type === 'accessory' && p.image && p.image_match !== 'row_aligned')
      .map((p) => `${p.order_number} (${p.image_match})`);
    expect(wrong).toEqual([]);
  });

  it('flags a row-matched photo as the exact variant, not a family stand-in', () => {
    const wrong = catalog.products
      .filter((p) => p.image_match === 'row_aligned' && p.image_is_family_photo)
      .map((p) => p.order_number);
    expect(wrong).toEqual([]);
  });

  it('cites the printed catalog page, not a raw PDF index, for every photo it shows', () => {
    // The panel shows this next to the SKU's own printed page, so both must use the same
    // numbering system ("B-44"), never a bare page number.
    for (const p of catalog.products) {
      if (!p.image) continue;
      expect(p.image_page, `${p.order_number} has no printed page for its photo`).toMatch(
        /^[B-N]-\d+$/
      );
    }
  });
});
