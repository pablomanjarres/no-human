import { describe, expect, it } from "vitest";

import type { RagChunk } from "../types.js";
import { buildBm25Index, processBm25Term, tokenizeForBm25 } from "./bm25Index.js";

/**
 * Chunks built from REAL rows of `sick-catalog-dataset/products.jsonl`
 * (order numbers 1051781, 1052442, 1058200, 2063403), rendered the way the
 * corpus layer renders an SKU chunk. Nothing here is invented: every spec
 * string is the verbatim Spanish printed in the 2015/2016 catalog.
 */
const CHUNKS: RagChunk[] = [
  {
    // products.jsonl line 1 — page B-16
    id: "sku:1051781",
    kind: "sku",
    documentId: "family:B:G6",
    chunkIndex: 0,
    orderNumber: "1051781",
    family: "G6",
    rowType: "product",
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    sourcePage: "B-16",
    pdfPage: 15,
    text: [
      "GTE6-P4212 · Referencia 1051781 · Familia G6 / GTE6",
      "Fotocélula de detección sobre objeto, luz roja visible",
      "Principio del sensor: fotocélula de detección sobre objeto",
      "Principio de detección: energética",
      "Alcance de detección: ≤ 300 mm",
      "Salida conmutada: PNP · Tipo de conmutación: conmutación en claro/oscuro",
      "Conexión: Conector macho M8 de 4 polos",
      "Tipo de luz: luz roja visible",
    ].join(" · "),
  },
  {
    // products.jsonl — order number 1052442, page B-17
    id: "sku:1052442",
    kind: "sku",
    documentId: "family:B:G6",
    chunkIndex: 1,
    orderNumber: "1052442",
    family: "G6",
    rowType: "product",
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    sourcePage: "B-17",
    pdfPage: 16,
    text: [
      "GTB6-P4212 · Referencia 1052442 · Familia G6 / GTB6",
      "Fotocélula de detección sobre objeto, supresión del fondo, luz roja visible",
      "Principio de detección: supresión del fondo",
      "Alcance de detección: 5 mm ... 250 mm",
      "Salida conmutada: PNP · Conexión: Conector macho M8 de 4 polos",
      "Tipo de luz: luz roja visible",
    ].join(" · "),
  },
  {
    // products.jsonl — order number 1058200, page B-61
    id: "sku:1058200",
    kind: "sku",
    documentId: "family:B:GR18S",
    chunkIndex: 0,
    orderNumber: "1058200",
    family: "GR18S",
    rowType: "product",
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    sourcePage: "B-61",
    pdfPage: 60,
    text: [
      "GRTE18S-P2342 · Referencia 1058200 · Familia GR18S / GRTE18S",
      "Fotocélula cilíndrica GR18S",
      "Alcance de detección: 5 mm ... 550 mm",
      "Salida conmutada: PNP · Conmutación en claro",
      "Conexión: M12 de 3 pines",
      "Clase de protección: IP 67 · Material de la carcasa: metal",
      "Ajuste: potenciómetro, 270°",
    ].join(" · "),
  },
  {
    // products.jsonl — order number 2063403, page B-32 (accessory, reflector)
    id: "sku:2063403",
    kind: "sku",
    documentId: "family:B:W4S-3",
    chunkIndex: 0,
    orderNumber: "2063403",
    family: "W4S-3",
    rowType: "accessory",
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    sourcePage: "B-32",
    pdfPage: 31,
    text: [
      "PLH25-M12 · Referencia 2063403 · Familia W4S-3",
      "Reflector de acero inoxidable, diseño higiénico, resistente a productos químicos,",
      "grado de protección IP 69K, rosca adaptadora M12, 25 mm x 25 mm,",
      "acero inoxidable V4A (1.4404, 316L)",
    ].join(" "),
  },
];

const index = buildBm25Index(CHUNKS);

describe("tokenizeForBm25", () => {
  it("emits the parts of a type code and their joined form", () => {
    // This is the whole reason for the custom tokenizer: MiniSearch's default
    // would keep "GTE6-P4212" as a single opaque token.
    expect(tokenizeForBm25("GTE6-P4212")).toEqual(["gte6", "p4212", "gte6p4212"]);
    expect(tokenizeForBm25("W4S-3")).toEqual(["w4s", "3", "w4s3"]);
    expect(tokenizeForBm25("IP67/M12")).toEqual(["ip67", "m12", "ip67m12"]);
  });

  it("folds Spanish diacritics instead of shredding the word", () => {
    // Without folding, [a-z0-9] splitting turns "fotocélula" into "fotoc"+"lula".
    expect(tokenizeForBm25("Fotocélula de detección")).toEqual(["fotocelula", "de", "deteccion"]);
    expect(tokenizeForBm25("energética diseño higiénico")).toEqual([
      "energetica",
      "diseno",
      "higienico",
    ]);
  });

  it("glues a short alpha prefix onto a following number", () => {
    // The catalog prints "IP 67"; engineers type "IP67". Both sides must
    // produce the same token or the query silently matches nothing.
    expect(tokenizeForBm25("IP 67")).toEqual(["ip", "67", "ip67"]);
    expect(tokenizeForBm25("IP 69K")).toEqual(["ip", "69k", "ip69k"]);
    expect(tokenizeForBm25("M 12")).toEqual(["m", "12", "m12"]);
    // Long words are never glued to a following number.
    expect(tokenizeForBm25("alcance 300 mm")).toEqual(["alcance", "300", "mm"]);
  });

  it("keeps a plain word whole", () => {
    expect(tokenizeForBm25("Salida conmutada PNP")).toEqual(["salida", "conmutada", "pnp"]);
  });
});

