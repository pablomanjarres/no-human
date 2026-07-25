/**
 * The contract between the interface and the engine.
 *
 * The rule this whole product rests on: the LLM never picks the part. Agents
 * turn messy input into a `Constraint[]` and messy PDFs into `SpecRow[]`; the
 * match itself is a deterministic solve over those structures. Every type here
 * is shaped so a judge can re-derive the result by hand.
 */

export type Confidence = "high" | "medium" | "low";

/** How hard a constraint bites when a candidate misses it. */
export type Criticality =
  /** A miss is a refusal, not a downgrade. PNP vs NPN into a wired PLC card. */
  | "hard"
  /** A miss degrades the match and must be reported as a named, quantified loss. */
  | "soft"
  /** Reported, never scored. */
  | "informational";

export type SpecKind =
  "numeric-min" | "numeric-max" | "numeric-window" | "enum" | "boolean" | "text";

export type AgentName = "extractor" | "verifier" | "resolver" | "solver" | "challenger";

export type InputMode = "part" | "describe" | "photo" | "bom";

/** Grounding. Nothing appears on screen without one of these behind it. */
export interface Citation {
  docId: string;
  docTitle: string;
  brand: string;
  page: number;
  /** Local path in the offline corpus. The demo must run with no network. */
  href: string;
  /** The exact line the value was read from. Grounding you can see, not claim. */
  snippet?: string;
}

/** A disagreement between the extraction pass and the verification pass. */
export interface Dispute {
  extracted: string;
  verified: string;
  note: string;
}

export interface SpecRow {
  key: string;
  label: string;
  unit: string;
  /** Human-readable, in the form the datasheet prints it. */
  value: string;
  /** Canonical numeric value in the field's canonical unit, when there is one. */
  numeric?: number;
  confidence: Confidence;
  citation: Citation;
  /** Present when the verifier disagreed with the extractor. Never averaged. */
  dispute?: Dispute;
}

export interface Part {
  id: string;
  brand: string;
  partNumber: string;
  family: string;
  /** SICK order number, or the competitor's stock number. */
  orderNumber?: string;
  principle: string;
  blurb: string;
  /** Millimetres — drives the to-scale housing silhouette. */
  dims: { l: number; w: number; h: number };
  form: "rect" | "cyl";
  specs: SpecRow[];
  /** Competitor parts this SICK part is a documented replacement for. */
  replaces?: string[];
}

/** One row of the spec vector: the constraint set a replacement must satisfy. */
export interface Constraint {
  key: string;
  label: string;
  kind: SpecKind;
  criticality: Criticality;
  unit: string;
  min?: number;
  max?: number;
  enumValue?: string;
  /** As it appears on the chip: "≥ 5 000 mm", "PNP", "≤ 1.5 ms". */
  display: string;
  /** Where this constraint came from. "assumed" must always be visible. */
  origin: "extracted" | "asked" | "assumed" | "default";
  rationale: string;
}

/** Geometry for the constraint rail. All values in the field's canonical unit. */
export interface RailModel {
  scaleMin: number;
  scaleMax: number;
  /** The window the solver requires. */
  bandStart: number;
  bandEnd: number;
  /** The SICK candidate's value — the solid tick. */
  candidate: number;
  /** The part being replaced — the hollow tick. */
  source: number;
}

export type EvalStatus = "pass" | "loss" | "fail" | "info";

export interface Evaluation {
  key: string;
  label: string;
  status: EvalStatus;
  criticality: Criticality;
  candidateValue: string;
  sourceValue: string;
  /** Signed, quantified difference. This is what "what you lose" is made of. */
  delta?: string;
  rail?: RailModel;
  citation: Citation;
  note?: string;
}

export interface Attack {
  id: string;
  targetRank: number;
  targetPart: string;
  /** What the challenger is asserting is wrong with the match. */
  claim: string;
  evidence: string;
  citation: Citation;
  severity: Criticality;
  outcome: "kill" | "survived";
}

export type Verdict = "equivalent" | "equivalent-with-losses" | "rejected";

export interface Candidate {
  rank: number;
  part: Part;
  /** 0…1. Derived from the evaluations, never from a model. */
  score: number;
  evaluations: Evaluation[];
  verdict: Verdict;
  killedBy?: string;
  /** Plain-language losses, quantified. Empty for a clean equivalent. */
  losses: string[];
}

export interface TraceEvent {
  id: string;
  /** Milliseconds from the start of the solve. */
  at: number;
  agent: AgentName;
  title: string;
  detail?: string;
  tool?: { name: string; args: string; result: string };
  chips?: string[];
  status: "ok" | "warn" | "halt";
}

export interface QuestionOption {
  label: string;
  value: string;
  /** What answering this way does to the constraint set. */
  effect: string;
}

/**
 * The consultation thread. This is a chat surface — people need help — but no
 * turn is a bare paragraph: every agent turn carries the trace of what it did,
 * and an underspecified input produces a question, never a guess.
 */
export type ThreadMessage =
  | { id: string; role: "user"; at: number; text: string }
  | {
      id: string;
      role: "agent";
      at: number;
      agent: AgentName;
      text: string;
      /** Trace lines rendered inline under the turn. */
      did?: string[];
      chips?: string[];
      citations?: Citation[];
      tone?: "neutral" | "caution" | "halt";
    }
  | {
      id: string;
      role: "question";
      at: number;
      agent: AgentName;
      text: string;
      /** Why the agent will not proceed without this. */
      why: string;
      options: QuestionOption[];
    };

export type Outcome = "match" | "match-with-losses" | "refusal" | "needs-input";

export interface SolveRun {
  id: string;
  label: string;
  input: { mode: InputMode; raw: string };
  source: Part;
  constraints: Constraint[];
  /** In the solver's original ranking. Rank 1 may be killed by the challenger. */
  candidates: Candidate[];
  attacks: Attack[];
  trace: TraceEvent[];
  thread: ThreadMessage[];
  outcome: Outcome;
  /** The moment the challenger kills rank 1 and rank 2 takes the slot. */
  promotion?: { at: number; fromRank: number; toRank: number };
  refusal?: {
    headline: string;
    closest: string;
    losses: string[];
    /**
     * Near misses from the catalogue, offered for a human to pick. Never
     * auto-resolved: one character of a type code is often one polarity of
     * output, and guessing which the operator meant is how you wire a sourcing
     * output into a sinking input card.
     */
    suggestions?: { partNumber: string; orderNumber: string; note: string }[];
  };
  stats: { catalogue: number; afterConstraints: number; survived: number; durationMs: number };
}

/** Offline corpus telemetry — the proof the extraction swarm did real work. */
export interface CorpusStats {
  datasheets: number;
  brands: { name: string; datasheets: number; specRows: number }[];
  specRows: number;
  disputes: number;
  lowConfidence: number;
  extractedAt: string;
  runtimeMs: number;
}
