/**
 * Tests run against the **real** `sick-catalog-dataset/` — 1,776 SKUs, 110
 * families, 13 sections. Invented fixtures would pass while the shipped
 * artifact was empty, misaligned, or missing a section; the counts below are the
 * actual counts, so a regression in the loader, the chunker, or the grouping
 * shows up here as a number that moved.
 *
 * Everything here builds with `embed: false`: no network, no key, no API spend,
 * and — the point — the lexical-only path is the one that has to keep working
 * when the dense lane is unavailable, so it is the one that gets tested.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { buildIndex, sliceDocuments } from "./buildIndex.js";
import {
  decodeVectors,
  readIndex,
  stringifyIndex,
  validateIndex,
  writeIndex,
} from "./index/store.js";
import type { SerializedIndex } from "./types.js";

/** `packages/rag/src` → repo root. Absolute so the test is cwd-independent. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATASET_DIR = join(REPO_ROOT, "sick-catalog-dataset");

/** Ground truth, read off the dataset itself — see `sick-catalog-dataset/README.md`. */
const EXPECTED_PRODUCTS = 1776;
const EXPECTED_FAMILIES = 110;
/** One document per (section, family) group. */
const EXPECTED_DOCUMENTS = 110;
/** One family card per document plus one card per SKU. */
const EXPECTED_CHUNKS = EXPECTED_PRODUCTS + EXPECTED_DOCUMENTS;

/** A real row: G6 family, page B-16, the diffuse PNP/M8 variant. */
const REAL_ORDER_NUMBER = "1051781";
const REAL_TYPE_CODE = "GTE6-P4212";

