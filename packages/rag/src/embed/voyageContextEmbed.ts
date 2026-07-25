/**
 * The dense lane: Voyage **contextualized** chunk embeddings.
 *
 * ## Why contextualized and not plain embeddings
 *
 * A SKU row like `GTB6-N4212 · NPN · Conector macho M8 de 4 polos` is nearly
 * meaningless on its own — it shares 90 % of its tokens with every sibling
 * variant. Voyage's contextualized endpoint embeds a whole *document* (here:
 * one product family) in a single call, so each chunk's vector is conditioned
 * on the family header and its siblings. That is what makes "small plastic
 * background-suppression sensor with an M8 plug" retrieve the G6 rows.
 *
 * ## Why every failure returns `[]` instead of throwing
 *
 * This lane is a **quality lift, never a dependency**. The demo has to run on a
 * plane with no network and no API key. So: no key, DNS failure, 500, HTML
 * error page, truncated body, timeout — every one of them returns `[]`, and the
 * index builder falls back to the lexical (BM25) lane alone. A thrown error
 * here would take down an index build that would otherwise have been perfectly
 * usable.
 *
 * ## Why a *partial* result is treated as a failure
 *
 * If one document comes back with three of its four chunks embedded, the honest
 * options are "vector array with a hole" or "no dense lane". A hole is worse:
 * the affected SKU silently never surfaces in dense retrieval, and nobody
 * notices because the other 1,775 SKUs work fine. Missing lanes are visible in
 * {@link IndexProvenance}; missing rows are not. So any hole → `[]`.
 *
 * Nothing here logs the API key or a response body.
 */

import process from "node:process";

import { DEFAULT_CONTEXT_MODEL, DEFAULT_EMBEDDING_DIMENSION } from "../types.js";

/** Voyage's public API root, used when nothing overrides it. */
const DEFAULT_ENDPOINT = "https://api.voyageai.com/v1";

/** Hard ceiling on one request. Long enough for a 1,000-chunk batch, short
 *  enough that a hung socket cannot stall an index build indefinitely. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Chunks per HTTP request. Voyage caps payload size and token count; batching
 * keeps a 1,776-SKU corpus from being one enormous request that fails whole.
 * Documents are never split across batches — splitting a family would destroy
 * the very context this endpoint exists to provide.
 */
const DEFAULT_MAX_CHUNKS_PER_REQUEST = 1000;

/**
 * The minimal `fetch` surface these lanes use.
 *
 * Declared structurally (rather than as `typeof fetch`) so tests can inject a
 * plain object literal with `ok`/`status`/`json()` and never touch the network.
 * The global `fetch` is assignable to this type.
 */
export type VoyageFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Knobs for {@link voyageContextEmbed}.
 *
 * Every field is optional because the zero-config path (env vars only) is the
 * one the CLI uses; explicit options exist for tests and for callers that must
 * pin a model for reproducibility of a stored index.
 */
export interface VoyageContextEmbedOptions {
  /** Overrides `VOYAGE_CONTEXT_MODEL`, which overrides {@link DEFAULT_CONTEXT_MODEL}. */
  model?: string;
  /** Output vector width. Overrides {@link DEFAULT_EMBEDDING_DIMENSION}. */
  dimension?: number;
  /** API root without a trailing slash. Overrides `VOYAGE_CONTEXT_ENDPOINT`, then `VOYAGE_ENDPOINT`. */
  endpoint?: string;
  /** Overrides `VOYAGE_CONTEXT_API_KEY`, then `VOYAGE_API_KEY`. */
  apiKey?: string;
  /** `"document"` when indexing, `"query"` at search time. Voyage embeds the
   *  two asymmetrically; mixing them up quietly degrades recall. Default `"document"`. */
  inputType?: "document" | "query";
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Max chunks in one HTTP request. Default 1000. */
  maxChunksPerRequest?: number;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: VoyageFetch;
  /** Caller cancellation, combined with the internal timeout. */
  signal?: AbortSignal;
}

/**
 * Embed a list of documents, each already split into chunks.
 *
 * Returns one `number[][]` per input document — a vector per chunk, in chunk
 * order, **positionally aligned to `documents`**. Documents with zero chunks
 * come back as `[]` at their position, so the caller can always index by
 * document number.
 *
 * Returns `[]` (the empty outer array) on *any* failure, which is the caller's
 * unambiguous "there is no dense lane" signal — distinguishable from a
 * successful call because a success always has `documents.length` entries.
 * Never throws.
 *
 * Response entries are re-projected by `(docIndex, chunkIndex)` rather than
 * read positionally: the API is under no obligation to preserve request order,
 * and trusting order would misattribute vectors to the wrong SKUs — an error
 * that produces plausible-looking but wrong retrievals forever after.
 */