describe("processBm25Term", () => {
  it("never stems or stopwords a token containing a digit", () => {
    // ip67 must survive intact: stemming it would fuse distinct ratings, and
    // stopwording it would delete the exact term an engineer searches for.
    expect(processBm25Term("ip67")).toBe("ip67");
    expect(processBm25Term("69k")).toBe("69k");
    expect(processBm25Term("m12")).toBe("m12");
    expect(processBm25Term("m8")).toBe("m8");
    expect(processBm25Term("gte6")).toBe("gte6");
    expect(processBm25Term("p4212")).toBe("p4212");
    expect(processBm25Term("gte6p4212")).toBe("gte6p4212");
    expect(processBm25Term("1051781")).toBe("1051781");
    expect(processBm25Term("w4s")).toBe("w4s");
  });

  it("stems English plurals / -ing / -ed only lightly", () => {
    expect(processBm25Term("sensors")).toBe("sensor");
    expect(processBm25Term("cables")).toBe("cable");
    expect(processBm25Term("switching")).toBe("switch");
    expect(processBm25Term("shielded")).toBe("shield");
    expect(processBm25Term("frequencies")).toBe("frequency");
    // Guards against over-stemming.
    expect(processBm25Term("series")).toBe("series");
    expect(processBm25Term("speed")).toBe("speed");
    expect(processBm25Term("class")).toBe("class");
    expect(processBm25Term("focus")).toBe("focus");
    expect(processBm25Term("ring")).toBe("ring");
  });

  it("keeps domain words and drops only function words", () => {
    expect(processBm25Term("sensor")).toBe("sensor");
    expect(processBm25Term("luz")).toBe("luz");
    expect(processBm25Term("roja")).toBe("roja");
    expect(processBm25Term("fondo")).toBe("fondo");
    expect(processBm25Term("sin")).toBe("sin");
    expect(processBm25Term("de")).toBeNull();
    expect(processBm25Term("del")).toBeNull();
    expect(processBm25Term("the")).toBeNull();
    // Single characters carry no lexical signal.
    expect(processBm25Term("a")).toBeNull();
  });
});

describe("buildBm25Index", () => {
  it("finds a real type code hyphenated, spaced and stripped", () => {
    for (const query of ["GTE6-P4212", "gte6 p4212", "gte6p4212", "GTE6P4212"]) {
      const hits = index.search(query, 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.index).toBe(0);
    }
  });

  it("distinguishes sibling variants of the same family", () => {
    // GTB6 and GTE6 differ by three characters and share almost all their prose.
    expect(index.search("GTB6-P4212", 5)[0]?.index).toBe(1);
    expect(index.search("GRTE18S-P2342", 5)[0]?.index).toBe(2);
  });

  it("retrieves by order number", () => {
    expect(index.search("2063403", 5)[0]?.index).toBe(3);
  });

  it("keeps IP ratings distinguishable", () => {
    expect(index.search("IP 69K", 5)[0]?.index).toBe(3);
    expect(index.search("IP 67", 5)[0]?.index).toBe(2);
    expect(index.search("ip67", 5)[0]?.index).toBe(2);
  });

  it("matches accented catalog text from an unaccented query", () => {
    const hits = index.search("fotocelula cilindrica", 5);
    expect(hits[0]?.index).toBe(2);
  });

  it("ranks the background-suppression variant first for its principle", () => {
    expect(index.search("supresión del fondo", 5)[0]?.index).toBe(1);
  });

  it("respects topK and returns hits best-first", () => {
    const hits = index.search("fotocélula de detección sobre objeto", 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  it("normalizes out MiniSearch's matched-term multiplier", () => {
    // Textbook BM25: a two-term query scores as the SUM of its term scores.
    // Without the fix, MiniSearch would return twice that for the same doc,
    // making scores meaningless across queries of different lengths.
    // Scored on chunk 0 (GTE6-P4212) specifically — `p4212` alone actually
    // ranks the shorter GTB6-P4212 chunk first, which is correct BM25 behavior
    // and beside the point here.
    const scoreOfChunk0 = (query: string): number => {
      const hit = index.search(query, 10).find((h) => h.index === 0);
      expect(hit).toBeDefined();
      return hit!.score;
    };
    expect(scoreOfChunk0("gte6 p4212")).toBeCloseTo(
      scoreOfChunk0("gte6") + scoreOfChunk0("p4212"),
      10,
    );
  });

  it("breaks exact score ties by ascending index", () => {
    // Shared accessories are printed verbatim on several pages, so byte-identical
    // chunk texts — and therefore exact score ties — really do occur.
    const duplicated = buildBm25Index([CHUNKS[3]!, CHUNKS[3]!, CHUNKS[0]!]);
    const hits = duplicated.search("reflector acero inoxidable", 3);
    expect(hits[0]?.index).toBe(0);
    expect(hits[1]?.index).toBe(1);
    expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 12);
  });

  it("returns [] for a blank query, a stopword-only query, topK <= 0, and no matches", () => {
    expect(index.search("", 5)).toEqual([]);
    expect(index.search("   ", 5)).toEqual([]);
    expect(index.search("de la con", 5)).toEqual([]);
    expect(index.search("GTE6-P4212", 0)).toEqual([]);
    expect(index.search("GTE6-P4212", -1)).toEqual([]);
    expect(index.search("keyence fibra plc", 5)).toEqual([]);
  });

  it("survives an empty corpus", () => {
    const empty = buildBm25Index([]);
    expect(empty.size).toBe(0);
    expect(empty.search("GTE6-P4212", 5)).toEqual([]);
  });

  it("reports its size", () => {
    expect(index.size).toBe(CHUNKS.length);
  });
});
