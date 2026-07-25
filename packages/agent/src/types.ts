/**
 * Shared contract for the runtime agent layer.
 *
 * `@no-human/rag` answers "which SICK parts are worth considering, and where
 * can each claim be checked". This package is what turns messy human input into
 * that question, and turns the answer into a defensible recommendation.
 *
 * ## The pipeline
 *
 * ```
 *   input ──▶ Resolver ──▶ SpecConstraints ──▶ retrieval ──▶ solver ──▶ Challenger ──▶ report
 *            (LLM)         "spec vector"      (@no-human/rag)          (LLM)          or refusal
 *              │                                                          │
 *              └── underspecified? emit questions, do NOT guess           └── kills rank 1 ⇒ promote rank 2
 * ```
 *
 * ## The rules this layer must not break
 *
 * 1. **The LLM never picks the part.** The Resolver produces constraints; the
 *    Challenger attacks a match. Between them sits a deterministic solve. An
 *    agent may narrow, question, or reject — never select.
 * 2. **Underspecified input returns a question, not a guess.** If the constraint
 *    set is too thin to discriminate, the run stops and asks. A confident answer
 *    from thin input is the failure mode this whole design exists to prevent.
 * 3. **Every claim carries a citation.** A spec with no source is reported as
 *    unverified, never asserted.
 * 4. **Refusal is a first-class outcome.** "Closest is X, but you lose the M12
 *    connector and 8 ms of response time" is a *successful* run.
 * 5. **Everything is traced.** Each decision emits a {@link TraceEvent}. The
 *    trace is the product's evidence that agents did real work; a step that
 *    does not emit is invisible and therefore untrusted.
 */

import type {
  Citation,
  RetrievalResult,
  SickProduct,
  SolveResult,
  SpecConstraints,
} from "@no-human/rag";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The four ways in, plus the consultant entry point. All collapse to a spec vector. */
export type AgentInput =
  | { kind: "part_number"; value: string; vendorHint?: string }
  | { kind: "description"; value: string }
  | { kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string; note?: string }
  | { kind: "bom"; csv: string }
  | { kind: "problem"; value: string; answers?: Record<string, string> };

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** A competitor part identified from input, with whatever specs we can source. */
export interface IdentifiedPart {
  vendor: string;
  series?: string;
  model?: string;
  /** Raw part number as the user gave it. */
  rawInput?: string;
  description?: string;
  /**
   * Where these specs came from. `dataset` means we hold real extracted data
   * for this part and the specs are citable. `inferred` means the model read
   * them off the input text/photo. `unknown` means we have neither — the run
   * must proceed on constraints alone and say so.
   */
  specSource: "dataset" | "inferred" | "unknown";
  citation?: Citation;
}

/** One thing the agent needs to know before it can responsibly recommend. */
export interface ClarifyingQuestion {
  /** The constraint field this question would populate, e.g. `sensingRangeMm`. */
  field: string;
  question: string;
  /** Why the answer changes the recommendation — shown so the user sees the
   *  question is load-bearing, not a stalling tactic. */
  why: string;
  /** Suggested answers, when the space is small and enumerable. */
  options?: string[];
}

/** The Resolver's output: the spec vector, plus what it could not determine. */
export interface ResolvedInput {
  constraints: SpecConstraints;
  identified?: IdentifiedPart;
  /**
   * Constraint fields the input did not pin down. Non-empty does not by itself
   * block a run — {@link ResolvedInput.sufficient} decides that.
   */
  missing: string[];
  questions: ClarifyingQuestion[];
  /**
   * True when the constraint set is discriminating enough to recommend on.
   * When false the orchestrator MUST stop and ask rather than proceed — this
   * is rule 2 of this module, enforced at the type level by every consumer
   * checking it.
   */
  sufficient: boolean;
  /** The Resolver's own reasoning, surfaced in the trace. */
  rationale: string;
  /** Assumptions the Resolver made that the user should be able to reject. */
  assumptions: string[];
}

// ---------------------------------------------------------------------------
// Challenger
// ---------------------------------------------------------------------------

/** How badly a challenge, if valid, damages the proposed match. */
export type ChallengeSeverity = "fatal" | "major" | "minor";

/** One adversarial attack on a proposed match. */
export interface Challenge {
  /** The attack, phrased as a concrete technical objection. */
  claim: string;
  severity: ChallengeSeverity;
  /** The constraint or spec field under attack. */
  field?: string;
  /**
   * Whether the attack lands. `upheld` — the objection is real and evidenced.
   * `refuted` — checked against the catalog and it does not hold.
   * `unverifiable` — the catalog is silent, so the risk stands unquantified,
   * which is itself a finding worth reporting.
   */
  verdict: "upheld" | "refuted" | "unverifiable";
  evidence: string;
  citation?: Citation;
}

