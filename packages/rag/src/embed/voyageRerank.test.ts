import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_RERANK_MODEL } from "../types.js";
import type { VoyageFetch } from "./voyageContextEmbed.js";
import { voyageRerank, type RerankResult } from "./voyageRerank.js";

// ---------------------------------------------------------------------------
// Real candidate text: the G6 / W4-3 photoelectric rows from
// sick-catalog-dataset/products.jsonl (order numbers 1051781, 1052442,
// 1052443), plus a deliberately off-target encoder row so a rerank has
// something to demote.
// ---------------------------------------------------------------------------

const QUERY = "fotocélula difusa con supresión del fondo, salida NPN, conector M8 de 4 polos";

const CANDIDATES: string[] = [
  "1051781 GTE6-P4212 · G6/GTE6 · fotocélula de detección sobre objeto · energética · luz roja visible · alcance ≤ 300 mm · salida PNP · Conector macho M8 de 4 polos · B-16",
  "1052442 GTB6-P4212 · G6/GTB6 · supresión del fondo · luz roja visible · alcance 5 mm ... 250 mm · salida PNP · Conector macho M8 de 4 polos · B-17",
  "1052443 GTB6-N4212 · G6/GTB6 · supresión del fondo · luz roja visible · alcance 5 mm ... 250 mm · salida NPN · Conector macho M8 de 4 polos · B-17",
  "1036755 DFS60B-S4PA01024 · DFS60 · encoder incremental · resolución 1024 impulsos · interfaz TTL/RS-422 · F-12",
];

type FetchInit = Parameters<VoyageFetch>[1];

interface RecordedCall {
  url: string;
  init: FetchInit;
  body: Record<string, unknown>;
}

function recordingFetch(
  handler: (call: RecordedCall) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>,
): { fetchImpl: VoyageFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: VoyageFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      init,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function okJson(body: unknown): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

/** The identity ranking the fail-open path must produce for N candidates. */
function expectIdentity(results: RerankResult[], total: number, limit = total): void {
  expect(results.map((r) => r.index)).toEqual(Array.from({ length: limit }, (_unused, i) => i));
  for (let i = 1; i < results.length; i += 1) {
    expect(results[i]!.score).toBeLessThan(results[i - 1]!.score);
  }
  for (const result of results) expect(Number.isFinite(result.score)).toBe(true);
}

const ENV_KEYS = [
  "VOYAGE_API_KEY",
  "VOYAGE_RERANK_API_KEY",
  "VOYAGE_RERANK_MODEL",
  "VOYAGE_RERANK_ENDPOINT",
  "VOYAGE_ENDPOINT",
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("voyageRerank — happy path", () => {
  it("returns the service ranking, sorted descending", async () => {
    const { fetchImpl } = recordingFetch(async () =>
      okJson({
        data: [
          { index: 0, relevance_score: 0.41 },
          { index: 2, relevance_score: 0.93 },
          { index: 3, relevance_score: 0.02 },
          { index: 1, relevance_score: 0.77 },
        ],
      }),
    );
    const out = await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl });

    // The NPN background-suppression row wins; the encoder row sinks.
    expect(out.map((r) => r.index)).toEqual([2, 1, 0, 3]);
    expect(out[0]?.score).toBe(0.93);
  });

  it("re-sorts an out-of-order response instead of trusting it", async () => {
    const { fetchImpl } = recordingFetch(async () =>
      okJson({
        data: [
          { index: 3, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.9 },
        ],
      }),
    );
    const out = await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl });
    expect(out).toEqual([
      { index: 1, score: 0.9 },
      { index: 3, score: 0.1 },
    ]);
  });

  it("breaks score ties by input index so runs are reproducible", async () => {
    const { fetchImpl } = recordingFetch(async () =>
      okJson({
        data: [
          { index: 2, relevance_score: 0.5 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: 0.5 },
        ],
      }),
    );
    const out = await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl });
    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("sends the documented request shape and keeps the key out of the body", async () => {
    const { fetchImpl, calls } = recordingFetch(async () =>
      okJson({ data: [{ index: 0, relevance_score: 1 }] }),
    );
    await voyageRerank(QUERY, CANDIDATES, { apiKey: "secret-key", fetchImpl, topK: 2 });

    const call = calls[0];
    expect(call?.url).toBe("https://api.voyageai.com/v1/rerank");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["authorization"]).toBe("Bearer secret-key");
    expect(call?.body["model"]).toBe(DEFAULT_RERANK_MODEL);
    expect(call?.body["query"]).toBe(QUERY);
    expect(call?.body["documents"]).toEqual(CANDIDATES);
    expect(call?.body["top_k"]).toBe(2);
    expect(call?.body["return_documents"]).toBe(false);
    expect(call?.init.body).not.toContain("secret-key");
  });

  it("truncates the service ranking to topK", async () => {
    const { fetchImpl } = recordingFetch(async () =>
      okJson({
        data: [
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.2 },
          { index: 2, relevance_score: 0.3 },
        ],
      }),
    );
    const out = await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl, topK: 2 });
    expect(out.map((r) => r.index)).toEqual([2, 1]);
  });

  it("resolves model and endpoint from options, then env, then defaults", async () => {
    process.env["VOYAGE_ENDPOINT"] = "https://generic.internal/v1";
    process.env["VOYAGE_API_KEY"] = "generic-key";
    const generic = recordingFetch(async () =>
      okJson({ data: [{ index: 0, relevance_score: 1 }] }),
    );
    await voyageRerank(QUERY, CANDIDATES, { fetchImpl: generic.fetchImpl });
    expect(generic.calls[0]?.url).toBe("https://generic.internal/v1/rerank");
    expect(generic.calls[0]?.body["model"]).toBe(DEFAULT_RERANK_MODEL);

    process.env["VOYAGE_RERANK_ENDPOINT"] = "https://rerank.internal/v1/";
    process.env["VOYAGE_RERANK_MODEL"] = "rerank-env";
    process.env["VOYAGE_RERANK_API_KEY"] = "lane-key";
    const lane = recordingFetch(async () => okJson({ data: [{ index: 0, relevance_score: 1 }] }));
    await voyageRerank(QUERY, CANDIDATES, { fetchImpl: lane.fetchImpl });
    expect(lane.calls[0]?.url).toBe("https://rerank.internal/v1/rerank");
    expect(lane.calls[0]?.body["model"]).toBe("rerank-env");
    expect(lane.calls[0]?.init.headers["authorization"]).toBe("Bearer lane-key");
  });
});

