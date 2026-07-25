/**
 * On-disk format for the index artifact.
 *
 * The artifact is **committed to the repo** so the demo starts instantly and
 * runs fully offline — no Voyage call, no PDF parse, no network at all. That one
 * fact drives every decision in this file:
 *
 * - **Vectors are base64 little-endian Float32, written with an explicit
 *   `DataView`.** The artifact is built on one machine and read on another, so
 *   the byte order can never be left to the host. Every big-endian read of a
 *   little-endian float is garbage that still *decodes* — no exception, no
 *   crash, just silently wrong similarity. We pin the endianness on both sides.
 * - **Float32, not JS doubles.** Halving the artifact size is worth ~7 decimal
 *   digits of mantissa on a unit-norm embedding. A reader comparing a
 *   round-tripped vector with `===` against the original doubles will see a
 *   mismatch and think the store is broken: it is not. Round-trip fidelity here
 *   is *Float32* fidelity — see {@link decodeVector}.
 * - **Structure is pretty-printed, vector strings are not split.** A readable
 *   diff on chunk text and provenance is worth the bytes when the artifact is
 *   reviewed in a PR; each base64 vector still occupies exactly one line, so a
 *   re-embed shows up as one changed line per chunk.
 * - **Loading validates alignment before anything reads it.** `vectors[i]`
 *   belongs to `chunks[i]` positionally and nothing else ties them together. An
 *   off-by-one there does not fail — it retrieves plausible-looking wrong parts
 *   forever. That is the worst failure this package can have, so it is a hard
 *   throw at load time, not a warning.
 *
 * Nothing here interprets a spec or ranks anything. This module only moves bytes
 * and refuses to hand back an artifact it cannot vouch for.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type {
  IndexProvenance,
  NormalizedSpec,
  RagChunk,
  SerializedIndex,
  SickFamily,
  SickProduct,
} from "../types.js";

/** Bytes per element in the on-disk vector encoding. Float32, always. */
const FLOAT32_BYTES = 4;

/** The only artifact schema version this build understands. */
const SUPPORTED_VERSION = 1 as const;

/**
 * Strict base64 (RFC 4648) with optional padding.
 *
 * `Buffer.from(s, "base64")` is famously permissive: it skips characters it does
 * not recognise and stops at the first `=`. A vector string corrupted by an
 * editor, a merge conflict marker, or a stray newline would therefore decode to
 * a *shorter but perfectly valid-looking* vector. We reject the input instead.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * What {@link serializeIndex} needs in order to produce a {@link SerializedIndex}.
 *
 * Declared here rather than in `types.ts` because it is an input shape private
 * to the writer: vectors arrive as raw numbers (or a `Float32Array` straight off
 * an embedding call) and only become base64 on the way to disk.
 */
export interface SerializeIndexInput {
  /** How the index was built. `chunkCount` and `embeddedChunkCount` are
   *  recomputed from the actual payload — see {@link serializeIndex}. */
  provenance: IndexProvenance;
  chunks: readonly RagChunk[];
  /** Dense vectors positionally aligned to `chunks`; `null` for chunks with no
   *  embedding, and legal to omit entirely for a lexical-only build. */
  vectors?: readonly (readonly number[] | Float32Array | null)[];
  specs: readonly NormalizedSpec[];
  products: readonly SickProduct[];
  families: readonly SickFamily[];
}

/**
 * Encode one dense vector as base64 little-endian Float32.
 *
 * Endianness is written through a `DataView` with `littleEndian = true` rather
 * than by handing a `Float32Array` to `Buffer` — the latter silently inherits
 * the host byte order, which is correct on every machine we happen to use and
 * wrong the first time it is not. The artifact is committed and read elsewhere;
 * the format must be a property of the file, not of the CPU that wrote it.
 *
 * Throws on a hole or a non-number element (`new Array(3)`, a `JSON.parse` of a
 * malformed vector). Left unchecked, `setFloat32(undefined)` writes `NaN` and
 * poisons every cosine similarity against that chunk with no visible error.
 *
 * @param v Vector components as JS doubles; they are narrowed to Float32.
 * @returns base64 of `v.length * 4` bytes. Empty vector encodes to `""`.
 */