/** The Challenger's full pass over one candidate. */
export interface ChallengeReport {
  orderNumber: string;
  challenges: Challenge[];
  /** True when no `fatal` challenge was upheld. A survivor is still allowed to
   *  carry `major` caveats — those become the report's honest limitations. */
  survives: boolean;
  /** One-line summary for the trace panel. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A single field lined up across the source part and the SICK candidate. */
export interface ComparisonRow {
  field: string;
  label: string;
  sourceValue?: string;
  sickValue?: string;
  /** `match` — equivalent or better. `worse` — quantified regression.
   *  `better` — an upgrade. `unknown` — one side is not stated anywhere. */
  status: "match" | "better" | "worse" | "unknown";
  /** Quantified delta when both sides are known, e.g. "+8 ms slower". */
  delta?: string;
  citation?: Citation;
}

/** One ranked recommendation with its full audit trail. */
export interface Recommendation {
  rank: number;
  product: SickProduct;
  solve: SolveResult;
  comparison: ComparisonRow[];
  challenge?: ChallengeReport;
  citation: Citation;
  /**
   * Confidence in the *equivalence claim*, not in the retrieval score.
   * `high` requires every safety-relevant constraint verified `pass`.
   * Unknown-heavy candidates cap at `low` no matter how well they rank.
   */
  confidence: "high" | "medium" | "low";
  /** Plain-language statement of what you give up versus the source part. */
  tradeoffs: string[];
}

/** The terminal outcome of a migration run. */
export type MigrationOutcome =
  | { kind: "recommendation"; recommendations: Recommendation[] }
  /** Underspecified input. Rule 2: a question, not a guess. */
  | { kind: "needs_input"; questions: ClarifyingQuestion[] }
  /** No honest equivalent exists. Carries the closest miss and what it costs. */
  | { kind: "no_equivalent"; closest?: Recommendation; reason: string; lost: string[] };

/** Everything a migration run produced, including how it got there. */
export interface MigrationReport {
  input: AgentInput;
  resolved?: ResolvedInput;
  outcome: MigrationOutcome;
  /** Candidates considered before solving — the audit trail. */
  candidates: RetrievalResult[];
  trace: TraceEvent[];
  /** Wall-clock and token accounting, for the trace panel. */
  stats: { ms: number; inputTokens: number; outputTokens: number; toolCalls: number };
}

// ---------------------------------------------------------------------------
// Consultant mode (second use case)
// ---------------------------------------------------------------------------

/** A complete proposed solution, not just a sensor. */
export interface SolutionDesign {
  /** Restatement of the problem as the agent understood it. */
  problem: string;
  requirements: string[];
  assumptions: string[];
  /** The sensing approach chosen, and why this one over the alternatives. */
  approach: string;
  alternativesConsidered: { approach: string; rejectedBecause: string }[];
  /** Sensors, plus the cables, brackets, connectors and interfaces that make
   *  them a working installation rather than a part number. */
  billOfMaterials: {
    role: "sensor" | "accessory" | "cable" | "connector" | "interface" | "other";
    product: SickProduct;
    quantity: number;
    why: string;
    citation: Citation;
  }[];
  /** Compatibility checks performed across the BOM, with their outcome. */
  compatibility: { check: string; status: "ok" | "warning" | "unverified"; detail: string }[];
  limitations: string[];
  confidence: "high" | "medium" | "low";
}

export type ConsultOutcome =
  | { kind: "solution"; design: SolutionDesign }
  | { kind: "needs_input"; questions: ClarifyingQuestion[] };

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/**
 * A single observable step. The UI renders these live, in order.
 *
 * Every event carries `at` (ms since run start) so the panel can pace itself,
 * and a `label` short enough to read at a glance. Payloads must stay
 * JSON-serializable — the trace is streamed to a browser.
 */
export type TraceEvent =
  | { type: "run.start"; at: number; label: string; input: AgentInput["kind"] }
  | { type: "resolver.start"; at: number; label: string }
  | { type: "resolver.identified"; at: number; label: string; part: IdentifiedPart }
  | { type: "resolver.constraints"; at: number; label: string; constraints: SpecConstraints; missing: string[] }
  | { type: "resolver.question"; at: number; label: string; questions: ClarifyingQuestion[] }
  | { type: "retrieval.start"; at: number; label: string; query: string }
  | { type: "retrieval.results"; at: number; label: string; count: number; lanes: { bm25: boolean; dense: boolean; rerank: boolean } }
  | { type: "solver.start"; at: number; label: string; candidateCount: number }
  | { type: "solver.verdicts"; at: number; label: string; orderNumber: string; passed: number; failed: number; unknown: number }
  | { type: "challenger.start"; at: number; label: string; orderNumber: string }
  | { type: "challenger.attack"; at: number; label: string; challenge: Challenge }
  | { type: "challenger.verdict"; at: number; label: string; orderNumber: string; survives: boolean }
  | { type: "candidate.promoted"; at: number; label: string; from: string; to: string; because: string }
  | { type: "tool.call"; at: number; label: string; tool: string; input: unknown }
  | { type: "tool.result"; at: number; label: string; tool: string; summary: string }
  | { type: "report.ready"; at: number; label: string; outcome: MigrationOutcome["kind"] }
  | { type: "error"; at: number; label: string; message: string; recoverable: boolean };

/** Sink for trace events. Implementations must never throw — a broken trace
 *  consumer must not take down a run that is otherwise succeeding. */
export interface TraceSink {
  emit(event: TraceEvent): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The model every agent in this package runs on. */
export const AGENT_MODEL = "claude-opus-5";
/** Effort for the Resolver — it reads messy input and must not under-think. */
export const RESOLVER_EFFORT = "high";
/** Effort for the Challenger — adversarial work benefits from the extra depth. */
export const CHALLENGER_EFFORT = "high";
