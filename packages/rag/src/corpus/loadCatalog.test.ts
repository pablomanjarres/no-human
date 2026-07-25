import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FAMILIES_FILE,
  PRODUCTS_FILE,
  indexByOrderNumber,
  loadCatalog,
  loadCatalogSync,
  parseCsv,
  parseFamiliesCsv,
  parseProductsJsonl,
} from "./loadCatalog.js";

/** The real dataset — every assertion below is against actual catalog rows. */
const DATASET_DIR = fileURLToPath(new URL("../../../../sick-catalog-dataset/", import.meta.url));

const catalog = loadCatalogSync(DATASET_DIR);
const byOrder = indexByOrderNumber(catalog.products);

/** Reads one verbatim wire line out of the real corpus, for temp-dir fixtures. */
function realJsonlLine(orderNumber: string): string {
  const text = readFileSync(join(DATASET_DIR, PRODUCTS_FILE), "utf8");
  const line = text.split("\n").find((candidate) => candidate.includes(`"${orderNumber}"`));
  if (line === undefined) throw new Error(`fixture row ${orderNumber} not in corpus`);
  return line;
}

/** Writes a throwaway dataset dir and hands back its path plus a cleanup fn. */
function tempDataset(
  productsText: string,
  familiesText: string,
): { dir: string; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sick-catalog-"));
  writeFileSync(join(dir, PRODUCTS_FILE), productsText, "utf8");
  writeFileSync(join(dir, FAMILIES_FILE), familiesText, "utf8");
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const MINIMAL_FAMILIES_CSV =
  "section,category,family,product_variants,accessory_rows,n_pages,pages,product_url\n" +
  "B,Fotocelulas (Photoelectric sensors),G6,32,2,4,B-16;B-17;B-18;B-19,www.mysick.com/es/G6\n";

describe("loadCatalogSync", () => {
  it("loads every SKU and family in the dataset", () => {
    expect(catalog.products).toHaveLength(1776);
    expect(catalog.families).toHaveLength(110);
    expect(new Set(catalog.products.map((p) => p.orderNumber)).size).toBe(1776);
    expect(catalog.products.every((p) => /^\d{7}$/.test(p.orderNumber))).toBe(true);
    expect(catalog.products.filter((p) => p.rowType === "accessory")).toHaveLength(283);
    expect(catalog.products.filter((p) => p.rowType === "product")).toHaveLength(1493);
  });

  it("resolves sourceDir to an absolute path for citations", () => {
    const relative = loadCatalogSync(DATASET_DIR + "/./");
    expect(relative.sourceDir).toBe(catalog.sourceDir);
    expect(catalog.sourceDir.startsWith("/")).toBe(true);
    expect(catalog.sourceDir.endsWith("sick-catalog-dataset")).toBe(true);
  });

  it("translates snake_case wire keys to camelCase fields (1051781 / GTE6-P4212)", () => {
    const gte6 = byOrder.get("1051781");
    expect(gte6).toBeDefined();
    expect(gte6?.typeCode).toBe("GTE6-P4212");
    expect(gte6?.family).toBe("G6");
    expect(gte6?.subfamily).toBe("GTE6");
    expect(gte6?.rowType).toBe("product");
    expect(gte6?.section).toBe("B");
    expect(gte6?.category).toBe("Fotocelulas (Photoelectric sensors)");
    expect(gte6?.sourcePage).toBe("B-16");
    expect(gte6?.pdfPage).toBe(15);
    expect(gte6?.occurrences).toBe(1);
    expect(gte6?.alsoOnPages).toEqual([]);
    expect(gte6?.sensingRangeMaxMm).toBe(300);
    expect(gte6?.switchingOutput).toBe("PNP");
    expect(gte6?.connection).toBe("Conector macho M8 de 4 polos");
    expect(gte6?.lightType).toBe("luz roja visible");
    expect(gte6?.productUrl).toBe("www.mysick.com/es/G6");
    // No wire keys survive onto the product object.
    expect(Object.keys(gte6 ?? {}).some((key) => key.includes("_"))).toBe(false);
  });

  it("leaves specs the catalog never printed absent — not 0, not empty string", () => {
    const gte6 = byOrder.get("1051781");
    // The G6 selection table prints no electrical data at all for this SKU.
    expect(gte6?.supplyVoltageMinV).toBeUndefined();
    expect(gte6?.supplyVoltageMaxV).toBeUndefined();
    expect(gte6?.responseTimeMs).toBeUndefined();
    expect(gte6?.outputCurrentMaxMa).toBeUndefined();
    expect(gte6?.enclosureRating).toBeUndefined();
    expect(gte6?.sensingRangeMinMm).toBeUndefined();
    expect(gte6?.supplyVoltageMinV).not.toBe(0);
    expect(gte6?.enclosureRating).not.toBe("");
    // Absent means the key is not there, so `in` is a truthful presence test.
    expect("supplyVoltageMinV" in (gte6 ?? {})).toBe(false);
    expect("enclosureRating" in (gte6 ?? {})).toBe(false);
  });

  it("turns an explicit wire null into absent (supply_voltage_min_v)", () => {
    // The corpus has 42 rows carrying `supply_voltage_min_v`, one of them null.
    // README's populated count is 41 — that difference is the null.
    const stated = catalog.products.filter((p) => p.supplyVoltageMinV !== undefined);
    expect(stated).toHaveLength(41);
    expect(stated.every((p) => Number.isFinite(p.supplyVoltageMinV))).toBe(true);
    expect(catalog.products.filter((p) => p.supplyVoltageMaxV !== undefined)).toHaveLength(41);
    expect(catalog.products.filter((p) => p.responseTimeMs !== undefined)).toHaveLength(96);
    expect(catalog.products.filter((p) => p.enclosureRating !== undefined)).toHaveLength(429);
    // A null subfamily must not become "".
    const bracket = byOrder.get("5311520");
    expect(bracket?.subfamily).toBeUndefined();
    expect("subfamily" in (bracket ?? {})).toBe(false);
  });

  it("keeps shared-accessory page bookkeeping (5311520 / BEF-W100-A)", () => {
    const bracket = byOrder.get("5311520");
    expect(bracket?.rowType).toBe("accessory");
    expect(bracket?.typeCode).toBe("BEF-W100-A");
    expect(bracket?.occurrences).toBe(6);
    expect(bracket?.alsoOnPages).toEqual(["B-34", "B-36", "G-139", "G-144", "G-145"]);
    expect(bracket?.sourcePage).toBe("B-19");
    expect(bracket?.shortDescription).toContain("Escuadra de fijación");
  });

  it("carries provenance and lowConfidence under camelCase field names", () => {
    const gte6 = byOrder.get("1051781");
    expect(gte6?.provenance?.["sensingRangeMaxMm"]).toBe("≤ 300 mm");
    expect(gte6?.provenance?.["switchingOutput"]).toBe("PNP");
    expect(gte6?.provenance?.["sensing_range_max_mm"]).toBeUndefined();
    expect(gte6?.lowConfidence).toContain("productName");
    expect(gte6?.lowConfidence).toContain("outputFunction");
    expect(gte6?.lowConfidence).not.toContain("product_name");
    // Every low-confidence entry names a field that is actually populated.
    for (const field of gte6?.lowConfidence ?? []) {
      expect(field in (gte6 ?? {})).toBe(true);
    }
  });

  it("flattens the nested other_specs provenance instead of dropping it (1041376)", () => {
    const wtb11 = byOrder.get("1041376");
    expect(wtb11?.otherSpecs).toEqual({ "Transmisor de luz": "LED" });
    // Spanish spec labels are values-as-keys, not field names: left verbatim.
    expect(wtb11?.provenance?.["otherSpecs.Transmisor de luz"]).toBe("LED");
    expect(wtb11?.provenance?.["sensingRangeMinMm"]).toBe("20 mm ... 350 mm");
    expect(wtb11?.sensingRangeMinMm).toBe(20);
    expect(wtb11?.sensingRangeMaxMm).toBe(350);
    // Rows with no extra labelled specs carry no empty record.
    const gte6 = byOrder.get("1051781");
    expect(gte6?.otherSpecs).toBeUndefined();
  });

  it("matches loadCatalog, its async twin", async () => {
    await expect(loadCatalog(DATASET_DIR)).resolves.toEqual(catalog);
  });
});

describe("families.csv", () => {
  it("parses the family rollup (G6)", () => {
    const g6 = catalog.families.find((f) => f.family === "G6");
    expect(g6).toEqual({
      section: "B",
      category: "Fotocelulas (Photoelectric sensors)",
      family: "G6",
      productVariants: 32,
      accessoryRows: 2,
      nPages: 4,
      pages: ["B-16", "B-17", "B-18", "B-19"],
      productUrl: "www.mysick.com/es/G6",
    });
  });

  it("treats an empty product_url cell as absent, not empty string (W4-3)", () => {
    const w43 = catalog.families.find((f) => f.family === "W4-3");
    expect(w43?.productUrl).toBeUndefined();
    expect("productUrl" in (w43 ?? {})).toBe(false);
    expect(w43?.pages).toEqual(["B-25", "B-26", "B-27", "B-28"]);
    expect(catalog.families.filter((f) => f.productUrl === undefined)).toHaveLength(27);
  });

  it("every family's pages are non-empty page codes", () => {
    for (const family of catalog.families) {
      expect(family.pages.length).toBeGreaterThan(0);
      expect(family.pages.every((page) => page.trim() !== "")).toBe(true);
    }
  });
});

describe("parseCsv", () => {
  it("handles quoted commas, doubled quotes, embedded newlines, and CRLF", () => {
    const rows = parseCsv('a,"b,1","he said ""hi""","two\nlines"\r\nx,y,z,w\r\n');
    expect(rows.map((row) => row.cells)).toEqual([
      ["a", "b,1", 'he said "hi"', "two\nlines"],
      ["x", "y", "z", "w"],
    ]);
    // Line numbers survive the newline inside the quoted cell.
    expect(rows.map((row) => row.line)).toEqual([1, 3]);
  });

  it("skips blank lines and keeps a final unterminated row", () => {
    const rows = parseCsv("a,b\n\n\nc,d");
    expect(rows.map((row) => row.cells)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseFamiliesCsv", () => {
  it("reads a quoted multi-page pages cell and a quoted category containing a comma", () => {
    const csv =
      "section,category,family,product_variants,accessory_rows,n_pages,pages,product_url\n" +
      '"J","Sensores de registro, contraste (Registration sensors)","KTS",12,3,2,"J-16;J-17;J-18","www.mysick.com/es/KTS"\n';
    const families = parseFamiliesCsv(csv, "fixture.csv");
    expect(families).toEqual([
      {
        section: "J",
        category: "Sensores de registro, contraste (Registration sensors)",
        family: "KTS",
        productVariants: 12,
        accessoryRows: 3,
        nPages: 2,
        pages: ["J-16", "J-17", "J-18"],
        productUrl: "www.mysick.com/es/KTS",
      },
    ]);
  });

  it("resolves columns by header name, not position", () => {
    const csv =
      "pages,family,section,category,n_pages,accessory_rows,product_variants\n" +
      "B-16;B-17,G6,B,Fotocelulas,2,2,32\n";
    const [family] = parseFamiliesCsv(csv, "fixture.csv");
    expect(family?.pages).toEqual(["B-16", "B-17"]);
    expect(family?.productVariants).toBe(32);
    expect(family?.accessoryRows).toBe(2);
  });

  it("fails loudly on a missing column or a non-numeric count", () => {
    expect(() => parseFamiliesCsv("section,category,family\nB,X,G6\n", "fixture.csv")).toThrow(
      /fixture\.csv:1: missing required column "product_variants"/,
    );
    const bad =
      "section,category,family,product_variants,accessory_rows,n_pages,pages,product_url\n" +
      "B,Fotocelulas,G6,,2,4,B-16,\n";
    expect(() => parseFamiliesCsv(bad, "fixture.csv")).toThrow(
      /fixture\.csv:2: family G6: column "product_variants" is not a number/,
    );
  });
});

describe("malformed corpus fails loudly", () => {
  it("names the file and line of a row without a 7-digit order number", () => {
    const good = realJsonlLine("1051781");
    const truncated = good.replace('"order_number": "1051781"', '"order_number": "105178"');
    const text = `${good}\n\n${truncated}\n`;
    const { dir, clean } = tempDataset(text, MINIMAL_FAMILIES_CSV);
    try {
      expect(() => loadCatalogSync(dir)).toThrow(/products\.jsonl:3:/);
      expect(() => loadCatalogSync(dir)).toThrow(/malformed order_number/);
      expect(() => loadCatalogSync(dir)).toThrow(/"105178"/);
    } finally {
      clean();
    }
  });

  it("rejects a row whose order_number key is missing entirely", () => {
    const good = realJsonlLine("1051781");
    const anonymous = good.replace('"order_number": "1051781",', "");
    expect(() => parseProductsJsonl(anonymous, "corpus.jsonl")).toThrow(
      /corpus\.jsonl:1: missing or malformed order_number/,
    );
  });

  it("rejects an unknown row_type rather than guessing", () => {
    const mutated = realJsonlLine("1051781").replace('"row_type": "product"', '"row_type": ""');
    expect(() => parseProductsJsonl(mutated, "corpus.jsonl")).toThrow(/row_type must be/);
  });

  it("reports the line of a syntactically broken JSON row", () => {
    const good = realJsonlLine("1051781");
    expect(() => parseProductsJsonl(`${good}\n{oops\n`, "corpus.jsonl")).toThrow(
      /corpus\.jsonl:2: not valid JSON/,
    );
  });

  it("skips blank lines without renumbering the ones that matter", () => {
    const good = realJsonlLine("1051781");
    const products = parseProductsJsonl(`\n${good}\n\n   \n`, "corpus.jsonl");
    expect(products).toHaveLength(1);
    expect(products[0]?.orderNumber).toBe("1051781");
  });
});

describe("indexByOrderNumber", () => {
  it("indexes every SKU exactly once", () => {
    expect(byOrder.size).toBe(1776);
    expect(byOrder.get("1051781")?.typeCode).toBe("GTE6-P4212");
    expect(byOrder.get("0000000")).toBeUndefined();
  });

  it("keeps the first row when a SKU repeats (products_all_rows shape)", () => {
    const first = byOrder.get("5311520");
    expect(first).toBeDefined();
    const duplicated = indexByOrderNumber([
      first!,
      { ...first!, sourcePage: "G-145", pdfPage: 144 },
    ]);
    expect(duplicated.size).toBe(1);
    expect(duplicated.get("5311520")?.sourcePage).toBe("B-19");
  });
});
