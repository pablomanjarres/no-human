import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { IndexProvenance, NormalizedSpec, RagChunk, SickFamily, SickProduct } from "../types.js";
import {
  decodeVector,
  decodeVectors,
  encodeVector,
  readIndex,
  readIndexSync,
  serializeIndex,
  stringifyIndex,
  validateIndex,
  writeIndex,
  type SerializeIndexInput,
} from "./store.js";

// ---------------------------------------------------------------------------
// Fixtures transcribed verbatim from sick-catalog-dataset/products.jsonl.
// Real rows, not invented ones: order numbers, page codes and pdf page indices
// are the ones the citations in a demo answer would actually point at.
// ---------------------------------------------------------------------------

/** `products.jsonl` line 1 — G6 diffuse photoelectric sensor, page B-16. */
const GTE6: SickProduct = {
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
  sensorPrinciple: "fotocélula de detección sobre objeto",
  detectionPrinciple: "energética",
  lightType: "luz roja visible",
  lowConfidence: ["product_name", "output_function", "sensor_principle", "detection_principle", "light_type"],
};

/** Dx35 mid-range distance sensor, page H-162. Note the unstated response time:
 *  the catalog prints it only as a slash-list in `other_specs`. */
const DT35: SickProduct = {
  orderNumber: "1057652",
  typeCode: "DT35-B15251",
  family: "Dx35",
  subfamily: "DT35",
  rowType: "product",
  category: "Sensores de distancia (Distance sensors)",
  section: "H",
  sourcePage: "H-162",
  pdfPage: 161,
  occurrences: 1,
  alsoOnPages: [],
  productName: "Sensores de distancia de medio alcance",
  productUrl: "www.mysick.com/es/Dx35",
  sensingRangeMinMm: 50,
  sensingRangeMaxMm: 12000,
  switchingOutput: "1 x / 2 x en contrafase: PNP/ NPN (100 mA), IO-Link 3)",
  lightType: "Láser rojo, clase 2",
  otherSpecs: { "Tiempo de respuesta": "2,5 ms / 6,5 ms / 12,5 ms / 24,5 ms / 96,5 ms" },
  lowConfidence: ["product_name", "sensing_range_min_mm", "sensing_range_max_mm"],
};

/** A shared accessory: mounting bracket printed on six different pages. */
const BRACKET: SickProduct = {
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
};

const CHUNKS: RagChunk[] = [
  {
    id: "sku:1051781",
    kind: "sku",
    documentId: "family:B:G6",
    chunkIndex: 0,
    text: "GTE6-P4212 · G6 · fotocélula de detección sobre objeto · PNP · Conector macho M8 de 4 polos · ≤ 300 mm",
    orderNumber: "1051781",
    family: "G6",
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    rowType: "product",
    sourcePage: "B-16",
    pdfPage: 15,
  },
  {
    id: "sku:1057652",
    kind: "sku",
    documentId: "family:H:Dx35",
    chunkIndex: 0,
    text: "DT35-B15251 · Dx35 · sensor de distancia de medio alcance · láser rojo clase 2 · 50 mm ... 12.000 mm",
    orderNumber: "1057652",
    family: "Dx35",
    section: "H",
    category: "Sensores de distancia (Distance sensors)",
    rowType: "product",
    sourcePage: "H-162",
    pdfPage: 161,
  },
  {
    id: "sku:5311520",
    kind: "sku",
    documentId: "family:B:G6",
    chunkIndex: 1,
    text: "BEF-W100-A · escuadra de fijación para montaje en pared, acero inoxidable",
    orderNumber: "5311520",
    family: "G6",
    section: "B",
    category: "Fotocelulas (Photoelectric sensors)",
    rowType: "accessory",
    sourcePage: "B-19",
    pdfPage: 18,
  },
];

const SPECS: NormalizedSpec[] = [
  {
    orderNumber: "1051781",
    outputType: "PNP",
    connector: "M8",
    connectorPins: 4,
    sensingRangeMaxMm: 300,
    principle: "diffuse",
    light: "red",
    lowConfidence: ["principle", "light"],
  },
  {
    orderNumber: "1057652",
    outputType: "PNP/NPN",
    ioLink: true,
    outputCurrentMaxMa: 100,
    sensingRangeMinMm: 50,
    sensingRangeMaxMm: 12000,
    principle: "laser-distance",
    light: "laser",
    lowConfidence: ["sensingRangeMinMm", "sensingRangeMaxMm"],
  },
  // The bracket states nothing machine-comparable. Everything is unknown, and
  // that is a legitimate, representable state — not an error.
  { orderNumber: "5311520", lowConfidence: [] },
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
];

const PROVENANCE: IndexProvenance = {
  builtAt: "2026-07-25T12:00:00.000Z",
  sourceDir: "/home/pablo/no-human/sick-catalog-dataset",
  chunkCount: 3,
  documentCount: 2,
  productCount: 3,
  embeddingModel: "voyage-context-3",
  embeddingDimension: 4,
  embeddedChunkCount: 2,
};

