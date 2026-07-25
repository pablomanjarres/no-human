import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONTEXT_MODEL, DEFAULT_EMBEDDING_DIMENSION } from "../types.js";
import {
  hasVoyageKey,
  voyageContextEmbed,
  voyageContextEmbedQuery,
  type VoyageFetch,
} from "./voyageContextEmbed.js";

// ---------------------------------------------------------------------------
// Real catalog text. These are the G6 photoelectric rows from
// sick-catalog-dataset/products.jsonl, page B-16/B-17 (order numbers 1051781,
// 1052442, 1052443) rendered the way the chunker renders them.
// ---------------------------------------------------------------------------

const G6_DOC: string[] = [
  "G6 — Fotocelulas (Photoelectric sensors), section B, pages B-16 B-17. Fotocélula de detección sobre objeto, luz roja visible. www.mysick.com/es/G6",
  "1051781 GTE6-P4212 · G6/GTE6 · fotocélula de detección sobre objeto · energética · luz roja visible · alcance ≤ 300 mm · salida PNP · conmutación en claro/oscuro · Conector macho M8 de 4 polos · B-16",
  "1052442 GTB6-P4212 · G6/GTB6 · supresión del fondo · luz roja visible · alcance 5 mm ... 250 mm · salida PNP · Conector macho M8 de 4 polos · B-17",
  "1052443 GTB6-N4212 · G6/GTB6 · supresión del fondo · luz roja visible · alcance 5 mm ... 250 mm · salida NPN · Conector macho M8 de 4 polos · B-17",
];

const W4_DOC: string[] = [
  "W4-3 — Fotocelulas (Photoelectric sensors), section B. Fotocélula de detección sobre objeto con supresión del fondo, luz roja visible.",
  "1053949 WTB4-3P2261 · W4-3 · supresión del fondo · luz roja visible · Conector macho M8 de 4 polos · salida PNP",
];

type FetchInit = Parameters<VoyageFetch>[1];

interface RecordedCall {
  url: string;
  init: FetchInit;
  body: Record<string, unknown>;
}

/** Wraps a handler so every request is captured for assertions. */
function recordingFetch(
  handler: (
    call: RecordedCall,
    callIndex: number,
  ) => Promise<{
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
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function okJson(body: unknown): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body };
}

/** Small deterministic vector; width is what matters, not the values. */
function vec(seed: number): number[] {
  return [seed, seed + 0.5, seed + 0.25, seed + 0.125];
}

/** Builds a well-formed response for the documents in a request body. */
function embedAll(body: Record<string, unknown>, shuffle = false): unknown {
  const inputs = body["inputs"] as string[][];
  const data = inputs.map((chunks, docIndex) => ({
    index: docIndex,
    data: chunks.map((_chunk, chunkIndex) => ({
      index: chunkIndex,
      embedding: vec(docIndex * 100 + chunkIndex),
    })),
  }));
  if (shuffle) {
    data.reverse();
    for (const doc of data) doc.data.reverse();
  }
  return { data };
}

