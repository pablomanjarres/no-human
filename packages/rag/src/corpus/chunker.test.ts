/**
 * Chunker tests.
 *
 * Every fixture below is a **verbatim row** from `sick-catalog-dataset/products.jsonl`
 * (snake_case → camelCase, `null` → absent), and every family row is a verbatim
 * line of `families.csv`. Nothing is invented: a chunker that looks correct
 * against made-up Spanish is worthless, because the whole job is surviving the
 * catalog's real inconsistencies — mixed casing (`Conmutación` vs
 * `conmutación`), the U+2011 non-breaking hyphen in `BEF‑W100-A`, accessory rows
 * with nothing but a `shortDescription`, and SKUs printed under no family at all.
 *
 * The fixtures are inlined rather than read from disk so this file stays pure
 * and independent of the loader module.
 */

import { describe, expect, it } from "vitest";

import type { Catalog, SickFamily, SickProduct } from "../types.js";
import {
  buildChunks,
  documentIdFor,
  englishKeywords,
  formatMm,
  glossToEnglish,
  groupChunksByDocument,
  NO_FAMILY_KEY,
} from "./chunker.js";

// ---------------------------------------------------------------------------
// Real catalog rows
// ---------------------------------------------------------------------------

const PRODUCTS: SickProduct[] = [
  {
    orderNumber: "1051781",
    typeCode: "GTE6-P4212",
    family: "G6",
    subfamily: "GTE6",
    rowType: "product",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-16",
    pdfPage: 15,
    occurrences: 1,
    alsoOnPages: [],
    productName: "Fotocélula de detección sobre objeto, luz roja visible",
    productUrl: "www.mysick.com/es/G6",
    sensingRangeMaxMm: 300,
    switchingOutput: "PNP",
    outputFunction: "conmutación en claro/oscuro",
    connection: "Conector macho M8 de 4 polos",
    scopeOfDelivery: "Escuadra de fijación de acero inoxidable (1.4301/304) BEF‑W100-A",
    sensorPrinciple: "fotocélula de detección sobre objeto",
    detectionPrinciple: "energética",
    lightType: "luz roja visible",
    lightSpot: "Ø 7 mm (90 mm)",
    adjustment: "ajustador mecánico, 5 revoluciones",
    lowConfidence: [
      "product_name",
      "output_function",
      "sensor_principle",
      "detection_principle",
      "light_type",
      "light_spot",
      "adjustment",
    ],
  },
  {
    orderNumber: "1051782",
    typeCode: "GTE6-N4212",
    family: "G6",
    subfamily: "GTE6",
    rowType: "product",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-16",
    pdfPage: 15,
    occurrences: 1,
    alsoOnPages: [],
    productName: "Fotocélula de detección sobre objeto, luz roja visible",
    productUrl: "www.mysick.com/es/G6",
    sensingRangeMaxMm: 300,
    switchingOutput: "NPN",
    outputFunction: "conmutación en claro/oscuro",
    connection: "Conector macho M8 de 4 polos",
    sensorPrinciple: "fotocélula de detección sobre objeto",
    detectionPrinciple: "energética",
    lightType: "luz roja visible",
    lightSpot: "Ø 7 mm (90 mm)",
    adjustment: "ajustador mecánico, 5 revoluciones",
    lowConfidence: ["product_name", "output_function", "sensor_principle"],
  },
  {
    orderNumber: "1052442",
    typeCode: "GTB6-P4212",
    family: "G6",
    subfamily: "GTB6",
    rowType: "product",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-17",
    pdfPage: 16,
    occurrences: 1,
    alsoOnPages: [],
    productName: "Fotocélula de detección sobre objeto, supresión del fondo, luz roja visible",
    sensingRangeMinMm: 5,
    sensingRangeMaxMm: 250,
    switchingOutput: "PNP",
    outputFunction: "conmutación en claro/oscuro",
    connection: "Conector macho M8 de 4 polos",
    scopeOfDelivery: "Escuadra de fijación de acero inoxidable (1.4301/304) BEF‑W100-A",
    sensorPrinciple: "fotocélula de detección sobre objeto",
    detectionPrinciple: "supresión del fondo",
    lightType: "luz roja visible",
    lightSpot: "Ø 6 mm (100 mm)",
    adjustment: "ajustador mecánico, 5 revoluciones",
    lowConfidence: ["product_name"],
  },
  {
    orderNumber: "1051777",
    typeCode: "GL6-P4112",
    family: "G6",
    subfamily: "GL6",
    rowType: "product",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-18",
    pdfPage: 17,
    occurrences: 1,
    alsoOnPages: [],
    sensingRangeMaxMm: 6000,
    switchingOutput: "PNP",
    outputFunction: "Conmutación en claro/oscuro",
    connection: "Conector macho M8 de 4 polos",
    scopeOfDelivery:
      "Escuadra de fijación de acero inoxidable (1.4301/304) BEF-W100-A, reflector P250",
    sensorPrinciple: "barrera fotoeléctrica de reflexión",
    detectionPrinciple: "lente doble",
    lightType: "luz roja visible",
    lightSpot: "Ø 8 mm (350 mm)",
  },
  {
    orderNumber: "1052450",
    typeCode: "GSE6-P4112",
    family: "G6",
    subfamily: "GSE6",
    rowType: "product",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-19",
    pdfPage: 18,
    occurrences: 1,
    alsoOnPages: [],
    productName: "barrera emisor-receptor, luz roja visible",
    sensingRangeMinMm: 0,
    sensingRangeMaxMm: 15000,
    switchingOutput: "PNP",
    outputFunction: "conmutación en claro/oscuro",
    connection: "Conector macho M8 de 4 polos",
    scopeOfDelivery: "escuadra de fijación de acero inoxidable (1.4301/304) BEF-W100-A",
    sensorPrinciple: "barrera emisor-receptor",
    lightType: "luz roja visible",
    lightSpot: "Ø 375 mm (12 m)",
    lowConfidence: ["product_name"],
  },
  {
    orderNumber: "5311520",
    typeCode: "BEF-W100-A",
    family: "G6",
    rowType: "accessory",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-19",
    pdfPage: 18,
    occurrences: 6,
    alsoOnPages: ["B-34", "B-36", "G-139", "G-144", "G-145"],
    shortDescription:
      "Escuadra de fijación para montaje en pared, acero inoxidable, con material de fijación",
  },
  {
    orderNumber: "5311521",
    typeCode: "BEF-W100-B",
    family: "G6",
    rowType: "accessory",
    category: "Fotocelulas (Photoelectric sensors)",
    section: "B",
    sourcePage: "B-19",
    pdfPage: 18,
    occurrences: 6,
    alsoOnPages: ["B-34", "B-36", "G-139", "G-144", "G-145"],
    shortDescription:
      "Escuadra de fijación para montaje en suelo, acero galvanizado, con material de fijación",
  },
  {
    orderNumber: "6027572",
    typeCode: "IM12-06BPS-NC1",
    family: "IM Inox",
    subfamily: "IM12",
    rowType: "product",
    category: "Sensores de proximidad (Proximity sensors)",
    section: "C",
    sourcePage: "C-79",
    pdfPage: 78,
    occurrences: 1,
    alsoOnPages: [],
    productName: "Sensores de proximidad inductivos",
    productUrl: "www.mysick.com/es/IM_Inox",
    sensingRangeMaxMm: 6,
    switchingOutput: "PNP",
    connection: "Conector macho M12 de 4 polos",
    enclosureRating: "IP 68 / IP 69K",
    housingMaterial: "acero inoxidable (316L/1.4404)",
    otherSpecs: {
      Carcasa: "M12 x 1",
      "Tipo de montaje": "Enrasado",
      "Función de salida": "Normalmente abierto",
    },
    lowConfidence: ["product_name", "enclosure_rating", "housing_material"],
  },
  {
    // Printed under no family heading — section C catch-all.
    orderNumber: "5321869",
    typeCode: "BEF-WG-M12",
    rowType: "accessory",
    category: "Sensores de proximidad (Proximity sensors)",
    section: "C",
    sourcePage: "C-78",
    pdfPage: 77,
    occurrences: 1,
    alsoOnPages: [],
    shortDescription:
      "Placa de fijación para sensores M12, acero galvanizado, sin material de fijación",
  },
  {
    // Printed under no family heading, and no type code either — section M catch-all.
    orderNumber: "6042517",
    rowType: "accessory",
    category: "Soluciones de control de seguridad sens:Control (Safety control)",
    section: "M",
    sourcePage: "M-223",
    pdfPage: 222,
    occurrences: 1,
    alsoOnPages: [],
    shortDescription:
      "Cabezal A: conector macho, USB-A, recto; Cabezal B: conector macho, Mini-USB, recto; Cable: USB, apantallado, 3 m",
    otherSpecs: { Tipo: "Cable de conexión (conector macho - conector macho)" },
    lowConfidence: ["short_description"],
  },
];

