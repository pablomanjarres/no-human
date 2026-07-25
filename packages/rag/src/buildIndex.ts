/**
 * Dataset directory → committed index artifact.
 *
 * This is the one module that assembles every other one: load the catalog,
 * render the chunk cards, normalize every spec, optionally add the dense lane,
 * and hand back a {@link SerializedIndex} ready for `index/store.ts` to write.
 *
 * ## The rule that shapes this whole file: the build must not fail
 *
 * The dense lane is a **quality lift, never a dependency**. No API key, no
 * network, a 500, a timeout, a rate limit — every one of those has to produce a
 * *lexical-only index*, not an exception. A lexical-only index answers part
 * numbers exactly (BM25 is better at `GTB6-P4212` than any embedding), answers
 * every structured constraint identically, and cites the same pages. It is a
 * working product. A failed build is not.
 *
 * So the only things that throw here are the ones that would produce a
 * *silently wrong* artifact: an unreadable/malformed dataset (the loader's job),
 * a document/vector misalignment, or an explicit caller abort. Note the
 * asymmetry with the embedding call: `voyageContextEmbed` returning `[]` is a
 * fallback, but the same `[]` when `signal.aborted` is a cancellation and must
 * surface as an error — otherwise `Ctrl-C` would quietly write a lexical-only
 * artifact over a good one and nobody would know why recall dropped.
 *
 * ## Why provenance is re-derived, never asserted
 *
 * `IndexProvenance` is what the agent quotes when it states its own limits
 * ("1,776 SKUs indexed, 0 embedded — lexical retrieval only"). Every count here
 * is measured off the payload actually being written, and
 * `embeddingDimension` is read from a real returned vector rather than from the
 * dimension we *asked* for. An artifact must never be able to disagree with
 * itself about what is in it.
 */

import { buildChunks } from "./corpus/chunker.js";
import { loadCatalog } from "./corpus/loadCatalog.js";
import { hasVoyageKey, voyageContextEmbed } from "./embed/voyageContextEmbed.js";
import { normalizeAll } from "./filter/normalize.js";
import { serializeIndex } from "./index/store.js";
import {
  DEFAULT_CONTEXT_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  type RagChunk,
  type SerializedIndex,
} from "./types.js";

/**
 * Inputs to {@link buildIndex}.
 *
 * Deliberately tiny: the dataset directory is the only required knob, because
 * every other decision (which model, which endpoint) belongs to the environment
 * and is resolved the same way `embed/voyageContextEmbed.ts` resolves it. Two
 * places resolving a model name differently is how provenance starts lying.
 */
export interface BuildIndexOptions {
  /** Directory holding `products.jsonl` + `families.csv`. */
  datasetDir: string;
  /**
   * Set `false` to force a lexical-only build even with a key present.
   *
   * Used by CI, by tests, and by `--no-embed`: it makes an offline, fully
   * deterministic, network-free build an explicit choice rather than an
   * accident of whether a key happened to be exported.
   */
  embed?: boolean;
  /** Caller cancellation. Checked between phases and passed to the embedder. */
  signal?: AbortSignal;
  /** Progress sink. Never receives secrets; safe to wire straight to stderr. */
  onProgress?: (msg: string) => void;
}

/** Reads an env var, treating whitespace-only as absent — mirrors the embedder. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Report progress without ever letting the sink kill the build.
 *
 * A build can take minutes and cost real API spend; a caller whose logger
 * throws (closed stream, broken pipe from `| head`) must not lose all of it.
 */
function report(onProgress: ((msg: string) => void) | undefined, msg: string): void {
  if (onProgress === undefined) return;
  try {
    onProgress(msg);
  } catch {
    // Progress is diagnostics, not product. Swallow and keep building.
  }
}

/** Abort is a caller decision, so it throws rather than degrading silently. */
function throwIfAborted(signal: AbortSignal | undefined, phase: string): void {
  if (signal?.aborted === true) {
    throw new Error(`buildIndex: aborted during ${phase}`);
  }
}

/** A document (one product family) plus the *global* chunk positions it owns. */
interface DocumentSlice {
  documentId: string;
  /** Positions in the full `chunks` array — the alignment the artifact needs. */
  indices: number[];
}

/**
 * Group chunks into documents while keeping each chunk's global position.
 *
 * `chunker.groupChunksByDocument` returns the chunk *objects*, which is what the
 * embedder wants but not what the writer does: `SerializedIndex.vectors[i]`
 * belongs to `chunks[i]` by position and nothing else ties them together. A
 * shifted vector array does not fail — it retrieves plausible, well-cited, wrong
 * parts forever. So the mapping back is done on indices, never by re-matching
 * chunk ids or trusting that the group order equals the chunk order.
 *
 * Tolerant of a non-contiguous document (it merges, matching the chunker), and
 * first-appearance ordered so a rebuild produces a byte-identical artifact.
 */
export function sliceDocuments(chunks: readonly RagChunk[]): DocumentSlice[] {
  const byId = new Map<string, DocumentSlice>();
  const order: DocumentSlice[] = [];
  chunks.forEach((chunk, index) => {
    const existing = byId.get(chunk.documentId);
    if (existing !== undefined) {
      existing.indices.push(index);
      return;
    }
    const slice: DocumentSlice = { documentId: chunk.documentId, indices: [index] };
    byId.set(chunk.documentId, slice);
    order.push(slice);
  });
  return order;
}

