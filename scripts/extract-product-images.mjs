#!/usr/bin/env node
// Extract product photos from the SICK catalog PDF and key them to SKUs.
//
// Two kinds of photo exist in the catalog, and they are matched differently:
//
//   row thumbnail  a small photo sitting in an accessory/ordering table row. Its vertical
//                  centre lines up with the row's 7-digit order number (~15 px above it),
//                  so it can be matched to one exact SKU.
//   family hero    the large photo at the top of a family's opening page. It depicts the
//                  family, not one variant, so every product variant of that family gets it.
//
// Accessories never inherit a family hero — a mounting bracket is not the sensor. A SKU with
// no photo of its own is emitted with image: null rather than a stand-in, per the dataset's
// never-infer rule (see sick-catalog-dataset/README.md).
//
// Usage: node scripts/extract-product-images.mjs [--pdf <path>] [--keep-temp]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

// --- geometry thresholds, in pdftohtml page space at --zoom 1.5 (892 x 1188 per page) ---
const PAGE_WIDE_FRACTION = 0.7; // >= this share of page width => decorative header band, not a product
const MIN_AREA = 500; // below this it is a pictogram/symbol, not a photo
// Row matching runs first and consumes what it matches; whatever is left and big enough is a hero.
// These two bands must overlap, never leave a gap: a gap silently drops real photos. It did — a
// mounting column 88 px tall on K-199 (2 px from its own order-number row) and the TR4 Direct family
// photo 72 px tall on L-215 both fell between a 70 px thumbnail ceiling and a 100 px hero floor.
const ROW_THUMB_MAX_H = 100; // tallest image still allowed to match a single table row
const HERO_MIN_H = 71; // shortest unmatched image still allowed to stand for a family
const ROW_MATCH_TOLERANCE = 45; // max |image centre - order-number centre| to call it the same row
const FOOTER_FRACTION = 0.93; // text below this is the page footer (holds the catalog id 8014481)
const CATALOG_ID = "8014481"; // doc number in every footer — never an order number

const HERO_MAX_PX = 480; // output long edge for family heroes
const THUMB_MAX_PX = 320; // output long edge for row thumbnails
const WEBP_QUALITY = 82;
const RENDER_DPI = 300;
const RENDER_SCALE = RENDER_DPI / 72 / 1.5; // page space at --zoom 1.5 -> rendered pixels

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PDF = arg("pdf", path.join(homedir(), "Downloads", "CATALOGO-PRODUCTOS-SICK.pdf"));
const DATASET = path.join(REPO, "sick-catalog-dataset");
const IMAGE_DIR = path.join(REPO, "apps", "sick-clone-ui", "assets", "products");
const MANIFEST = path.join(DATASET, "images.json");
const KEEP_TEMP = process.argv.includes("--keep-temp");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw new Error(`${cmd} not found: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}: ${r.stderr?.slice(0, 400)}`);
  return r.stdout;
}

// ---------------------------------------------------------------- 1. read the dataset

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const skus = readJsonl(path.join(DATASET, "products.jsonl"));
const rows = readJsonl(path.join(DATASET, "products_all_rows.jsonl"));

// Every page a SKU appears on. pdf_page is 0-based in the dataset; pdftohtml pages are 1-based.
const skusOnPage = new Map(); // pageNo -> Set<order_number>
for (const r of rows) {
  const page = r.pdf_page + 1;
  if (!skusOnPage.has(page)) skusOnPage.set(page, new Set());
  skusOnPage.get(page).add(r.order_number);
}

const byOrder = new Map(skus.map((s) => [s.order_number, s]));
// A SKU's family key, used to share a hero photo across the pages of one family.
const familyKey = (s) => `${s.category}|${s.family}`;
const subfamilyKey = (s) => `${s.category}|${s.family}|${s.subfamily || ""}`;

// ---------------------------------------------------------------- 2. dump the PDF

const tmp = mkdtempSync(path.join(tmpdir(), "sick-imgs-"));
process.stdout.write(`Extracting images from ${PDF}\n  temp: ${tmp}\n`);
run("pdftohtml", ["-xml", "-zoom", "1.5", PDF, path.join(tmp, "out.xml")]);

const xml = readFileSync(path.join(tmp, "out.xml"), "utf8");

// ---------------------------------------------------------------- 3. parse pages