const FAMILIES: SickFamily[] = [
  {
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    family: "G6",
    productVariants: 32,
    accessoryRows: 2,
    nPages: 4,
    pages: ["B-16", "B-17", "B-18", "B-19"],
    productUrl: "www.mysick.com/es/G6",
  },
  {
    section: "C",
    category: "Sensores de proximidad (Proximity sensors)",
    family: "IM Inox",
    productVariants: 8,
    accessoryRows: 0,
    nPages: 1,
    pages: ["C-79"],
    productUrl: "www.mysick.com/es/IM_Inox",
  },
  {
    section: "C",
    category: "Sensores de proximidad (Proximity sensors)",
    family: "(sin familia)",
    productVariants: 0,
    accessoryRows: 2,
    nPages: 1,
    pages: ["C-78"],
  },
  {
    section: "M",
    category: "Soluciones de control de seguridad sens:Control (Safety control)",
    family: "(sin familia)",
    productVariants: 0,
    accessoryRows: 5,
    nPages: 1,
    pages: ["M-223"],
  },
];

const CATALOG: Catalog = {
  products: PRODUCTS,
  families: FAMILIES,
  sourceDir: "/tmp/sick-catalog-dataset",
};

const chunks = buildChunks(CATALOG);
const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
const text = (id: string): string => {
  const chunk = byId.get(id);
  if (chunk === undefined) throw new Error(`no chunk ${id}`);
  return chunk.text;
};
const words = (value: string): number => value.trim().split(/\s+/).length;