export async function voyageContextEmbed(
  documents: string[][],
  opts: VoyageContextEmbedOptions = {},
): Promise<number[][][]> {
  if (!Array.isArray(documents) || documents.length === 0) return [];

  // Reject malformed input before spending a request. A blank chunk is a bug in
  // the chunker, and Voyage rejects empty strings anyway; we do not silently
  // substitute placeholder text, because a placeholder vector is a wrong vector.
  for (const doc of documents) {
    if (!Array.isArray(doc)) return [];
    for (const chunk of doc) {
      if (typeof chunk !== "string" || chunk.trim() === "") return [];
    }
  }

  const populated: number[] = [];
  for (let i = 0; i < documents.length; i += 1) {
    if (documents[i]!.length > 0) populated.push(i);
  }
  // Nothing to embed, but nothing failed either: hand back the aligned shape.
  if (populated.length === 0) return documents.map(() => []);

  const apiKey = resolveApiKey(opts.apiKey);
  if (apiKey === undefined) return [];
  if (opts.signal?.aborted === true) return [];

  const url = `${resolveEndpoint(opts.endpoint)}/contextualizedembeddings`;
  const model = opts.model ?? readEnv("VOYAGE_CONTEXT_MODEL") ?? DEFAULT_CONTEXT_MODEL;
  const dimension = opts.dimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const inputType = opts.inputType ?? "document";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = Math.max(1, opts.maxChunksPerRequest ?? DEFAULT_MAX_CHUNKS_PER_REQUEST);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as VoyageFetch | undefined);
  if (typeof fetchImpl !== "function") return [];

  const embedded: number[][][] = [];
  for (const batch of planBatches(populated, documents, cap)) {
    const docs = batch.map((i) => documents[i]!);
    const result = await requestBatch(docs, {
      url,
      apiKey,
      model,
      dimension,
      inputType,
      timeoutMs,
      fetchImpl,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    // One bad batch poisons the whole index: the surviving batches would form a
    // dense lane that covers some families and silently omits others.
    if (result === null) return [];
    for (const doc of result) embedded.push(doc);
  }

  // Cross-batch width check. Ragged vectors break cosine similarity in ways
  // that look like bad relevance rather than a bug.
  const width = embedded[0]?.[0]?.length;
  if (width === undefined) return [];
  for (const doc of embedded) {
    for (const vec of doc) {
      if (vec.length !== width) return [];
    }
  }

  // Re-expand to the caller's document positions, filling zero-chunk documents.
  const out: number[][][] = [];
  let next = 0;
  for (const doc of documents) {
    if (doc.length === 0) {
      out.push([]);
      continue;
    }
    const vectors = embedded[next];
    next += 1;
    if (vectors === undefined || vectors.length !== doc.length) return [];
    out.push(vectors);
  }
  return out;
}

/**
 * Embed a single search query as a one-chunk document with
 * `input_type: "query"`.
 *
 * Query and document vectors live in the same space only if they are embedded
 * with the matching `input_type`; using `"document"` for a query is a silent
 * recall regression, so this helper exists to make the correct call the easy
 * one.
 *
 * Returns `[]` for blank input or any failure — the caller then runs BM25-only,
 * which is a degraded but correct search rather than a crashed one.
 */
export async function voyageContextEmbedQuery(
  query: string,
  opts: Omit<VoyageContextEmbedOptions, "inputType"> = {},
): Promise<number[]> {
  if (typeof query !== "string" || query.trim() === "") return [];
  const result = await voyageContextEmbed([[query]], { ...opts, inputType: "query" });
  return result[0]?.[0] ?? [];
}

/**
 * Whether a Voyage credential is visible *right now*.
 *
 * The index builder calls this to report which lanes it actually used, so a
 * lexical-only index is an explicit fact in {@link IndexProvenance} rather than
 * a mystery discovered later when recall looks bad. It is deliberately not
 * cached: credentials rotate under long-lived processes, and a stale `false`
 * would disable the dense lane for the rest of the process's life.
 */
export function hasVoyageKey(): boolean {
  return resolveApiKey(undefined) !== undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Reads an env var, treating whitespace-only as absent (a blank `VOYAGE_API_KEY=`
 *  in a `.env` file must behave like "no key", not like a key that 401s). */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Resolved fresh per call so a rotated key is picked up without a restart. */
function resolveApiKey(explicit: string | undefined): string | undefined {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  return readEnv("VOYAGE_CONTEXT_API_KEY") ?? readEnv("VOYAGE_API_KEY");
}

/** Trailing slashes are stripped so `${endpoint}/contextualizedembeddings`
 *  cannot produce a `//` path that some gateways 404 on. */
function resolveEndpoint(explicit: string | undefined): string {
  const raw =
    (typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : undefined) ??
    readEnv("VOYAGE_CONTEXT_ENDPOINT") ??
    readEnv("VOYAGE_ENDPOINT") ??
    DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, "");
}

/**
 * Group document indices into requests of at most `cap` chunks.
 *
 * A single document larger than `cap` is sent alone rather than split: keeping
 * a family intact is the point of the endpoint, so we would rather send an
 * oversized request (and fail open if it is rejected) than quietly embed half a
 * family without its context.
 */
function planBatches(populated: number[], documents: string[][], cap: number): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let count = 0;
  for (const docIndex of populated) {
    const size = documents[docIndex]!.length;
    if (current.length > 0 && count + size > cap) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(docIndex);
    count += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One HTTP round trip. Returns `null` for every failure mode; never throws. */
async function requestBatch(
  docs: string[][],
  cfg: {
    url: string;
    apiKey: string;
    model: string;
    dimension: number;
    inputType: "document" | "query";
    timeoutMs: number;
    fetchImpl: VoyageFetch;
    signal?: AbortSignal;
  },
): Promise<number[][][] | null> {
  const { signal, dispose } = combineSignals(cfg.timeoutMs, cfg.signal);
  try {
    const res = await cfg.fetchImpl(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        inputs: docs,
        model: cfg.model,
        input_type: cfg.inputType,
        output_dimension: cfg.dimension,
      }),
      signal,
    });
    if (res.ok !== true) return null;
    const body = await res.json();
    return projectBatch(
      body,
      docs.map((d) => d.length),
    );
  } catch {
    // Network error, abort, non-JSON body, or a fetch impl that returned junk.
    // All of them mean the same thing to the caller: no dense lane.
    return null;
  } finally {
    dispose();
  }
}