/**
 * Build the index artifact for a dataset directory.
 *
 * Always resolves to a usable {@link SerializedIndex}. When the dense lane is
 * unavailable — no key, `embed: false`, or any embedding failure — the result is
 * a lexical-only index whose `provenance.embeddingModel` is `null` and whose
 * `provenance.embeddedChunkCount` is `0`. That is the honest signal downstream
 * code (and the agent) reads to know it must not claim semantic coverage.
 *
 * Rejects only on an unreadable/malformed dataset or an explicit abort.
 */
export async function buildIndex(opts: BuildIndexOptions): Promise<SerializedIndex> {
  const { datasetDir, signal, onProgress } = opts;

  throwIfAborted(signal, "startup");
  report(onProgress, `loading catalog from ${datasetDir}`);
  const catalog = await loadCatalog(datasetDir);
  report(
    onProgress,
    `loaded ${String(catalog.products.length)} SKUs and ${String(catalog.families.length)} families`,
  );

  throwIfAborted(signal, "chunking");
  const chunks = buildChunks(catalog);
  const documents = sliceDocuments(chunks);
  report(
    onProgress,
    `built ${String(chunks.length)} chunks across ${String(documents.length)} documents`,
  );

  throwIfAborted(signal, "normalization");
  const specs = normalizeAll(catalog.products);
  report(onProgress, `normalized ${String(specs.length)} specs`);

  // -- dense lane ------------------------------------------------------------
  // Everything below is optional. `vectors` staying `null` is a complete,
  // shippable outcome, so each bail-out reports *why* and falls through.
  let vectors: (number[] | null)[] | undefined;
  let embeddingModel: string | null = null;
  let embeddingDimension: number | null = null;

  const wantEmbed = opts.embed !== false;
  const keyPresent = hasVoyageKey();

  if (!wantEmbed) {
    report(onProgress, "embedding disabled (embed: false) — building a lexical-only index");
  } else if (!keyPresent) {
    report(
      onProgress,
      "no VOYAGE_API_KEY in the environment — building a lexical-only index (BM25 + the deterministic solver still work offline)",
    );
  } else {
    const model = readEnv("VOYAGE_CONTEXT_MODEL") ?? DEFAULT_CONTEXT_MODEL;
    report(
      onProgress,
      `embedding ${String(documents.length)} documents with ${model} (contextualized, input_type=document)`,
    );

    const payload = documents.map((doc) => doc.indices.map((i) => chunks[i]!.text));
    const embedded = await voyageContextEmbed(payload, {
      model,
      dimension: DEFAULT_EMBEDDING_DIMENSION,
      inputType: "document",
      ...(signal !== undefined ? { signal } : {}),
    });

    // `[]` after an abort is a cancellation, not a degraded lane — see header.
    throwIfAborted(signal, "embedding");

    if (embedded.length !== documents.length) {
      report(
        onProgress,
        "embedding failed (no key, network error, or a partial response) — falling back to a lexical-only index",
      );
    } else {
      const scattered: (number[] | null)[] = chunks.map(() => null);
      let placed = 0;
      let width: number | null = null;
      let misaligned = false;

      for (let d = 0; d < documents.length && !misaligned; d += 1) {
        const slice = documents[d]!;
        const docVectors = embedded[d]!;
        // A document whose vector count does not match its chunk count would
        // attach embeddings to the wrong SKUs. Drop the lane, keep the build.
        if (docVectors.length !== slice.indices.length) {
          misaligned = true;
          break;
        }
        for (let c = 0; c < slice.indices.length; c += 1) {
          const vec = docVectors[c]!;
          if (vec.length === 0) continue;
          width ??= vec.length;
          scattered[slice.indices[c]!] = vec;
          placed += 1;
        }
      }

      if (misaligned) {
        report(
          onProgress,
          "embedding returned a document whose vector count did not match its chunk count — refusing to misattach vectors, falling back to a lexical-only index",
        );
      } else if (placed === 0) {
        report(onProgress, "embedding returned no vectors — falling back to a lexical-only index");
      } else {
        vectors = scattered;
        embeddingModel = model;
        embeddingDimension = width;
        report(
          onProgress,
          `embedded ${String(placed)} of ${String(chunks.length)} chunks at dimension ${String(width)}`,
        );
      }
    }
  }

  const index = serializeIndex({
    provenance: {
      builtAt: new Date().toISOString(),
      sourceDir: catalog.sourceDir,
      // Recomputed by serializeIndex from the payload; passed for completeness.
      chunkCount: chunks.length,
      documentCount: documents.length,
      productCount: catalog.products.length,
      embeddingModel,
      embeddingDimension,
      embeddedChunkCount: 0,
    },
    chunks,
    ...(vectors !== undefined ? { vectors } : {}),
    specs,
    products: catalog.products,
    families: catalog.families,
  });

  report(
    onProgress,
    index.provenance.embeddingModel === null
      ? `index ready — lexical-only (${String(index.provenance.chunkCount)} chunks, no dense lane)`
      : `index ready — hybrid (${String(index.provenance.chunkCount)} chunks, ${String(index.provenance.embeddedChunkCount)} embedded)`,
  );

  return index;
}