// ---------------------------------------------------------------------------

describe("document structure", () => {
  it("emits one family card plus one SKU card per product, dropping nothing", () => {
    expect(chunks.filter((c) => c.kind === "sku")).toHaveLength(PRODUCTS.length);
    // G6, IM Inox, C catch-all, M catch-all.
    expect(chunks.filter((c) => c.kind === "family")).toHaveLength(4);
    for (const product of PRODUCTS) {
      expect(byId.has(`sku:${product.orderNumber}`)).toBe(true);
    }
  });

  it("keeps each document contiguous with chunkIndex running 0..n-1 from its family card", () => {
    const seen = new Set<string>();
    let current: string | undefined;
    let expected = 0;
    for (const chunk of chunks) {
      if (chunk.documentId !== current) {
        expect(seen.has(chunk.documentId)).toBe(false); // never revisited
        seen.add(chunk.documentId);
        current = chunk.documentId;
        expected = 0;
        expect(chunk.kind).toBe("family");
        expect(chunk.id).toBe(chunk.documentId);
      }
      expect(chunk.chunkIndex).toBe(expected);
      expected += 1;
    }
  });

  it("groups into the shape the contextualized embedding call takes", () => {
    const documents = groupChunksByDocument(chunks);
    expect(documents.map((d) => d.documentId)).toEqual([
      "family:B:G6",
      "family:C:(sin familia)",
      "family:C:IM Inox",
      "family:M:(sin familia)",
    ]);
    const g6 = documents[0];
    expect(g6?.chunks[0]?.kind).toBe("family");
    expect(g6?.chunks).toHaveLength(8); // 1 family card + 5 variants + 2 accessories
    expect(documents.flatMap((d) => d.chunks)).toHaveLength(chunks.length);
  });

  it("routes family-less SKUs into a per-section catch-all instead of dropping them", () => {
    expect(documentIdFor("M", undefined)).toBe(`family:M:${NO_FAMILY_KEY}`);
    // The two family-less rows are in DIFFERENT sections and must not collapse
    // into one document — their categories have nothing to do with each other.
    expect(byId.get("sku:5321869")?.documentId).toBe("family:C:(sin familia)");
    expect(byId.get("sku:6042517")?.documentId).toBe("family:M:(sin familia)");
    expect(byId.get("sku:6042517")?.family).toBeUndefined();
  });

  it("carries citation fields and never emits empty text", () => {
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0);
      expect(chunk.sourcePage).toMatch(/^[A-N]-\d+$/);
      expect(chunk.pdfPage).toBeGreaterThanOrEqual(0);
    }
    const sku = byId.get("sku:1051781");
    expect(sku?.sourcePage).toBe("B-16");
    expect(sku?.pdfPage).toBe(15);
    expect(sku?.rowType).toBe("product");
  });

  it("is deterministic — same catalog in, identical chunks out", () => {
    expect(buildChunks(CATALOG)).toEqual(chunks);
  });
});

