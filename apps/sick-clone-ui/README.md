# sick-clone-ui

Static SICK-style frontend. No build step — every file here is served as-is.

| Page | What it is |
| --- | --- |
| `index.html` | Clone of the SICK homepage. The front door. |
| `productos.html` | Product catalog: every SKU from `sick-catalog-dataset/`, each with its photo extracted from the source PDF. |

```bash
pnpm --filter @no-human/sick-clone-ui dev     # serves on :3300
pnpm --filter @no-human/sick-clone-ui test    # data-contract tests
```

`productos.html` needs to be served over HTTP, not opened as a `file://` URL — it `fetch`es its
data and the browser blocks that on `file://`.

## Where the product data comes from

```
~/Downloads/CATALOGO-PRODUCTOS-SICK.pdf
  │
  ├─ (already done, PR #9)  sick-catalog-dataset/products.jsonl      1,776 SKUs
  │
  ├─ scripts/extract-product-images.mjs
  │     ├─ sick-catalog-dataset/images.json        SKU -> photo + provenance + confidence
  │     └─ assets/products/*.webp                  297 photos, ~1.1 MB
  │
  └─ scripts/build-catalog-data.mjs
        └─ data/catalog.json                       what productos.html fetches (1.5 MB, 64 KB gzipped)
```

`data/catalog.json` and `assets/products/` are **generated and committed** — the site has no build
step, so a fresh checkout must work without running anything. After changing the dataset or the
extractor, regenerate both and commit the result:

```bash
node scripts/extract-product-images.mjs   # needs the source PDF + pdftohtml/pdftoppm/ImageMagick
node scripts/build-catalog-data.mjs       # needs only the dataset
```

`tests/catalog-data.test.js` fails the build if `catalog.json` references an image that is not on
disk, if an image is shipped that nothing references, or if the two artifacts disagree — so a stale
regeneration shows up as a red test rather than as broken images in the browser.

## Honesty rules the UI keeps

The catalog is a source document, and the UI never implies more precision than the document gives:

- A SKU with no photo in the catalog shows a *"Sin imagen en el catálogo"* placeholder. It never
  borrows a similar product's photo.
- A photo that depicts the **family** rather than the exact variant is badged *"Foto de familia"* on
  the card, and the detail panel names the page it came from.
- Specs read from prose rather than a labelled table cell keep the dataset's low-confidence marker
  (`*`) with a footnote.

## Note on the `capture*.js` / `extract_styles.js` scripts

Screenshot helpers carried over from the machine the clone was first built on. They hardcode Windows
paths (`C:\Program Files\...`) and do not run here. Left untouched; not wired into any package script.
