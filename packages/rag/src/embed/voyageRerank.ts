/**
 * The rerank lane: Voyage's cross-encoder over `(query, candidate)` pairs.
 *
 * Bi-encoder retrieval (BM25 + dense, fused with RRF) is cheap and recall-
 * oriented; a cross-encoder reads the query and the candidate *together* and is
 * far better at precision on the top slice. So this runs last, over a few dozen
 * survivors, to reorder them.
 *
 * ## It still does not pick the part
 *
 * A rerank score is a similarity, and similarity never decides correctness in
 * this package. Reordering candidates is all this lane may do; the deterministic
 * constraint solver is what says whether a SKU actually satisfies "PNP, IP69K,
 * under 12 ms".
 *
 * ## Why the fallback is the identity ranking, not `[]`
 *
 * By the time we get here the caller already holds a perfectly usable order —
 * the RRF fusion of the lanes that did work. Returning `[]` on failure would
 * force every caller to write "if empty, fall back to what I had", and the
 * first caller to forget that branch would show the user zero results because a
 * *bonus* HTTP call failed. Returning the input order with strictly descending
 * placeholder scores means one code path: sort by score, always. A no-network
 * run and a successful run differ only in quality, never in shape.
 *
 * Nothing here logs the API key or a response body.
 */

import process from "node:process";

import { DEFAULT_RERANK_MODEL } from "../types.js";
import type { VoyageFetch } from "./voyageContextEmbed.js";

/** Voyage's public API root, used when nothing overrides it. */
const DEFAULT_ENDPOINT = "https://api.voyageai.com/v1";

/** Same ceiling as the embedding lane: a stalled rerank must not outlive the
 *  search request it is decorating. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One reranked candidate.
 *
 * `index` refers to the position in the `documents` array that was passed in —
 * the caller maps it back to its own hit objects. `score` is comparable only
 * *within* one result set: on the fallback path these are synthetic placeholders
 * that encode order and nothing else, so never threshold on an absolute value.
 */
export interface RerankResult {
  index: number;
  score: number;
}

/** Knobs for {@link voyageRerank}. All optional; env vars cover the CLI path. */
export interface VoyageRerankOptions {
  /** Overrides `VOYAGE_RERANK_MODEL`, which overrides {@link DEFAULT_RERANK_MODEL}. */
  model?: string;
  /** API root without a trailing slash. Overrides `VOYAGE_RERANK_ENDPOINT`, then `VOYAGE_ENDPOINT`. */
  endpoint?: string;
  /** Overrides `VOYAGE_RERANK_API_KEY`, then `VOYAGE_API_KEY`. */
  apiKey?: string;
  /** How many reranked results to keep. Applied to the fallback too, so the
   *  result length does not change depending on whether the network worked. */
  topK?: number;
  /** Request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: VoyageFetch;
  /** Caller cancellation, combined with the internal timeout. */
  signal?: AbortSignal;
}

/**
 * Rerank `documents` against `query` with Voyage's cross-encoder.
 *
 * Returns `{ index, score }` sorted by descending score. On *any* failure —
 * missing key, non-2xx, malformed body, network error, timeout, abort — returns
 * the identity ranking: every input index in input order, with strictly
 * descending placeholder scores. Never throws.
 *
 * The only case that yields `[]` is an empty `documents` array, because the
 * identity ranking of nothing is nothing.
 */