const ENV_KEYS = [
  "VOYAGE_API_KEY",
  "VOYAGE_CONTEXT_API_KEY",
  "VOYAGE_CONTEXT_MODEL",
  "VOYAGE_CONTEXT_ENDPOINT",
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

describe("hasVoyageKey", () => {
  it("is false with no credential in the environment", () => {
    expect(hasVoyageKey()).toBe(false);
  });

  it("treats a blank credential as absent", () => {
    process.env["VOYAGE_API_KEY"] = "   ";
    expect(hasVoyageKey()).toBe(false);
  });

  it("sees the lane-specific key and the generic key", () => {
    process.env["VOYAGE_CONTEXT_API_KEY"] = "ctx-key";
    expect(hasVoyageKey()).toBe(true);
    delete process.env["VOYAGE_CONTEXT_API_KEY"];
    process.env["VOYAGE_API_KEY"] = "generic-key";
    expect(hasVoyageKey()).toBe(true);
  });

  it("re-reads the environment on every call (credentials rotate)", () => {
    expect(hasVoyageKey()).toBe(false);
    process.env["VOYAGE_API_KEY"] = "rotated-in";
    expect(hasVoyageKey()).toBe(true);
  });
});

describe("voyageContextEmbed — happy path", () => {
  it("returns one vector per chunk, positionally aligned to the documents", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed([G6_DOC, W4_DOC], {
      apiKey: "test-key",
      fetchImpl,
    });

    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(G6_DOC.length);
    expect(out[1]).toHaveLength(W4_DOC.length);
    expect(out[0]?.[1]).toEqual(vec(1));
    expect(out[1]?.[0]).toEqual(vec(100));
    expect(calls).toHaveLength(1);
  });

  it("sends the documented request shape without leaking the key into the body", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    await voyageContextEmbed([G6_DOC], { apiKey: "secret-key", fetchImpl });

    const call = calls[0];
    expect(call?.url).toBe("https://api.voyageai.com/v1/contextualizedembeddings");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers["authorization"]).toBe("Bearer secret-key");
    expect(call?.body["inputs"]).toEqual([G6_DOC]);
    expect(call?.body["model"]).toBe(DEFAULT_CONTEXT_MODEL);
    expect(call?.body["input_type"]).toBe("document");
    expect(call?.body["output_dimension"]).toBe(DEFAULT_EMBEDDING_DIMENSION);
    expect(call?.init.body).not.toContain("secret-key");
  });

  it("re-projects by (docIndex, chunkIndex) instead of trusting response order", async () => {
    const { fetchImpl } = recordingFetch(async (call) => okJson(embedAll(call.body, true)));
    const out = await voyageContextEmbed([G6_DOC, W4_DOC], { apiKey: "k", fetchImpl });

    // Shuffled response, identical result: doc 0 chunk 2 is still vec(2).
    expect(out[0]?.[2]).toEqual(vec(2));
    expect(out[1]?.[1]).toEqual(vec(101));
  });

  it("honors option, then env, then default for model and endpoint", async () => {
    process.env["VOYAGE_CONTEXT_MODEL"] = "env-model";
    process.env["VOYAGE_CONTEXT_ENDPOINT"] = "https://proxy.internal/v1/";
    process.env["VOYAGE_API_KEY"] = "env-key";

    const first = recordingFetch(async (call) => okJson(embedAll(call.body)));
    await voyageContextEmbed([W4_DOC], { fetchImpl: first.fetchImpl });
    expect(first.calls[0]?.body["model"]).toBe("env-model");
    expect(first.calls[0]?.url).toBe("https://proxy.internal/v1/contextualizedembeddings");
    expect(first.calls[0]?.init.headers["authorization"]).toBe("Bearer env-key");

    const second = recordingFetch(async (call) => okJson(embedAll(call.body)));
    await voyageContextEmbed([W4_DOC], {
      fetchImpl: second.fetchImpl,
      model: "opt-model",
      endpoint: "https://opt.example/v1",
      apiKey: "opt-key",
    });
    expect(second.calls[0]?.body["model"]).toBe("opt-model");
    expect(second.calls[0]?.url).toBe("https://opt.example/v1/contextualizedembeddings");
  });

  it("returns an aligned empty slot for a document with no chunks, and never sends it", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed([G6_DOC, [], W4_DOC], { apiKey: "k", fetchImpl });

    expect(out).toHaveLength(3);
    expect(out[1]).toEqual([]);
    expect(out[2]).toHaveLength(W4_DOC.length);
    expect(calls[0]?.body["inputs"]).toEqual([G6_DOC, W4_DOC]);
  });
});

describe("voyageContextEmbed — batching", () => {
  it("splits into bounded batches and concatenates in document order", async () => {
    const docs = [G6_DOC, W4_DOC, G6_DOC, W4_DOC]; // 4 + 2 + 4 + 2 chunks
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed(docs, {
      apiKey: "k",
      fetchImpl,
      maxChunksPerRequest: 6,
    });

    expect(calls).toHaveLength(2);
    expect((calls[0]?.body["inputs"] as string[][]).length).toBe(2);
    expect((calls[1]?.body["inputs"] as string[][]).length).toBe(2);
    expect(out).toHaveLength(4);
    expect(out.map((d) => d.length)).toEqual([4, 2, 4, 2]);
    // Third document is the first document of the SECOND batch, so its vectors
    // restart at seed 0 — proof the batches were concatenated, not overlaid.
    expect(out[2]?.[0]).toEqual(vec(0));
    expect(out[3]?.[0]).toEqual(vec(100));
  });

  it("never splits a single document across requests", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed([G6_DOC], {
      apiKey: "k",
      fetchImpl,
      maxChunksPerRequest: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body["inputs"]).toEqual([G6_DOC]);
    expect(out[0]).toHaveLength(4);
  });

  it("discards everything when a later batch fails — a partial index is worse than none", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call, i) =>
      i === 0 ? okJson(embedAll(call.body)) : { ok: false, status: 429, json: async () => ({}) },
    );
    const out = await voyageContextEmbed([G6_DOC, W4_DOC, G6_DOC], {
      apiKey: "k",
      fetchImpl,
      maxChunksPerRequest: 4,
    });

    expect(out).toEqual([]);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("rejects inconsistent vector widths across batches", async () => {
    const { fetchImpl } = recordingFetch(async (call, i) => {
      const inputs = call.body["inputs"] as string[][];
      return okJson({
        data: inputs.map((chunks, docIndex) => ({
          index: docIndex,
          data: chunks.map((_c, chunkIndex) => ({
            index: chunkIndex,
            embedding: i === 0 ? vec(chunkIndex) : [1, 2, 3],
          })),
        })),
      });
    });
    const out = await voyageContextEmbed([G6_DOC, W4_DOC], {
      apiKey: "k",
      fetchImpl,
      maxChunksPerRequest: 4,
    });
    expect(out).toEqual([]);
  });
});