describe("SKU cards", () => {
  it("emits the type code hyphenated AND separator-stripped", () => {
    // A BOM row or a label photo can arrive either way; a lexical index holding
    // only one form misses the highest-precision query this system gets.
    const card = text("sku:1051781");
    expect(card).toContain("GTE6-P4212");
    expect(card).toContain("GTE6P4212");
    expect(text("sku:6027572")).toContain("IM1206BPSNC1");
    // Order number is always present, even for the row with no type code.
    expect(text("sku:6042517")).toContain("6042517");
  });

  it("renders mm in the units an engineer actually types", () => {
    const card = text("sku:1051781"); // ≤ 300 mm
    expect(card).toContain("300 mm");
    expect(card).toContain("30 cm");
    expect(card).toContain("0.3 m");
    // "sees a box at 40 cm" has to be able to reach a 400 mm part.
    expect(formatMm(400)).toContain("40 cm");
    expect(formatMm(400)).toContain("0.4 m");
    // A range keeps both bounds.
    const bgs = text("sku:1052442"); // 5 mm ... 250 mm
    expect(bgs).toContain("5 mm");
    expect(bgs).toContain("250 mm");
    expect(bgs).toContain("25 cm");
    // Nobody says "600 cm", so metres only above a metre.
    expect(formatMm(6000)).toContain("6 m");
    expect(formatMm(6000)).not.toContain("cm");
  });

  it("carries English an engineer would query with", () => {
    expect(text("sku:1051781").toLowerCase()).toContain("photoelectric");
    expect(text("sku:1051781").toLowerCase()).toContain("diffuse");
    expect(text("sku:1051781")).toContain("visible red light");
    expect(text("sku:1051781")).toContain("M8 4-pin male connector");

    const bgs = text("sku:1052442");
    expect(bgs.toLowerCase()).toContain("background suppression");
    expect(bgs).toContain("BGS"); // what a Banner/Keyence datasheet calls it

    expect(text("sku:1051777").toLowerCase()).toContain("retroreflective");
    expect(text("sku:1052450").toLowerCase()).toContain("through-beam");
    expect(text("sku:6027572").toLowerCase()).toContain("inductive");
    expect(text("sku:6027572")).toContain("stainless steel");
    expect(text("sku:6027572")).toContain("M12 4-pin male connector");
  });

  it("keeps the Spanish verbatim so provenance still resolves to the printed page", () => {
    const card = text("sku:1052442");
    expect(card).toContain("supresión del fondo"); // accents intact
    expect(card).toContain("Conector macho M8 de 4 polos");
    expect(card).toContain("Fotocélula de detección sobre objeto");
    expect(text("sku:1051781")).toContain("ajustador mecánico, 5 revoluciones");
  });

  it("includes accessory rows — brackets and cables are part of the solution", () => {
    const bracket = text("sku:5311520");
    expect(bracket).toContain("BEF-W100-A");
    expect(bracket).toContain("BEFW100A");
    expect(bracket).toContain("accessory");
    expect(bracket).toContain("Escuadra de fijación"); // verbatim Spanish
    expect(bracket.toLowerCase()).toContain("mounting bracket"); // English gloss
    expect(bracket).toContain("stainless steel");

    // An accessory's short description is its only content, so it is never
    // dropped by the word budget.
    expect(text("sku:6042517")).toContain("Cabezal A");
    expect(text("sku:6042517").toLowerCase()).toContain("head a");
  });

  it("stays compact and information-dense", () => {
    for (const chunk of chunks.filter((c) => c.kind === "sku")) {
      expect(words(chunk.text)).toBeLessThanOrEqual(150);
    }
    // A fully populated photoelectric row lands in the intended band.
    expect(words(text("sku:1051781"))).toBeGreaterThan(40);
    expect(words(text("sku:1051781"))).toBeLessThan(140);
  });

  it("does not repeat the family's shared prose on every SKU card", () => {
    // Boilerplate across every card destroys BM25 discrimination, so the
    // subfamily/type-code roster stays on the family card only.
    expect(text("family:B:G6")).toContain("subfamilies");
    for (const chunk of chunks.filter((c) => c.kind === "sku")) {
      expect(chunk.text).not.toContain("subfamilies");
    }
  });
});

