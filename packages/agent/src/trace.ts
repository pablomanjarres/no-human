/**
 * The trace bus.
 *
 * Rule 5 of this package says every decision emits a {@link TraceEvent}. That
 * rule only pays off if the log is trivial to consume from a browser: the panel
 * shows extraction counters, constraint chips, challenger attacks landing one at
 * a time, and clickable citations. This module is the plumbing that makes that
 * possible — an append-only, ordered, JSON-serializable log with a stamped
 * clock, plus the three things a demo needs around it (replay, header stats,
 * ndjson persistence).
 *
 * Two invariants hold everywhere in here:
 *
 * 1. **The trace is observability, never control flow.** A consumer that throws
 *    must not take down a run that is otherwise succeeding, so every callback is
 *    invoked behind a swallowing try/catch. If you ever find yourself wanting an
 *    `onEvent` to influence the run, you want a different mechanism.
 * 2. **`at` is monotonic and root-relative.** Every event — including events from
 *    child traces — is stamped in ms since the *run* started, clamped so it can
 *    never go backwards. One clock, one timeline, one ordered log.
 */

import type { TraceEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Distributive `Omit`. The naive `Omit<TraceEvent, "at">` is a trap: `Omit` over
 * a union collapses to the keys *common to every member*, which for
 * {@link TraceEvent} is just `type` and `label` — every payload field silently
 * disappears and callers get excess-property errors on correct code. Distributing
 * over the union first keeps each variant intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a caller passes to {@link Trace.emit}: a {@link TraceEvent} minus its
 * timestamp, because the timestamp is the bus's job and not the caller's.
 *
 * Passing a *full* `TraceEvent` also type-checks (a supertype is assignable to
 * the omitted shape); its `at` is overwritten with the bus's stamp rather than
 * trusted. That is deliberate — replaying an old event through a live trace must
 * not smuggle a stale clock into the timeline. Use {@link replayTrace} for that.
 */
export type TraceEventInput = DistributiveOmit<TraceEvent, "at">;

/** Options for {@link createTrace}. */
export interface CreateTraceOptions {
  /**
   * Live sink, called once per event in emit order. Wrapped in a swallowing
   * try/catch — see the module note on why the trace is never control flow.
   */
  onEvent?: (event: TraceEvent) => void;
  /**
   * Clock, in ms. Injectable so tests are deterministic; nothing else in this
   * package should call `Date.now()` directly, or the trace and the run will
   * disagree about when things happened.
   */
  now?: () => number;
}

/**
 * An append-only event log with a stamped clock.
 *
 * Obtained from {@link createTrace}. Hand it down through the orchestrator, the
 * Resolver and the Challenger; use {@link Trace.child} to scope a per-candidate
 * pass without forking the log.
 */
export interface Trace {
  /**
   * Append an event, stamping `at` as ms since the run started.
   *
   * Never throws, no matter what the configured `onEvent` does.
   */
  emit(event: TraceEventInput): void;
  /**
   * The full ordered log, oldest first.
   *
   * This is a **live view**, not a snapshot: it grows as the run proceeds, which
   * is what lets a UI poll it cheaply. If you need a stable copy — to persist, to
   * diff, or to put on a finished report — take one with
   * `[...trace.events()]`.
   */
  events(): readonly TraceEvent[];
  /** Ms since the run started, on the injected clock. */
  elapsed(): number;
  /**
   * A sub-trace whose events land in the *same* log, with `label` prefixed onto
   * each event's own label (e.g. `"WTB4-3P2264 › resolver · parsing input"`).
   *
   * This is how the panel groups the challenger's per-candidate passes without
   * ever splitting the timeline: the clock, the log and the sink are shared, so
   * a child cannot produce events that are out of order relative to its parent.
   */
  child(label: string): Trace;
}

/** Options for {@link replayTrace}. */
export interface ReplayOptions {
  /** Called once per replayed event, in recorded order. Failures are swallowed. */
  onEvent: (event: TraceEvent) => void;
  /**
   * Playback rate multiplier. `2` runs the trace at double speed, `0.5` at half.
   * Defaults to `1`. Anything non-finite or `<= 0` (including `Infinity`) is
   * treated as "no delays at all" rather than an error — a stuck replay on stage
   * is worse than a fast one.
   */
  speed?: number;
  /**
   * Aborts the replay. On abort the promise **resolves** rather than rejecting:
   * skipping a replay is a normal thing for a presenter to do, not a failure, and
   * making callers wrap every replay in a try/catch to handle a deliberate user
   * action is the wrong ergonomics.
   */
  signal?: AbortSignal;
}

/** Header stats for the trace panel. */
export interface TraceSummary {
  /** Event count keyed by {@link TraceEvent.type}. Missing types are absent, not `0`. */
  counts: Record<string, number>;
  /** Span covered by the events, in ms (last `at` minus first `at`). */
  ms: number;
  /** `tool.call` events — how much real work the agents did. */
  toolCalls: number;
  /** `challenger.attack` events — attacks attempted, whatever their verdict. */
  attacks: number;
  /**
   * Attacks whose verdict was `upheld`.
   *
   * `unverifiable` attacks are deliberately **not** counted here and must never
   * be folded in. An unverifiable challenge means the catalog is silent, which is
   * an unquantified risk — neither a landed hit nor a clean bill of health.
   * Collapsing it into either direction is the exact "unknown rendered as pass"
   * bug this codebase is built to avoid.
   */
  upheld: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Mutable state shared by a root trace and every child it spawns. */
interface TraceState {
  readonly start: number;
  readonly now: () => number;
  readonly log: TraceEvent[];
  readonly onEvent: ((event: TraceEvent) => void) | undefined;
  /** Last stamp handed out, so `at` can be clamped monotonic. */
  lastAt: number;
}

/**
 * Invoke a trace consumer and swallow anything it throws.
 *
 * The trace exists to observe a run; letting a broken renderer, a closed
 * WebSocket or a JSON cycle abort a successful equivalence search would be a
 * strictly worse product. Errors are dropped silently on purpose — logging them
 * would itself be a side channel that can throw.
 */
function safeInvoke(sink: ((event: TraceEvent) => void) | undefined, event: TraceEvent): void {
  if (sink === undefined) return;
  try {
    sink(event);
  } catch {
    // Intentionally ignored: observability must never become control flow.
  }
}

/** Join a child-label chain into the prefix shown on every event. */
function joinPrefix(path: readonly string[], label: string): string {
  return path.length === 0 ? label : `${path.join(" › ")} · ${label}`;
}

function makeTrace(state: TraceState, path: readonly string[]): Trace {
  return {
    emit(event: TraceEventInput): void {
      // Clamp monotonic: an injected clock (or an NTP step on Date.now) can move
      // backwards, and an out-of-order `at` makes the panel replay jump.
      const at = Math.max(state.lastAt, state.now() - state.start);
      state.lastAt = at;
      const stamped = { ...event, at, label: joinPrefix(path, event.label) } as TraceEvent;
      state.log.push(stamped);
      safeInvoke(state.onEvent, stamped);
    },
    events(): readonly TraceEvent[] {
      return state.log;
    },
    elapsed(): number {
      return state.now() - state.start;
    },
    child(label: string): Trace {
      return makeTrace(state, [...path, label]);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a run's trace bus.
 *
 * One per migration/consult run. `now` defaults to `Date.now`; inject it in
 * tests so assertions on `at` are exact instead of timing-dependent.
 *
 * The failure mode this guards against: a live consumer (SSE writer, React
 * setState, logger) throwing mid-run and killing a search that had already found
 * the right part. `onEvent` is wrapped, so it cannot.
 */
export function createTrace(opts?: CreateTraceOptions): Trace {
  const now = opts?.now ?? Date.now;
  const state: TraceState = {
    start: now(),
    now,
    log: [],
    onEvent: opts?.onEvent,
    lastAt: 0,
  };
  return makeTrace(state, []);
}

/**
 * Replay a recorded trace, honouring the recorded inter-event delays scaled by
 * `speed`.
 *
 * This is what lets the demo re-run a real trace deterministically on stage: the
 * pacing comes from the recording, not from a live model, so the panel animates
 * identically every time and no API is hit.
 *
 * The first event fires immediately regardless of its `at` — a recording that
 * happens to start at 400 ms should not open with 400 ms of blank screen. Delays
 * are computed between consecutive events and clamped at zero, so an
 * out-of-order log degrades to "as fast as possible" rather than hanging.
 *
 * Resolves early (never rejects) when `signal` aborts, including when it is
 * already aborted on entry — in which case nothing is emitted at all.
 */
export async function replayTrace(
  events: readonly TraceEvent[],
  opts: ReplayOptions,
): Promise<void> {
  const rate = opts.speed ?? 1;
  const usable = Number.isFinite(rate) && rate > 0 ? rate : Number.POSITIVE_INFINITY;
  // Read through a call, not a property access: TypeScript keeps narrowing on
  // `signal.aborted` across an `await`, so an inline re-check after the sleep
  // gets flagged as impossible — the one place the compiler is wrong here.
  const aborted = (): boolean => opts.signal?.aborted === true;
  let previous: number | undefined;

  for (const event of events) {
    if (aborted()) return;
    if (previous !== undefined) {
      const gap = event.at - previous;
      const delay = gap > 0 && Number.isFinite(usable) ? gap / usable : 0;
      if (delay > 0) {
        await sleep(delay, opts.signal);
        // The sleep may have ended because the signal aborted, not because the
        // timer fired.
        if (aborted()) return;
      }
    }
    previous = event.at;
    safeInvoke(opts.onEvent, event);
  }
}

/**
 * Abortable timer. Resolves on either the timeout or the abort — the caller
 * distinguishes the two by re-reading `signal.aborted`, which keeps this helper
 * free of rejection paths that every call site would have to catch.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Header stats for the trace panel.
 *
 * Works on any slice of a log, not just a whole run, which is why `ms` is the
 * span between the first and last event rather than the final `at`.
 *
 * Read the note on {@link TraceSummary.upheld} before changing the attack
 * counters — the split between `upheld` and `unverifiable` is load-bearing.
 */
export function summarizeTrace(events: readonly TraceEvent[]): TraceSummary {
  const counts: Record<string, number> = {};
  let toolCalls = 0;
  let attacks = 0;
  let upheld = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (Number.isFinite(event.at)) {
      first = Math.min(first, event.at);
      last = Math.max(last, event.at);
    }
    if (event.type === "tool.call") toolCalls += 1;
    if (event.type === "challenger.attack") {
      attacks += 1;
      if (event.challenge.verdict === "upheld") upheld += 1;
    }
  }

  const ms = Number.isFinite(first) && Number.isFinite(last) ? last - first : 0;
  return { counts, ms, toolCalls, attacks, upheld };
}

/**
 * Serialize a log as newline-delimited JSON.
 *
 * One event per line, with a trailing newline, so a run can append to an open
 * file or stream and a reader can start consuming before the run finishes.
 * Always round-trips through {@link fromNdjson}.
 */
export function toNdjson(events: readonly TraceEvent[]): string {
  if (events.length === 0) return "";
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

/**
 * Parse newline-delimited JSON back into a log. Blank lines and `\r\n` endings
 * are tolerated; anything else is a hard error.
 *
 * A malformed line **throws** rather than being skipped. The trace is this
 * product's evidence that the agents did real work, and silently dropping part of
 * it would let a report cite a step that no longer exists in the record. If you
 * are tailing a file that is still being written, split off the incomplete final
 * line before calling this.
 */
export function fromNdjson(text: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").replace(/\r$/, "").trim();
    if (raw === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`fromNdjson: line ${i + 1} is not valid JSON`);
    }
    if (!isTraceEventShape(parsed)) {
      throw new Error(`fromNdjson: line ${i + 1} is not a TraceEvent (needs string type, string label, number at)`);
    }
    out.push(parsed);
  }
  return out;
}

/**
 * Structural guard for a decoded line. Checks only the three fields every
 * {@link TraceEvent} variant shares — validating each payload would duplicate the
 * union in a second place and rot the moment a variant is added. The purpose here
 * is to catch "this file is not a trace", not to re-typecheck our own writer.
 */
function isTraceEventShape(value: unknown): value is TraceEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; label?: unknown; at?: unknown };
  return (
    typeof candidate.type === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.at === "number"
  );
}