export function encodeVector(v: readonly number[] | Float32Array): string {
  const buffer = new ArrayBuffer(v.length * FLOAT32_BYTES);
  const view = new DataView(buffer);
  for (let i = 0; i < v.length; i += 1) {
    const value = v[i];
    if (typeof value !== "number") {
      throw new Error(
        `encodeVector: element ${String(i)} of ${String(v.length)} is ${
          value === undefined ? "a hole/undefined" : typeof value
        }; refusing to write NaN into the index artifact`,
      );
    }
    view.setFloat32(i * FLOAT32_BYTES, value, true);
  }
  return Buffer.from(buffer).toString("base64");
}

/**
 * Decode a base64 little-endian Float32 vector produced by {@link encodeVector}.
 *
 * **Values come back at Float32 precision, not at the precision they went in
 * with.** `encodeVector([0.1])` then `decodeVector` yields `0.10000000149011612`.
 * That is the format working correctly; compare with a tolerance, never with
 * `===`. It is harmless for retrieval — the error is ~1e-7 relative, far below
 * the gap between any two meaningfully different embeddings.
 *
 * Rejects payloads that are not a whole number of Float32s or that contain
 * non-base64 characters: both mean a truncated or hand-edited artifact, and a
 * silently short vector would misalign every dimension after the damage.
 */
export function decodeVector(s: string): number[] {
  if (!BASE64_RE.test(s)) {
    throw new Error(
      "decodeVector: payload is not valid base64 (the index artifact looks corrupted or hand-edited); rebuild the index",
    );
  }
  const bytes = Buffer.from(s, "base64");
  if (bytes.byteLength % FLOAT32_BYTES !== 0) {
    throw new Error(
      `decodeVector: payload is ${String(bytes.byteLength)} bytes, not a multiple of ${String(
        FLOAT32_BYTES,
      )}; the vector is truncated. Rebuild the index.`,
    );
  }
  // Buffer instances are slices of a shared pool, so the DataView must be scoped
  // to this buffer's own window — `bytes.buffer` alone would read the neighbours.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = new Array<number>(bytes.byteLength / FLOAT32_BYTES);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat32(i * FLOAT32_BYTES, true);
  }
  return out;
}

/**
 * Build the artifact object, encoding vectors and re-deriving the counts in
 * `provenance` from the payload actually being written.
 *
 * The counts are re-derived on purpose. `provenance` is what the agent quotes
 * when it states its own limits ("1,776 SKUs indexed, 1,776 embedded"); if the
 * embedding pass half-failed and the caller passed a stale count, the agent
 * would confidently overstate its coverage. The file should never be able to
 * disagree with itself.
 *
 * Throws when `vectors` is present but not aligned to `chunks` — better to fail
 * the build than to commit a misaligned artifact.
 */
export function serializeIndex(input: SerializeIndexInput): SerializedIndex {
  const chunks = [...input.chunks];
  const rawVectors = input.vectors ?? chunks.map(() => null);
  if (rawVectors.length !== chunks.length) {
    throw new Error(
      `serializeIndex: ${String(rawVectors.length)} vectors for ${String(
        chunks.length,
      )} chunks. Vectors are positionally aligned to chunks; refusing to write a misaligned artifact.`,
    );
  }

  const vectors: (string | null)[] = rawVectors.map((v) => (v === null ? null : encodeVector(v)));
  const embeddedChunkCount = vectors.reduce<number>((n, v) => (v === null ? n : n + 1), 0);

  return {
    version: SUPPORTED_VERSION,
    provenance: {
      ...input.provenance,
      chunkCount: chunks.length,
      embeddedChunkCount,
    },
    chunks,
    vectors,
    specs: [...input.specs],
    products: [...input.products],
    families: [...input.families],
  };
}

/**
 * Render the artifact to the exact JSON text that gets committed.
 *
 * Two-space indent: the diff on chunk text, specs and provenance is the thing a
 * reviewer actually needs to read. Vector strings are single JSON strings and so
 * land one-per-line, never wrapped — a re-embed is one changed line per chunk
 * instead of an unreadable wall.
 */
