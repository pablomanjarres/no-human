import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrace, fromNdjson, replayTrace, summarizeTrace, toNdjson } from "./trace.js";
import type { Challenge, TraceEvent } from "./types.js";

/** A clock you drive by hand, so every `at` assertion is exact. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

function challenge(verdict: Challenge["verdict"]): Challenge {
  return {
    claim: "Response time is 8 ms slower than the Banner part.",
    severity: verdict === "upheld" ? "major" : "minor",
    field: "responseTimeMs",
    verdict,
    evidence: verdict === "unverifiable" ? "Catalog does not state a response time." : "Catalog page 214.",
  };
}

describe("createTrace", () => {
  it("stamps `at` relative to run start and preserves emit order", () => {
    const clock = fakeClock(5_000);
    const trace = createTrace({ now: clock.now });

    trace.emit({ type: "run.start", label: "run", input: "part_number" });
    clock.advance(12);
    trace.emit({ type: "resolver.start", label: "resolve" });
    clock.advance(30);
    trace.emit({ type: "retrieval.start", label: "retrieve", query: "WTB4" });

    expect(trace.events().map((e) => [e.type, e.at])).toEqual([
      ["run.start", 0],
      ["resolver.start", 12],
      ["retrieval.start", 42],
    ]);
    expect(trace.elapsed()).toBe(42);
  });

  it("clamps `at` monotonic when the clock jumps backwards", () => {
    const clock = fakeClock(1_000);
    const trace = createTrace({ now: clock.now });

    trace.emit({ type: "resolver.start", label: "a" });
    clock.advance(50);
    trace.emit({ type: "solver.start", label: "b", candidateCount: 3 });
    clock.set(900); // NTP step / injected clock going backwards
    trace.emit({ type: "report.ready", label: "c", outcome: "recommendation" });

    const ats = trace.events().map((e) => e.at);
    expect(ats).toEqual([0, 50, 50]);
    for (let i = 1; i < ats.length; i += 1) {
      expect(ats[i]!).toBeGreaterThanOrEqual(ats[i - 1]!);
    }
  });

  it("does not let a throwing onEvent escape, and still records the event", () => {
    const seen: string[] = [];
    const trace = createTrace({
      now: fakeClock().now,
      onEvent: (e) => {
        seen.push(e.type);
        throw new Error("renderer blew up");
      },
    });

    expect(() => {
      trace.emit({ type: "run.start", label: "run", input: "description" });
      trace.emit({ type: "resolver.start", label: "resolve" });
    }).not.toThrow();

    expect(seen).toEqual(["run.start", "resolver.start"]);
    expect(trace.events()).toHaveLength(2);
  });

  it("routes child events into the parent log with prefixed labels", () => {
    const clock = fakeClock();
    const sunk: TraceEvent[] = [];
    const parent = createTrace({ now: clock.now, onEvent: (e) => sunk.push(e) });

    parent.emit({ type: "solver.start", label: "solving", candidateCount: 2 });
    const child = parent.child("WTB4-3P2264");
    clock.advance(5);
    child.emit({ type: "challenger.start", label: "attacking", orderNumber: "1027805" });
    const grandchild = child.child("range");
    clock.advance(5);
    grandchild.emit({ type: "challenger.attack", label: "8 ms slower", challenge: challenge("upheld") });

    expect(parent.events()).toHaveLength(3);
    expect(child.events()).toBe(parent.events());
    expect(parent.events().map((e) => e.label)).toEqual([
      "solving",
      "WTB4-3P2264 · attacking",
      "WTB4-3P2264 › range · 8 ms slower",
    ]);
    expect(sunk.map((e) => e.at)).toEqual([0, 5, 10]);
  });
});

describe("summarizeTrace", () => {
  it("counts tool calls and attacks, and never counts `unverifiable` as upheld", () => {
    const clock = fakeClock();
    const trace = createTrace({ now: clock.now });

    trace.emit({ type: "run.start", label: "run", input: "part_number" });
    trace.emit({ type: "tool.call", label: "search", tool: "search_products", input: {} });
    trace.emit({ type: "tool.result", label: "search", tool: "search_products", summary: "12 hits" });
    trace.emit({ type: "tool.call", label: "solve", tool: "solve_constraints", input: {} });
    trace.emit({ type: "challenger.attack", label: "a1", challenge: challenge("upheld") });
    trace.emit({ type: "challenger.attack", label: "a2", challenge: challenge("refuted") });
    trace.emit({ type: "challenger.attack", label: "a3", challenge: challenge("unverifiable") });
    clock.advance(120);
    trace.emit({ type: "report.ready", label: "done", outcome: "no_equivalent" });

    const summary = summarizeTrace(trace.events());
    expect(summary.toolCalls).toBe(2);
    expect(summary.attacks).toBe(3);
    // The unverifiable attack is an unquantified risk: not a hit, not a pass.
    expect(summary.upheld).toBe(1);
    expect(summary.ms).toBe(120);
    expect(summary.counts["challenger.attack"]).toBe(3);
    expect(summary.counts["tool.call"]).toBe(2);
    expect(summary.counts["solver.start"]).toBeUndefined();
  });

  it("returns zeroed stats for an empty log", () => {
    expect(summarizeTrace([])).toEqual({ counts: {}, ms: 0, toolCalls: 0, attacks: 0, upheld: 0 });
  });
});

describe("ndjson", () => {
  const events: TraceEvent[] = [
    { type: "run.start", at: 0, label: "run", input: "bom" },
    { type: "resolver.question", at: 3, label: "ask", questions: [{ field: "sensingRangeMm", question: "How far?", why: "Range decides the family." }] },
    { type: "challenger.attack", at: 9, label: "a1", challenge: challenge("unverifiable") },
    { type: "error", at: 11, label: "oops", message: "retrieval timed out", recoverable: true },
  ];

  it("round-trips", () => {
    const text = toNdjson(events);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(4);
    expect(fromNdjson(text)).toEqual(events);
  });

  it("tolerates blank lines and CRLF endings", () => {
    const text = events.map((e) => JSON.stringify(e)).join("\r\n");
    expect(fromNdjson(`\n${text}\r\n\n`)).toEqual(events);
  });

  it("returns an empty string / empty array for an empty log", () => {
    expect(toNdjson([])).toBe("");
    expect(fromNdjson("")).toEqual([]);
  });

  it("throws on a malformed line instead of silently dropping evidence", () => {
    expect(() => fromNdjson('{"type":"run.start","at":0,"label":"run"}\n{oops\n')).toThrow(/line 2/);
    expect(() => fromNdjson('{"type":"run.start","label":"run"}\n')).toThrow(/line 1/);
  });
});

describe("replayTrace", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const recorded: TraceEvent[] = [
    { type: "run.start", at: 400, label: "run", input: "part_number" },
    { type: "resolver.start", at: 500, label: "resolve" },
    { type: "solver.start", at: 700, label: "solve", candidateCount: 4 },
  ];

  it("emits the first event immediately and scales the recorded gaps by speed", async () => {
    vi.useFakeTimers();
    const seen: TraceEvent[] = [];
    const done = replayTrace(recorded, { onEvent: (e) => seen.push(e), speed: 2 });

    // Recording starts at 400 ms; replay must not open with 400 ms of blank screen.
    expect(seen).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(49); // gap 100 / speed 2 = 50 ms
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(99); // gap 200 / speed 2 = 100 ms
    expect(seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveLength(3);

    await done;
    expect(seen.map((e) => e.type)).toEqual(["run.start", "resolver.start", "solver.start"]);
  });

  it("drops every delay when speed is non-finite or non-positive", async () => {
    const seen: TraceEvent[] = [];
    await replayTrace(recorded, { onEvent: (e) => seen.push(e), speed: Number.POSITIVE_INFINITY });
    await replayTrace(recorded, { onEvent: (e) => seen.push(e), speed: 0 });
    expect(seen).toHaveLength(6);
  });

  it("stops mid-flight when aborted, resolving rather than throwing", async () => {
    vi.useFakeTimers();
    const seen: TraceEvent[] = [];
    const controller = new AbortController();
    const done = replayTrace(recorded, { onEvent: (e) => seen.push(e), signal: controller.signal });

    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);

    // Nothing leaks after the abort, even once the recorded delays would elapse.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seen).toHaveLength(1);
  });

  it("emits nothing when the signal is already aborted", async () => {
    const seen: TraceEvent[] = [];
    await replayTrace(recorded, { onEvent: (e) => seen.push(e), signal: AbortSignal.abort() });
    expect(seen).toHaveLength(0);
  });

  it("does not let a throwing consumer abort the replay", async () => {
    const seen: TraceEvent[] = [];
    await replayTrace(recorded, {
      speed: Number.POSITIVE_INFINITY,
      onEvent: (e) => {
        seen.push(e);
        throw new Error("panel unmounted");
      },
    });
    expect(seen).toHaveLength(3);
  });
});