/** Vectors aligned to CHUNKS: the accessory was never embedded. */
const VECTORS: (number[] | null)[] = [
  [0.1, -0.25, 0, 1],
  [-1, 0.5, 0.125, -0.0625],
  null,
];

function input(overrides: Partial<SerializeIndexInput> = {}): SerializeIndexInput {
  return {
    provenance: PROVENANCE,
    chunks: CHUNKS,
    vectors: VECTORS,
    specs: SPECS,
    products: [GTE6, DT35, BRACKET],
    families: FAMILIES,
    ...overrides,
  };
}

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sick-rag-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------

describe("encodeVector / decodeVector", () => {
  it("pins little-endian Float32 byte order regardless of host", () => {
    // 1.0f LE = 00 00 80 3F; 2.0f LE = 00 00 00 40. Hard-coded so a big-endian
    // (or host-order) regression fails here instead of silently in retrieval.
    expect(encodeVector([1])).toBe("AACAPw==");
    expect(encodeVector([1, 2])).toBe("AACAPwAAAEA=");
    expect(decodeVector("AACAPwAAAEA=")).toEqual([1, 2]);
  });

  it("round-trips negatives, zeros and fractions to Float32 precision", () => {
    const original = [0.1, -0.25, 0, -0.0, 1, -1, 0.3333333333333333, 12000];
    const decoded = decodeVector(encodeVector(original));

    expect(decoded).toHaveLength(original.length);
    for (const [i, want] of original.entries()) {
      expect(decoded[i]).toBeCloseTo(want, 6);
    }
    // Exactness only holds against the Float32 projection — this is the line a
    // reader who expected `toEqual(original)` needs to see.
    expect(decoded).toEqual(Array.from(new Float32Array(original)));
    expect(decoded[0]).not.toBe(0.1);
  });

  it("round-trips tiny and huge magnitudes", () => {
    const original = [1e-38, -1e-38, 3.4028234663852886e38, -3.4028234663852886e38, 1e-45];
    const decoded = decodeVector(encodeVector(original));
    expect(decoded).toEqual(Array.from(new Float32Array(original)));
    // Float32 max and the smallest subnormal survive exactly; doubles outside
    // the Float32 range would become Infinity, so this is the honest boundary.
    expect(decoded[2]).toBe(3.4028234663852886e38);
    expect(Number.isFinite(decoded[0])).toBe(true);
  });

  it("handles a 1024-dimension vector (the production width)", () => {
    const original = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 32);
    const encoded = encodeVector(original);
    expect(encoded).not.toContain("\n");
    const decoded = decodeVector(encoded);
    expect(decoded).toHaveLength(1024);
    expect(decoded[1023]).toBeCloseTo(original[1023]!, 6);
  });

  it("accepts a Float32Array straight off an embedding call", () => {
    expect(encodeVector(new Float32Array([1, 2]))).toBe("AACAPwAAAEA=");
  });

  it("encodes the empty vector as the empty string", () => {
    expect(encodeVector([])).toBe("");
    expect(decodeVector("")).toEqual([]);
  });

  it("refuses holes instead of silently writing NaN", () => {
    const sparse = new Array<number>(3);
    sparse[0] = 1;
    expect(() => encodeVector(sparse)).toThrow(/hole\/undefined/);
  });

  it("rejects a truncated payload rather than returning a short vector", () => {
    // "AACAPw==" is 4 bytes; drop a base64 char and it decodes to 3.
    expect(() => decodeVector("AACAP")).toThrow(/not a multiple of 4/);
  });

  it("rejects non-base64 corruption", () => {
    expect(() => decodeVector("AACA Pw==")).toThrow(/not valid base64/);
    expect(() => decodeVector("<<<<<<< HEAD")).toThrow(/not valid base64/);
  });
});

describe("serializeIndex", () => {
  it("encodes vectors positionally and preserves nulls", () => {
    const index = serializeIndex(input());
    expect(index.version).toBe(1);
    expect(index.vectors).toHaveLength(index.chunks.length);
    expect(index.vectors[2]).toBeNull();
    expect(index.chunks[0]?.id).toBe("sku:1051781");
    expect(decodeVector(index.vectors[0]!)[3]).toBeCloseTo(1, 6);
  });

  it("re-derives chunkCount and embeddedChunkCount so provenance cannot overstate coverage", () => {
    const index = serializeIndex(
      input({ provenance: { ...PROVENANCE, chunkCount: 999, embeddedChunkCount: 999 } }),
    );
    expect(index.provenance.chunkCount).toBe(3);
    expect(index.provenance.embeddedChunkCount).toBe(2);
    expect(index.provenance.sourceDir).toBe(PROVENANCE.sourceDir);
  });

  it("supports a lexical-only build with no vectors at all", () => {
    const index = serializeIndex({
      provenance: { ...PROVENANCE, embeddingModel: null, embeddingDimension: null },
      chunks: CHUNKS,
      specs: SPECS,
      products: [GTE6, DT35, BRACKET],
      families: FAMILIES,
    });
    expect(index.vectors).toEqual([null, null, null]);
    expect(index.provenance.embeddedChunkCount).toBe(0);
    expect(decodeVectors(index)).toEqual([null, null, null]);
  });

  it("refuses to build a misaligned artifact", () => {
    expect(() => serializeIndex(input({ vectors: [[1, 2, 3, 4]] }))).toThrow(/misaligned artifact/);
  });
});