export function stringifyIndex(index: SerializedIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * Write the artifact, creating the parent directory if needed.
 *
 * Written to a sibling temp file and `rename`d into place: a crash or a full
 * disk halfway through a 20 MB write would otherwise leave a *parseable-prefix*
 * file that some tools half-read. `rename` within a directory is atomic, so the
 * artifact at `path` is always either the old one or the complete new one.
 *
 * Validates before writing — {@link serializeIndex} already enforces alignment,
 * but this function also accepts a hand-assembled {@link SerializedIndex}.
 */
export async function writeIndex(path: string, index: SerializedIndex): Promise<void> {
  validateIndex(index, path);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(tmp, stringifyIndex(index), "utf8");
  await rename(tmp, path);
}

/**
 * Read and validate an index artifact.
 *
 * Async form for the CLI and services; see {@link readIndexSync} for module
 * init. Both go through {@link validateIndex}, so an artifact that loads is an
 * artifact whose vectors are known to line up with its chunks.
 */
export async function readIndex(path: string): Promise<SerializedIndex> {
  const text = await readFile(path, "utf8");
  return validateIndex(parseJson(text, path), path);
}

/**
 * Synchronous read, for callers that need the index available at module scope
 * (the CLI, a test fixture) and cannot await.
 */
export function readIndexSync(path: string): SerializedIndex {
  const text = readFileSync(path, "utf8");
  return validateIndex(parseJson(text, path), path);
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(
      `Index artifact at ${source} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/**
 * Assert that an arbitrary value really is a {@link SerializedIndex}, and return
 * it typed.
 *
 * The check that matters is `vectors.length === chunks.length`. Everything else
 * here is cheap structural sanity; that one is the difference between a working
 * index and one that returns confident, well-cited, *wrong* parts — because a
 * shifted vector array still produces plausible similarity scores. It must be an
 * error at load time, where a human sees it, not a quiet degradation at query
 * time, where nobody does.
 *
 * Every message names the file and says to rebuild, because "rebuild the index"
 * is the only action a caller can actually take.
 */
export function validateIndex(value: unknown, source = "<memory>"): SerializedIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Index artifact at ${source} is not a JSON object.`);
  }
  const index = value as Partial<SerializedIndex>;

  if (index.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Index artifact at ${source} has version ${JSON.stringify(
        index.version,
      )}, but this build only reads version ${String(
        SUPPORTED_VERSION,
      )}. Rebuild the index with \`sick-rag index\`.`,
    );
  }

  for (const key of ["chunks", "vectors", "specs", "products", "families"] as const) {
    if (!Array.isArray(index[key])) {
      throw new Error(
        `Index artifact at ${source} is missing the \`${key}\` array (found ${typeof index[
          key
        ]}). Rebuild the index with \`sick-rag index\`.`,
      );
    }
  }

  const chunks = index.chunks as RagChunk[];
  const vectors = index.vectors as (string | null)[];
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Index artifact at ${source} is misaligned: ${String(vectors.length)} vectors for ${String(
        chunks.length,
      )} chunks. Vectors are matched to chunks by position, so this artifact would attach every embedding to the wrong catalog page. Rebuild the index with \`sick-rag index\`.`,
    );
  }

  if (typeof index.provenance !== "object" || index.provenance === null) {
    throw new Error(
      `Index artifact at ${source} is missing \`provenance\`. Rebuild the index with \`sick-rag index\`.`,
    );
  }

  return index as SerializedIndex;
}

/**
 * Decode every vector in an artifact, preserving `null` for chunks that were
 * never embedded.
 *
 * Nulls are preserved rather than zero-filled so the dense lane can *skip* those
 * chunks. A zero vector is not "no opinion" — it has a defined (zero) cosine
 * similarity with everything, which quietly ranks unembedded chunks against
 * embedded ones. Absent must stay absent all the way down.
 *
 * When `provenance.embeddingDimension` is stated, each decoded vector is checked
 * against it: a wrong-width vector means the artifact mixes two embedding runs,
 * which produces meaningless similarities rather than an obvious error.
 */
export function decodeVectors(index: SerializedIndex): (number[] | null)[] {
  const expected = index.provenance.embeddingDimension;
  return index.vectors.map((encoded, i) => {
    if (encoded === null) return null;
    const vector = decodeVector(encoded);
    if (typeof expected === "number" && vector.length !== expected) {
      const id = index.chunks[i]?.id ?? `#${String(i)}`;
      throw new Error(
        `Index artifact: chunk ${id} has a ${String(
          vector.length,
        )}-dimension vector but provenance declares ${String(
          expected,
        )}. The artifact mixes embedding runs. Rebuild the index with \`sick-rag index\`.`,
      );
    }
    return vector;
  });
}