describe("buildIndex (lexical-only, real catalog)", () => {
  let index: SerializedIndex;
  let progress: string[];

  beforeAll(async () => {
    progress = [];
    index = await buildIndex({
      datasetDir: DATASET_DIR,
      embed: false,
      onProgress: (msg) => progress.push(msg),
    });
  }, 120_000);

  it("indexes every SKU, family and document in the catalog", () => {
    expect(index.products).toHaveLength(EXPECTED_PRODUCTS);
    expect(index.families).toHaveLength(EXPECTED_FAMILIES);
    expect(index.chunks).toHaveLength(EXPECTED_CHUNKS);
    expect(index.provenance.productCount).toBe(EXPECTED_PRODUCTS);
    expect(index.provenance.documentCount).toBe(EXPECTED_DOCUMENTS);
    expect(index.provenance.chunkCount).toBe(EXPECTED_CHUNKS);
  });

  it("reports the missing dense lane honestly instead of implying coverage", () => {
    expect(index.provenance.embeddingModel).toBeNull();
    expect(index.provenance.embeddingDimension).toBeNull();
    expect(index.provenance.embeddedChunkCount).toBe(0);
    // Nulls, not zero vectors: a zero vector has a defined cosine similarity
    // with everything and would silently rank unembedded chunks.
    expect(index.vectors).toHaveLength(EXPECTED_CHUNKS);
    expect(index.vectors.every((v) => v === null)).toBe(true);
    expect(decodeVectors(index).every((v) => v === null)).toBe(true);
  });

  it("says out loud that it fell back to lexical-only", () => {
    expect(progress.join("\n")).toMatch(/lexical-only/);
  });

  it("gives every chunk non-empty text", () => {
    const blank = index.chunks.filter((c) => c.text.trim() === "");
    expect(blank.map((c) => c.id)).toEqual([]);
  });

  it("carries a citable page on every chunk", () => {
    const uncitable = index.chunks.filter(
      (c) => c.sourcePage.trim() === "" || !Number.isFinite(c.pdfPage),
    );
    expect(uncitable.map((c) => c.id)).toEqual([]);
  });

  it("keeps specs positionally aligned to products", () => {
    expect(index.specs).toHaveLength(index.products.length);
    for (let i = 0; i < index.products.length; i += 1) {
      expect(index.specs[i]?.orderNumber).toBe(index.products[i]?.orderNumber);
    }
  });

  it("renders a real SKU card with its type code and page", () => {
    const chunk = index.chunks.find((c) => c.id === `sku:${REAL_ORDER_NUMBER}`);
    expect(chunk).toBeDefined();
    expect(chunk?.kind).toBe("sku");
    expect(chunk?.sourcePage).toBe("B-16");
    expect(chunk?.text).toContain(REAL_TYPE_CODE);
    // The English gloss is what makes an English query reach a Spanish page.
    expect(chunk?.text.toLowerCase()).toContain("photoelectric");
  });

  it("puts the family card first in every document", () => {
    const seen = new Set<string>();
    for (const chunk of index.chunks) {
      if (seen.has(chunk.documentId)) continue;
      seen.add(chunk.documentId);
      expect(chunk.kind).toBe("family");
      expect(chunk.chunkIndex).toBe(0);
    }
    expect(seen.size).toBe(EXPECTED_DOCUMENTS);
  });

  it("round-trips through the store, on disk and in memory", async () => {
    const reparsed = validateIndex(JSON.parse(stringifyIndex(index)), "<test>");
    expect(reparsed.provenance).toEqual(index.provenance);
    expect(reparsed.chunks).toHaveLength(index.chunks.length);

    const dir = await mkdtemp(join(tmpdir(), "sick-rag-index-"));
    try {
      const path = join(dir, "nested", "rag-index.json");
      await writeIndex(path, index);
      const loaded = await readIndex(path);
      expect(loaded.version).toBe(1);
      expect(loaded.provenance).toEqual(index.provenance);
      expect(loaded.products).toHaveLength(EXPECTED_PRODUCTS);
      expect(loaded.chunks[0]).toEqual(index.chunks[0]);
      expect(loaded.specs[0]).toEqual(index.specs[0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("buildIndex fail-open and abort", () => {
  it("still produces a working index when embedding is requested but no key exists", async () => {
    const saved = {
      VOYAGE_API_KEY: process.env["VOYAGE_API_KEY"],
      VOYAGE_CONTEXT_API_KEY: process.env["VOYAGE_CONTEXT_API_KEY"],
    };
    delete process.env["VOYAGE_API_KEY"];
    delete process.env["VOYAGE_CONTEXT_API_KEY"];
    const progress: string[] = [];
    try {
      const index = await buildIndex({
        datasetDir: DATASET_DIR,
        embed: true,
        onProgress: (msg) => progress.push(msg),
      });
      expect(index.chunks).toHaveLength(EXPECTED_CHUNKS);
      expect(index.provenance.embeddingModel).toBeNull();
      expect(index.provenance.embeddedChunkCount).toBe(0);
      expect(progress.join("\n")).toMatch(/VOYAGE_API_KEY/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 120_000);

  it("does not let a throwing progress sink kill the build", async () => {
    const index = await buildIndex({
      datasetDir: DATASET_DIR,
      embed: false,
      onProgress: () => {
        throw new Error("broken pipe");
      },
    });
    expect(index.chunks).toHaveLength(EXPECTED_CHUNKS);
  }, 120_000);

  it("rejects on an aborted signal rather than writing a partial artifact", async () => {
    await expect(
      buildIndex({
        datasetDir: DATASET_DIR,
        embed: false,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/aborted/);
  });

  it("fails loudly on a dataset directory that does not exist", async () => {
    await expect(
      buildIndex({ datasetDir: join(DATASET_DIR, "does-not-exist"), embed: false }),
    ).rejects.toThrow();
  });
});

describe("sliceDocuments", () => {
  it("maps every chunk to exactly one document, preserving global position", async () => {
    const index = await buildIndex({ datasetDir: DATASET_DIR, embed: false });
    const slices = sliceDocuments(index.chunks);
    expect(slices).toHaveLength(EXPECTED_DOCUMENTS);

    const flat = slices.flatMap((s) => s.indices);
    expect(flat).toHaveLength(index.chunks.length);
    expect(new Set(flat).size).toBe(index.chunks.length);
    // The positions must resolve back to the document they were grouped under —
    // this is the invariant that keeps `vectors[i]` attached to `chunks[i]`.
    for (const slice of slices) {
      for (const i of slice.indices) {
        expect(index.chunks[i]?.documentId).toBe(slice.documentId);
      }
    }
  }, 120_000);
});