const IMAGE_RE = /<image top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" src="([^"]+)"/g;
const TEXT_RE = /<text top="(-?\d+)" left="(-?\d+)"[^>]*>([\s\S]*?)<\/text>/g;

const pages = [];
for (const block of xml.split('<page number="').slice(1)) {
  const number = Number(block.slice(0, block.indexOf('"')));
  const width = Number(/width="(\d+)"/.exec(block)?.[1] ?? 892);
  const height = Number(/height="(\d+)"/.exec(block)?.[1] ?? 1188);

  const images = [];
  for (const m of block.matchAll(IMAGE_RE)) {
    const [, top, left, w, h, src] = m;
    images.push({
      page: number,
      top: Number(top),
      left: Number(left),
      w: Number(w),
      h: Number(h),
      file: path.join(tmp, path.basename(src)),
      src: path.basename(src),
    });
  }

  // Order-number positions, restricted to numbers the dataset actually lists for this page —
  // that guard keeps stray 7-digit runs (type-code digits, page furniture) out of the matching.
  const expected = skusOnPage.get(number) ?? new Set();
  const orderNumbers = [];
  for (const m of block.matchAll(TEXT_RE)) {
    const top = Number(m[1]);
    if (top > height * FOOTER_FRACTION) continue;
    const text = m[3].replace(/<[^>]+>/g, "");
    for (const num of text.match(/\b\d{7}\b/g) ?? []) {
      if (num === CATALOG_ID || !expected.has(num)) continue;
      orderNumbers.push({ num, top, left: Number(m[2]) });
    }
  }
  pages.push({ number, width, height, images, orderNumbers });
}

// ---------------------------------------------------------------- 4. classify + match

const centre = (o) => o.top + o.h / 2;
const ROW_TEXT_H = 11; // a text line's height in this page space

const assignments = new Map(); // order_number -> candidate assignment
const heroesByPage = new Map(); // pageNo -> chosen hero image
const stats = { decorative: 0, pictogram: 0, rowMatched: 0, heroes: 0, noBucket: 0 };

function better(a, b) {
  // lower rank wins; ties broken by larger source image
  const rank = { row_aligned: 0, page_hero: 1, family_hero: 2, family_hero_loose: 3 };
  if (!a) return true;
  if (rank[b.match_method] !== rank[a.match_method])
    return rank[b.match_method] < rank[a.match_method];
  return b.image.w * b.image.h > a.image.w * a.image.h;
}

function propose(orderNumber, candidate) {
  if (!byOrder.has(orderNumber)) return;
  if (better(assignments.get(orderNumber), candidate)) assignments.set(orderNumber, candidate);
}

for (const page of pages) {
  const isProductPage = skusOnPage.has(page.number);

  const usable = [];
  for (const img of page.images) {
    if (img.w >= page.width * PAGE_WIDE_FRACTION) {
      stats.decorative++;
      continue;
    }
    if (img.w * img.h < MIN_AREA) {
      stats.pictogram++;
      continue;
    }
    usable.push(img);
  }
  if (!isProductPage) continue;

  // --- row thumbnails: mutual-nearest match between small images and order-number rows
  const thumbs = usable.filter((i) => i.h <= ROW_THUMB_MAX_H);
  const taken = new Set();
  const consumed = new Set(); // images claimed by a row, so the hero pass cannot reuse them
  for (const img of thumbs) {
    let best = null;
    let bestDist = Infinity;
    for (const on of page.orderNumbers) {
      if (taken.has(on.num)) continue;
      const dist = Math.abs(centre(img) - (on.top + ROW_TEXT_H / 2));
      if (dist < bestDist) {
        bestDist = dist;
        best = on;
      }
    }
    if (!best || bestDist > ROW_MATCH_TOLERANCE) continue;
    // require the reverse direction too: no other thumbnail is closer to this row
    const contender = thumbs.some(
      (o) => o !== img && Math.abs(centre(o) - (best.top + ROW_TEXT_H / 2)) < bestDist,
    );
    if (contender) continue;
    taken.add(best.num);
    consumed.add(img);
    stats.rowMatched++;
    propose(best.num, {
      image: img,
      match_method: "row_aligned",
      low_confidence: false,
      provenance: {
        pdf_page: page.number,
        pdf_image: img.src,
        image_bbox: { top: img.top, left: img.left, width: img.w, height: img.h },
        matched_order_number_at: { top: best.top, left: best.left },
        row_offset_px: Math.round(centre(img) - (best.top + ROW_TEXT_H / 2)),
      },
    });
  }

  // --- family hero: the largest tall image on the page that no row already claimed
  const heroCandidates = usable.filter((i) => !consumed.has(i) && i.h >= HERO_MIN_H);
  if (heroCandidates.length) {
    const hero = heroCandidates.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
    heroesByPage.set(page.number, { hero, ambiguous: heroCandidates.length > 1, page });
    stats.heroes++;
  }

  // Anything usable that neither a row nor the hero pass took. Reported rather than dropped in
  // silence, so a future threshold change that starts losing photos is visible in the output.
  for (const img of usable) {
    if (!consumed.has(img) && img.h < HERO_MIN_H) stats.noBucket++;
  }
}

// products on a page take that page's hero
for (const [pageNo, { hero, ambiguous, page }] of heroesByPage) {
  for (const num of skusOnPage.get(pageNo) ?? []) {
    const sku = byOrder.get(num);
    if (!sku || sku.row_type !== "product") continue;
    propose(num, {
      image: hero,
      match_method: "page_hero",
      low_confidence: ambiguous,
      provenance: {
        pdf_page: pageNo,
        pdf_image: hero.src,
        image_bbox: { top: hero.top, left: hero.left, width: hero.w, height: hero.h },
        note: ambiguous
          ? "largest of several large photos on the page — page depicts more than one variant"
          : "single large photo at the top of the page, depicts the product family",
        page_size: { width: page.width, height: page.height },
      },
    });
  }
}

// a family's hero also covers its variants on continuation pages that carry no photo
const heroBySubfamily = new Map();
const heroByFamily = new Map();
for (const [pageNo, entry] of heroesByPage) {
  for (const num of skusOnPage.get(pageNo) ?? []) {
    const sku = byOrder.get(num);
    if (!sku || sku.row_type !== "product") continue;
    if (!heroBySubfamily.has(subfamilyKey(sku)))
      heroBySubfamily.set(subfamilyKey(sku), { pageNo, ...entry });
    if (!heroByFamily.has(familyKey(sku))) heroByFamily.set(familyKey(sku), { pageNo, ...entry });
  }
}
for (const sku of skus) {
  if (sku.row_type !== "product") continue;
  const sub = heroBySubfamily.get(subfamilyKey(sku));
  const fam = heroByFamily.get(familyKey(sku));
  const pick = sub ?? fam;
  if (!pick) continue;
  propose(sku.order_number, {
    image: pick.hero,
    match_method: sub ? "family_hero" : "family_hero_loose",
    low_confidence: true,
    provenance: {
      pdf_page: pick.pageNo,
      pdf_image: pick.hero.src,
      image_bbox: {
        top: pick.hero.top,
        left: pick.hero.left,
        width: pick.hero.w,
        height: pick.hero.h,
      },
      note: sub
        ? `photo of subfamily ${sku.family}/${sku.subfamily || "—"} taken from its opening page ${pick.pageNo}`
        : `photo of family ${sku.family} taken from its opening page ${pick.pageNo}; this variant's own page has no photo`,
    },
  });
}

// ---------------------------------------------------------------- 5. encode, deduped by content

// Identity comes from the embedded image bytes, so a shared accessory photo repeated on 18 pages
// yields one output file. The pixels, however, come from rendering the page and cropping the
// placement box: raw extraction drops a PDF soft mask, which turns a transparent background black
// (page 61's GR18S photo did exactly that). Rendering composites it the way a reader sees it.
mkdirSync(IMAGE_DIR, { recursive: true });
for (const f of readdirSync(IMAGE_DIR)) if (f.endsWith(".webp")) rmSync(path.join(IMAGE_DIR, f));

const shaCache = new Map();
function shaOf(file) {
  if (!shaCache.has(file)) {
    shaCache.set(file, createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  return shaCache.get(file);
}

// one representative placement per distinct photo; encode at hero size if used as a hero anywhere
const reps = new Map();
for (const a of assignments.values()) {
  a.sha = shaOf(a.image.file);
  const isHero = a.match_method !== "row_aligned";
  const cur = reps.get(a.sha);
  if (!cur) reps.set(a.sha, { img: a.image, isHero });
  else if (isHero) cur.isHero = true;
}

const repsByPage = new Map();
for (const [sha, rep] of reps) {
  if (!repsByPage.has(rep.img.page)) repsByPage.set(rep.img.page, []);
  repsByPage.get(rep.img.page).push([sha, rep]);
}

const outputName = new Map();
const pageList = [...repsByPage.keys()].sort((a, b) => a - b);
process.stdout.write(
  `Rendering ${pageList.length} pages at ${RENDER_DPI} DPI to crop ${reps.size} photos\n`,
);
for (const [i, pageNo] of pageList.entries()) {
  const prefix = path.join(tmp, `page-${pageNo}`);
  run("pdftoppm", [
    "-r",
    String(RENDER_DPI),
    "-f",
    String(pageNo),
    "-l",
    String(pageNo),
    "-png",
    PDF,
    prefix,
  ]);
  const rendered = readdirSync(tmp)
    .filter((f) => f.startsWith(`page-${pageNo}-`) && f.endsWith(".png"))
    .map((f) => path.join(tmp, f));
  if (!rendered.length) throw new Error(`pdftoppm produced no output for page ${pageNo}`);

  for (const [sha, rep] of repsByPage.get(pageNo)) {
    const { left, top, w, h } = rep.img;
    const name = `sick-${sha.slice(0, 12)}.webp`;
    const max = rep.isHero ? HERO_MAX_PX : THUMB_MAX_PX;
    run("magick", [
      rendered[0],
      "-crop",
      `${Math.round(w * RENDER_SCALE)}x${Math.round(h * RENDER_SCALE)}` +
        `+${Math.round(left * RENDER_SCALE)}+${Math.round(top * RENDER_SCALE)}`,
      "+repage",
      "-resize",
      `${max}x${max}>`, // shrink only; never upscale a small catalog thumbnail
      "-background",
      "white",
      "-alpha",
      "remove",
      "-alpha",
      "off",
      "-quality",
      String(WEBP_QUALITY),
      path.join(IMAGE_DIR, name),
    ]);
    outputName.set(sha, name);
  }
  for (const f of rendered) rmSync(f, { force: true });
  if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${pageList.length} pages\n`);
}

const manifest = {};
for (const sku of skus) {
  const a = assignments.get(sku.order_number);
  if (!a) {
    manifest[sku.order_number] = {
      image: null,
      reason: "no photo for this SKU in the source catalog",
    };
    continue;
  }
  manifest[sku.order_number] = {
    image: outputName.get(a.sha),
    match_method: a.match_method,
    low_confidence: a.low_confidence,
    provenance: a.provenance,
  };
}

// ---------------------------------------------------------------- 6. manifest + report

const methodCounts = {};
for (const v of Object.values(manifest)) {
  const k = v.image ? v.match_method : "none";
  methodCounts[k] = (methodCounts[k] ?? 0) + 1;
}
const withImage = Object.values(manifest).filter((v) => v.image).length;
const totalBytes = readdirSync(IMAGE_DIR)
  .filter((f) => f.endsWith(".webp"))
  .reduce((n, f) => n + readFileSync(path.join(IMAGE_DIR, f)).length, 0);

writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      source_pdf: path.basename(PDF),
      image_dir: path.relative(REPO, IMAGE_DIR),
      generated_by: "scripts/extract-product-images.mjs",
      summary: {
        skus: skus.length,
        with_image: withImage,
        without_image: skus.length - withImage,
        coverage_pct: Number(((withImage / skus.length) * 100).toFixed(1)),
        distinct_images: reps.size,
        image_bytes: totalBytes,
        by_match_method: methodCounts,
      },
      images: manifest,
    },
    null,
    2,
  ) + "\n",
);

process.stdout.write(
  `\nPDF images: ${pages.reduce((n, p) => n + p.images.length, 0)} ` +
    `(skipped ${stats.decorative} page-wide bands, ${stats.pictogram} pictograms, ${stats.noBucket} unused)\n` +
    `Row-aligned matches: ${stats.rowMatched}   pages with a hero photo: ${stats.heroes}\n` +
    `SKUs with an image: ${withImage}/${skus.length} (${((withImage / skus.length) * 100).toFixed(1)}%)\n` +
    `  by method: ${JSON.stringify(methodCounts)}\n` +
    `Distinct images written: ${reps.size} -> ${path.relative(REPO, IMAGE_DIR)} (${(totalBytes / 1e6).toFixed(2)} MB)\n` +
    `Manifest: ${path.relative(REPO, MANIFEST)}\n`,
);

if (!KEEP_TEMP) rmSync(tmp, { recursive: true, force: true });
else process.stdout.write(`Temp kept at ${tmp}\n`);