export async function voyageRerank(
  query: string,
  documents: string[],
  opts: VoyageRerankOptions = {},
): Promise<RerankResult[]> {
  if (!Array.isArray(documents) || documents.length === 0) return [];
  const limit = resolveLimit(opts.topK, documents.length);
  const fallback = identityRanking(documents.length, limit);

  if (typeof query !== "string" || query.trim() === "") return fallback;
  for (const doc of documents) {
    // A blank candidate is a chunker bug; Voyage rejects it, so skip the round
    // trip and hand back the order the caller already had.
    if (typeof doc !== "string" || doc.trim() === "") return fallback;
  }

  const apiKey = resolveApiKey(opts.apiKey);
  if (apiKey === undefined) return fallback;
  if (opts.signal?.aborted === true) return fallback;

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as VoyageFetch | undefined);
  if (typeof fetchImpl !== "function") return fallback;

  const url = `${resolveEndpoint(opts.endpoint)}/rerank`;
  const model = opts.model ?? readEnv("VOYAGE_RERANK_MODEL") ?? DEFAULT_RERANK_MODEL;
  const { signal, dispose } = combineSignals(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_k: limit,
        // We already hold the text; echoing it back doubles the response size
        // for no gain and risks logging catalog content we did not need to move.
        return_documents: false,
      }),
      signal,
    });
    if (res.ok !== true) return fallback;
    const parsed = parseRerank(await res.json(), documents.length, limit);
    return parsed ?? fallback;
  } catch {
    return fallback;
  } finally {
    dispose();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Input order with strictly descending scores in `(0, 1]`.
 *
 * Strictly descending matters: a caller that sorts by score must get a stable,
 * unambiguous order back, and equal scores would let an unstable sort scramble
 * the RRF ranking this fallback is meant to preserve.
 */
function identityRanking(total: number, limit: number): RerankResult[] {
  const out: RerankResult[] = [];
  for (let i = 0; i < Math.min(limit, total); i += 1) {
    out.push({ index: i, score: (total - i) / total });
  }
  return out;
}

/** `top_k` must be a positive integer no larger than the candidate count;
 *  anything else means "all of them" rather than an error. */
function resolveLimit(topK: number | undefined, total: number): number {
  if (typeof topK !== "number" || !Number.isFinite(topK) || topK < 1) return total;
  return Math.min(total, Math.floor(topK));
}

/**
 * Parse `{ data: [{ index, relevance_score }] }`.
 *
 * Returns `null` — meaning "use the fallback" — on anything unexpected: a
 * non-integer or out-of-range index, a duplicate index, a non-finite score, or
 * an empty result set for a non-empty request. Results are re-sorted here
 * rather than trusted, so a caller may rely on descending order regardless of
 * what the service sent.
 */
function parseRerank(body: unknown, total: number, limit: number): RerankResult[] | null {
  const root = asRecord(body);
  if (root === null) return null;
  const data = root["data"];
  if (!Array.isArray(data) || data.length === 0) return null;

  const seen = new Set<number>();
  const out: RerankResult[] = [];
  for (const entry of data) {
    const row = asRecord(entry);
    if (row === null) return null;
    const index = row["index"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= total) {
      return null;
    }
    if (seen.has(index)) return null;
    seen.add(index);
    const score = row["relevance_score"];
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    out.push({ index, score });
  }

  // Ties broken by input index so the output is deterministic run to run.
  out.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
  return out.slice(0, limit);
}

/** Blank env values are treated as absent — see the embedding lane. */
function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Resolved fresh per call so a rotated key is picked up without a restart. */
function resolveApiKey(explicit: string | undefined): string | undefined {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  return readEnv("VOYAGE_RERANK_API_KEY") ?? readEnv("VOYAGE_API_KEY");
}

/** Trailing slashes stripped so the joined path cannot contain `//`. */
function resolveEndpoint(explicit: string | undefined): string {
  const raw =
    (typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : undefined) ??
    readEnv("VOYAGE_RERANK_ENDPOINT") ??
    readEnv("VOYAGE_ENDPOINT") ??
    DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, "");
}

/** Plain-object narrowing; arrays are rejected because `data[0]` being an array
 *  means the response schema is not what we think it is. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Combine the internal timeout with the caller's signal.
 *
 * Duplicated from the embedding lane on purpose: these two files are the
 * package's only network surface, and each must be able to fail open entirely
 * on its own without importing runtime code from the other.
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
    dispose: () => {
      external.removeEventListener("abort", onAbort);
      timeout.removeEventListener("abort", onAbort);
    },
  };
}