/**
 * Re-project `{ data: [{ index, data: [{ index, embedding }] }] }` into
 * `[docIndex][chunkIndex][dim]`.
 *
 * Returns `null` if anything is off: an out-of-range index, a duplicate slot, a
 * non-finite component, an inconsistent width, or a slot never filled. Every
 * one of those would otherwise become a misattributed or missing vector, and
 * both are invisible at query time.
 */
function projectBatch(body: unknown, chunkCounts: number[]): number[][][] | null {
  const root = asRecord(body);
  if (root === null) return null;
  const data = root["data"];
  if (!Array.isArray(data)) return null;

  const slots: (number[] | null)[][] = chunkCounts.map((n) =>
    new Array<number[] | null>(n).fill(null),
  );
  let width = -1;

  for (const docEntry of data) {
    const doc = asRecord(docEntry);
    if (doc === null) return null;
    const docIndex = doc["index"];
    if (typeof docIndex !== "number" || !Number.isInteger(docIndex)) return null;
    const docSlots = slots[docIndex];
    if (docSlots === undefined) return null;
    const inner = doc["data"];
    if (!Array.isArray(inner)) return null;

    for (const chunkEntry of inner) {
      const chunk = asRecord(chunkEntry);
      if (chunk === null) return null;
      const chunkIndex = chunk["index"];
      if (typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex)) return null;
      if (chunkIndex < 0 || chunkIndex >= docSlots.length) return null;
      if (docSlots[chunkIndex] !== null) return null;
      const vector = asVector(chunk["embedding"]);
      if (vector === null) return null;
      if (width === -1) width = vector.length;
      else if (vector.length !== width) return null;
      docSlots[chunkIndex] = vector;
    }
  }

  const out: number[][][] = [];
  for (const docSlots of slots) {
    const vectors: number[][] = [];
    for (const vector of docSlots) {
      if (vector === null) return null; // partial document → no dense lane
      vectors.push(vector);
    }
    out.push(vectors);
  }
  return out;
}

/** Narrow `unknown` to a plain object (arrays excluded — `data[0]` being an
 *  array instead of an object means the schema changed under us). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A vector must be non-empty and entirely finite: a single `null` or `NaN`
 *  component silently turns every cosine score against it into `NaN`. */
function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) return null;
    out.push(component);
  }
  return out;
}

/**
 * Combine the internal timeout with the caller's signal.
 *
 * Uses `AbortSignal.any` when the runtime has it; the manual fallback exists
 * because without it the caller's cancellation would be ignored, and an
 * abandoned index build would keep issuing paid requests.
 */
function combineSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (external === undefined) return { signal: timeout, dispose: () => {} };

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") {
    return { signal: anyFn.call(AbortSignal, [timeout, external]), dispose: () => {} };
  }

  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (external.aborted || timeout.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }
  external.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    // Listeners must be dropped or a long-lived caller signal accumulates one
    // per request across a full index build.
    dispose: () => {
      external.removeEventListener("abort", onAbort);
      timeout.removeEventListener("abort", onAbort);
    },
  };
}