describe("family cards", () => {
  const card = text("family:B:G6");

  it("carries the shared context every SKU vector in the document inherits", () => {
    expect(card).toContain("G6 family");
    expect(card).toContain("Fotocelulas (Photoelectric sensors)");
    expect(card).toContain("GTE6");
    expect(card).toContain("GTB6");
    expect(card.toLowerCase()).toContain("background suppression");
    expect(card.toLowerCase()).toContain("retroreflective");
    expect(card.toLowerCase()).toContain("through-beam");
  });

  it("prefers the families.csv rollup for counts and pages, and cites the catalog", () => {
    // Counts describe what is actually IN the document (they cannot lie about
    // the chunks below them); pages and the URL come from the families.csv
    // rollup, which spans the whole printed family.
    expect(card).toContain("5 variants, 2 accessories");
    expect(card).toContain("B-16, B-17, B-18, B-19");
    expect(card).toContain("www.mysick.com/es/G6");
  });

  it("states the family's full sensing envelope", () => {
    expect(card).toContain("15000 mm");
    expect(card).toContain("15 m");
  });

  it("renders a readable card for the family-less catch-all", () => {
    const catchAll = text("family:M:(sin familia)");
    expect(catchAll).toContain("section M shared parts");
    expect(catchAll).not.toContain("((sin familia))");
    expect(catchAll.trim().length).toBeGreaterThan(0);
  });
});

describe("gloss", () => {
  it("passes unmapped fragments through verbatim instead of dropping them", () => {
    // Fail open: a term we never mapped must survive into the card, because a
    // silently deleted spec is far worse than an untranslated one.
    const gloss = glossToEnglish(
      "Escuadra de fijación de acero inoxidable (1.4301/304) BEF‑W100-A",
    );
    expect(gloss).toBeDefined();
    expect(gloss).toContain("mounting bracket");
    expect(gloss).toContain("stainless steel");
    expect(gloss).toContain("1.4301/304"); // untranslatable, kept
    expect(gloss).toContain("bef-w100-a"); // U+2011 folded to a plain hyphen
  });

  it("returns undefined when there is nothing to translate", () => {
    // Otherwise every card would carry "IP 67 — IP 67": pure BM25 noise.
    expect(glossToEnglish("IP 67")).toBeUndefined();
    expect(glossToEnglish("Ø 7 mm (90 mm)")).toBeUndefined();
    expect(glossToEnglish("")).toBeUndefined();
    expect(text("sku:6027572")).not.toContain("IP 68 / IP 69K — IP 68 / IP 69K");
  });

  it("survives the catalog's inconsistent casing and accents", () => {
    expect(glossToEnglish("Luz roja visible")).toBe(glossToEnglish("luz roja visible"));
    expect(glossToEnglish("Conmutación en claro/oscuro")).toBe(
      glossToEnglish("conmutación en claro/oscuro"),
    );
  });

  it("reorders pin counts the way an English datasheet writes them", () => {
    expect(glossToEnglish("Conector macho M12 de 4 polos")).toBe("M12 4-pin male connector");
    expect(glossToEnglish("Conector macho M8 de 3 polos")).toBe("M8 3-pin male connector");
    expect(glossToEnglish("Cable de 3 hilos, 2 m, PVC")).toContain("3-wire cable");
  });
});

describe("english keywords", () => {
  it("adds the industry synonyms a competitor datasheet uses", () => {
    const keywords = englishKeywords("fotocélula de detección sobre objeto, supresión del fondo");
    expect(keywords).toContain("photo eye");
    expect(keywords).toContain("background suppression");
    expect(keywords).toContain("BGS");
  });

  it("does not fire on a substring of an unrelated word", () => {
    // "supresión" contains "presion". Without a word-start boundary every
    // background-suppression photo eye in the catalog would advertise itself as
    // a pressure sensor — a confident wrong retrieval.
    expect(englishKeywords("supresión del fondo")).not.toContain("pressure sensor");
    expect(englishKeywords("Sensores de presión")).toContain("pressure sensor");
    for (const chunk of chunks) {
      if (/supresi/i.test(chunk.text)) expect(chunk.text).not.toContain("pressure sensor");
    }
  });

  it("returns an empty list rather than guessing when nothing matches", () => {
    expect(englishKeywords("1.4301/304")).toEqual([]);
  });
});