describe("voyageContextEmbed — fail-open paths", () => {
  it("returns [] with no API key and never touches the network", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed([G6_DOC], { fetchImpl });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns [] on a non-2xx response", async () => {
    const { fetchImpl } = recordingFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ detail: "unauthorized" }),
    }));
    await expect(voyageContextEmbed([G6_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
  });

  it("returns [] when the body is not JSON", async () => {
    const { fetchImpl } = recordingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    }));
    await expect(voyageContextEmbed([G6_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
  });

  it("returns [] when the JSON parses but has the wrong shape", async () => {
    const shapes: unknown[] = [
      null,
      [],
      { data: null },
      { data: [{ index: "0", data: [] }] },
      { data: [{ index: 0, data: [{ index: 0, embedding: "not-a-vector" }] }] },
      { data: [{ index: 0, data: [{ index: 0, embedding: [] }] }] },
      { data: [{ index: 0, data: [{ index: 0, embedding: [1, null, 3] }] }] },
      { data: [{ index: 0, data: [{ index: 0, embedding: [1, Number.NaN] }] }] },
      { data: [{ index: 9, data: [{ index: 0, embedding: [1, 2] }] }] },
      { data: [{ index: 0, data: [{ index: 99, embedding: [1, 2] }] }] },
    ];
    for (const shape of shapes) {
      const { fetchImpl } = recordingFetch(async () => okJson(shape));
      await expect(voyageContextEmbed([W4_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
    }
  });

  it("returns [] when a document comes back only partially embedded", async () => {
    const { fetchImpl } = recordingFetch(async (call) => {
      const inputs = call.body["inputs"] as string[][];
      return okJson({
        data: inputs.map((chunks, docIndex) => ({
          index: docIndex,
          // Drop the last chunk of every document: a hole, not a failure, as
          // far as the wire protocol is concerned.
          data: chunks.slice(0, -1).map((_c, chunkIndex) => ({
            index: chunkIndex,
            embedding: vec(chunkIndex),
          })),
        })),
      });
    });
    await expect(voyageContextEmbed([G6_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
  });

  it("returns [] when the same chunk slot is filled twice", async () => {
    const { fetchImpl } = recordingFetch(async () =>
      okJson({
        data: [
          {
            index: 0,
            data: [
              { index: 0, embedding: [1, 2] },
              { index: 0, embedding: [3, 4] },
            ],
          },
        ],
      }),
    );
    await expect(voyageContextEmbed([W4_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
  });

  it("returns [] when fetch throws (DNS/socket failure)", async () => {
    const fetchImpl: VoyageFetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(voyageContextEmbed([G6_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
  });

  it("returns [] when the request times out", async () => {
    const fetchImpl: VoyageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    await expect(
      voyageContextEmbed([G6_DOC], { apiKey: "k", fetchImpl, timeoutMs: 5 }),
    ).resolves.toEqual([]);
  });

  it("returns [] when the caller's signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const fetchImpl: VoyageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        setTimeout(() => controller.abort(), 1);
      });
    await expect(
      voyageContextEmbed([G6_DOC], { apiKey: "k", fetchImpl, signal: controller.signal }),
    ).resolves.toEqual([]);
  });

  it("returns [] for an already-aborted signal without issuing a request", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed([G6_DOC], {
      apiKey: "k",
      fetchImpl,
      signal: AbortSignal.abort(),
    });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns [] for blank or non-string chunks without issuing a request", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    await expect(voyageContextEmbed([["   "]], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
    await expect(
      voyageContextEmbed([[G6_DOC[0]!, 42 as unknown as string]], { apiKey: "k", fetchImpl }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns [] for an empty document list", async () => {
    await expect(voyageContextEmbed([], { apiKey: "k" })).resolves.toEqual([]);
  });

  it("returns aligned empty slots when every document is empty", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const out = await voyageContextEmbed([[], []], { apiKey: "k", fetchImpl });
    expect(out).toEqual([[], []]);
    expect(calls).toHaveLength(0);
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
      await expect(voyageContextEmbed([W4_DOC], { apiKey: "k", fetchImpl })).resolves.toEqual([]);
    }
  });
});

describe("voyageContextEmbedQuery", () => {
  it("embeds one one-chunk document with input_type query", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    const query = "sensor difuso con supresión del fondo, salida PNP, conector M8";
    const out = await voyageContextEmbedQuery(query, { apiKey: "k", fetchImpl });

    expect(out).toEqual(vec(0));
    expect(calls[0]?.body["inputs"]).toEqual([[query]]);
    expect(calls[0]?.body["input_type"]).toBe("query");
  });

  it("returns [] for blank input without issuing a request", async () => {
    const { fetchImpl, calls } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    await expect(voyageContextEmbedQuery("   ", { apiKey: "k", fetchImpl })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns [] with no key and on transport failure", async () => {
    const { fetchImpl } = recordingFetch(async (call) => okJson(embedAll(call.body)));
    await expect(voyageContextEmbedQuery("GTB6-P4212 equivalent", { fetchImpl })).resolves.toEqual(
      [],
    );

    const boom: VoyageFetch = async () => {
      throw new Error("network down");
    };
    await expect(
      voyageContextEmbedQuery("GTB6-P4212 equivalent", { apiKey: "k", fetchImpl: boom }),
    ).resolves.toEqual([]);
  });
});