describe("decodeVectors", () => {
  it("preserves nulls so the dense lane can skip unembedded chunks", () => {
    const decoded = decodeVectors(serializeIndex(input()));
    expect(decoded).toHaveLength(3);
    expect(decoded[2]).toBeNull();
    expect(decoded[1]).toEqual(Array.from(new Float32Array(VECTORS[1]!)));
  });

  it("throws when a vector's width disagrees with the declared dimension", () => {
    const index = serializeIndex(input());
    index.vectors[1] = encodeVector([1, 2, 3, 4, 5, 6]);
    expect(() => decodeVectors(index)).toThrow(/sku:1057652/);
    expect(() => decodeVectors(index)).toThrow(/mixes embedding runs/);
  });

  it("skips the width check when the build declares no dimension", () => {
    const index = serializeIndex(input({ provenance: { ...PROVENANCE, embeddingDimension: null } }));
    expect(decodeVectors(index)[0]).toHaveLength(4);
  });
});

describe("validateIndex", () => {
  it("throws on a version it cannot read", () => {
    const bad = { ...serializeIndex(input()), version: 2 } as unknown;
    expect(() => validateIndex(bad, "/tmp/index.json")).toThrow(/version 2/);
    expect(() => validateIndex(bad, "/tmp/index.json")).toThrow(/only reads version 1/);
  });

  it("throws when vectors and chunks are not the same length", () => {
    const index = serializeIndex(input());
    const bad = { ...index, vectors: index.vectors.slice(0, 2) } as unknown;
    expect(() => validateIndex(bad, "/tmp/index.json")).toThrow(/2 vectors for 3 chunks/);
    expect(() => validateIndex(bad, "/tmp/index.json")).toThrow(/wrong catalog page/);
  });

  it("throws on a missing top-level array", () => {
    const partial: Record<string, unknown> = { ...serializeIndex(input()) };
    delete partial["chunks"];
    expect(() => validateIndex(partial)).toThrow(/missing the `chunks` array/);
  });

  it("throws on non-objects", () => {
    expect(() => validateIndex([], "/tmp/index.json")).toThrow(/not a JSON object/);
    expect(() => validateIndex(null, "/tmp/index.json")).toThrow(/not a JSON object/);
  });
});

describe("writeIndex / readIndex / readIndexSync", () => {
  it("round-trips through a real file", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "nested", "index.json");
    const index = serializeIndex(input());

    await writeIndex(path, index);
    const loaded = await readIndex(path);

    expect(loaded).toEqual(index);
    expect(loaded.products[0]?.typeCode).toBe("GTE6-P4212");
    expect(loaded.products[2]?.alsoOnPages).toEqual(["B-34", "B-36", "G-139", "G-144", "G-145"]);
    expect(loaded.chunks[1]?.sourcePage).toBe("H-162");
    expect(decodeVectors(loaded)[0]).toEqual(Array.from(new Float32Array(VECTORS[0]!)));

    expect(readIndexSync(path)).toEqual(index);
  });

  it("writes a reviewable diff with each vector unbroken on one line", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "index.json");
    const index = serializeIndex(input());
    await writeIndex(path, index);

    const text = await readFile(path, "utf8");
    expect(text).toBe(stringifyIndex(index));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": 1,');
    // The base64 payload must survive as a single JSON string on one line.
    const encoded = index.vectors[0]!;
    const line = text.split("\n").find((l) => l.includes(encoded));
    expect(line?.trim()).toBe(`"${encoded}",`);
  });

  it("leaves no temp files behind", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "index.json");
    await writeIndex(path, serializeIndex(input()));
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["index.json"]);
  });

  it("refuses to write an artifact it could not load back", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "index.json");
    const index = serializeIndex(input());
    const broken = { ...index, vectors: [...index.vectors, null] } as unknown as typeof index;
    await expect(writeIndex(path, broken)).rejects.toThrow(/misaligned/);
  });

  it("reports the file path when the artifact on disk is unreadable", async () => {
    const dir = await makeTmpDir();

    const badVersion = join(dir, "v0.json");
    await writeFile(badVersion, JSON.stringify({ ...serializeIndex(input()), version: 0 }), "utf8");
    await expect(readIndex(badVersion)).rejects.toThrow(badVersion);
    await expect(readIndex(badVersion)).rejects.toThrow(/sick-rag index/);

    const mangled = join(dir, "mangled.json");
    const index = serializeIndex(input());
    await writeFile(mangled, JSON.stringify({ ...index, chunks: index.chunks.slice(0, 1) }), "utf8");
    expect(() => readIndexSync(mangled)).toThrow(/3 vectors for 1 chunks/);

    const notJson = join(dir, "truncated.json");
    await writeFile(notJson, '{"version": 1, "chunks": [', "utf8");
    await expect(readIndex(notJson)).rejects.toThrow(/not valid JSON/);
  });
});