describe("voyageRerank — fail-open returns the identity ranking", () => {
  it("falls back with no API key, without touching the network", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => okJson({ data: [] }));
    const out = await voyageRerank(QUERY, CANDIDATES, { fetchImpl });
    expectIdentity(out, CANDIDATES.length);
    expect(calls).toHaveLength(0);
  });

  it("falls back on a non-2xx response", async () => {
    const { fetchImpl } = recordingFetch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ detail: "server error" }),
    }));
    expectIdentity(await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl }), 4);
  });

  it("falls back when the body is not JSON", async () => {
    const { fetchImpl } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    }));
    expectIdentity(await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl }), 4);
  });

  it("falls back on every malformed shape", async () => {
    const shapes: unknown[] = [
      null,
      [],
      { data: null },
      { data: [] },
      { data: [{ index: 0 }] },
      { data: [{ index: "0", relevance_score: 1 }] },
      { data: [{ index: 1.5, relevance_score: 1 }] },
      { data: [{ index: -1, relevance_score: 1 }] },
      { data: [{ index: 99, relevance_score: 1 }] },
      { data: [{ index: 0, relevance_score: Number.NaN }] },
      { data: [{ index: 0, relevance_score: "high" }] },
      {
        data: [
          { index: 0, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.8 },
        ],
      },
    ];
    for (const shape of shapes) {
      const { fetchImpl } = recordingFetch(async () => okJson(shape));
      expectIdentity(await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl }), 4);
    }
  });

  it("falls back when fetch throws", async () => {
    const fetchImpl: VoyageFetch = async () => {
      throw new TypeError("fetch failed");
    };
    expectIdentity(await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl }), 4);
  });

  it("falls back when the request times out", async () => {
    const fetchImpl: VoyageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    expectIdentity(
      await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl, timeoutMs: 5 }),
      4,
    );
  });

  it("falls back for an already-aborted signal without issuing a request", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => okJson({ data: [] }));
    const out = await voyageRerank(QUERY, CANDIDATES, {
      apiKey: "k",
      fetchImpl,
      signal: AbortSignal.abort(),
    });
    expectIdentity(out, 4);
    expect(calls).toHaveLength(0);
  });

  it("falls back for a blank query or a blank candidate, with no request", async () => {
    const { fetchImpl, calls } = recordingFetch(async () => okJson({ data: [] }));
    expectIdentity(await voyageRerank("   ", CANDIDATES, { apiKey: "k", fetchImpl }), 4);
    expectIdentity(
      await voyageRerank(QUERY, [CANDIDATES[0]!, "  "], { apiKey: "k", fetchImpl }),
      2,
    );
    expect(calls).toHaveLength(0);
  });

  it("honors topK in the fallback so the shape does not depend on the network", async () => {
    const { fetchImpl } = recordingFetch(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));
    const out = await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl, topK: 2 });
    expectIdentity(out, CANDIDATES.length, 2);
    expect(out).toHaveLength(2);
  });

  it("returns [] only for an empty candidate list", async () => {
    await expect(voyageRerank(QUERY, [], { apiKey: "k" })).resolves.toEqual([]);
  });

  it("produces a fallback the caller can sort by score without reordering it", async () => {
    const fetchImpl: VoyageFetch = async () => {
      throw new Error("no network");
    };
    const out = await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl });
    const sorted = [...out].sort((a, b) => b.score - a.score);
    expect(sorted).toEqual(out);
  });

  it("never rejects, whatever the transport does", async () => {
    const misbehaving: VoyageFetch[] = [
      async () => undefined as unknown as { ok: boolean; status: number; json(): Promise<unknown> },
      async () =>
        ({ ok: true, status: 200 }) as unknown as {
          ok: boolean;
          status: number;
          json(): Promise<unknown>;
        },
      () => Promise.reject(new Error("boom")),
    ];
    for (const fetchImpl of misbehaving) {
      expectIdentity(await voyageRerank(QUERY, CANDIDATES, { apiKey: "k", fetchImpl }), 4);
    }
  });
});
