/**
 * The pipeline. Everything else in this package is a stage; this file is the
 * order those stages run in, and the order is the product.
 *
 * ```
 *   input ──▶ resolve ──▶ [sufficient?] ──▶ retrieve ──▶ SOLVE ──▶ challenge ──▶ report
 *              (LLM)          │            (@no-human/rag)  │        (LLM)
 *                             └── no ⇒ questions, stop      └── the only thing that picks a part
 * ```
 *
 * ## The three things this file must not get wrong
 *
 * 1. **The insufficiency short-circuit.** When `resolved.sufficient` is false the
 *    run returns `needs_input` *before* retrieval, before the solve, before the
 *    challenger. Not "retrieve anyway and caveat it" — a reader shown a
 *    shortlist anchors on it no matter what the disclaimer says. This is the
 *    single most important branch in the package and it has its own test that
 *    spies on the retriever to prove nothing downstream ran.
 * 2. **Ranking comes from the solver, never from retrieval.** Retrieval rank is
 *    a text-similarity heuristic over Spanish catalog cards. It exists to
 *    *narrow*, and it is not evidence of anything. The recommendation order is
 *    `Retriever.solveConstraints`'s order — fewest unknowns, then most passes —
 *    and the rank a hit had in the search results is never consulted again after
 *    the order numbers are extracted.
 * 3. **A model never names the answer.** `challengeAll` reports on candidates by
 *    order number; any order number that was not in the solver's ranked set is
 *    dropped with a recoverable `error` event rather than promoted into a
 *    recommendation. That is the last line of defence for rule 1 of `types.ts`.
 *
 * ## Absent is not failing, and it is not passing either
 *
 * The SICK data is the summary catalog: supply voltage is printed for 41 of
 * 1,776 SKUs. `unknown` verdicts are therefore normal and abundant, and every
 * path out of this file carries them forward — into `Recommendation.confidence`
 * (which caps at `low`), into `tradeoffs`, and into `no_equivalent.lost`. An
 * `unknown` that reaches the user looking like a `pass` is the most damaging bug
 * available in this codebase.
 *
 * ## Refusal is a successful run
 *
 * `{ kind: "no_equivalent", closest, reason, lost }` is not an error path. It is
 * what this system is *for*: quantifying what you give up when there is no
 * honest equivalent, instead of shipping the second-best part with a confident
 * tone.
 */

import {
  citationFor,
  type RetrievalResult,
  type Retriever,
  type SearchOptions,
  type SensingPrinciple,
  type SolveResult,
} from "@no-human/rag";

import { challengeAll, type ChallengeCandidate } from "./challenger.js";
import { isRefused, type LlmClient, type StructuredOk, type StructuredRequest, type Refused, type ToolLoopOk, type ToolLoopRequest, type Usage } from "./claude.js";
import type { CompetitorIndex } from "./competitors.js";
import { parseBom, type BomRow } from "./inputs/bom.js";
import type { VisionClient } from "./inputs/vision.js";
import { buildComparison } from "./report.js";
import { resolve } from "./resolver.js";
import { createTrace, type Trace } from "./trace.js";
import type {
  AgentInput,
  ChallengeReport,
  ClarifyingQuestion,
  MigrationOutcome,
  MigrationReport,
  Recommendation,
  ResolvedInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How many hits retrieval contributes to the solve.
 *
 * Larger than the number of candidates anyone reads, because the solver
 * re-ranks: a SKU that retrieval put ninth on vocabulary overlap can be the one
 * the catalog fully answers for, and truncating to the top three would delete it
 * before the only ranking that means anything got to run.
 */
export const RETRIEVAL_TOP_K = 12;

/**
 * How deep the Challenger is allowed to go.
 *
 * `challengeAll` stops at the first survivor, so this is a ceiling on the
 * *failure* case — a constraint set where everything dies would otherwise pay
 * for twelve adversarial passes nobody reads. Four is enough to show a promotion
 * (rank 1 dies, rank 2 survives) and to demonstrate a genuine refusal.
 */
export const MAX_CHALLENGED_CANDIDATES = 4;

/**
 * Constraints whose `unknown` is a safety problem, not just a gap.
 *
 * In practice the solver only emits a verdict for a constraint the caller
 * actually stated, so *every* unknown is an unknown on a requested constraint
 * and {@link confidenceFor} caps at `low` regardless. This set exists as the
 * belt to that suspenders: if `evaluate` ever grows verdicts for constraints
 * nobody asked for — a default the solver applies, an inherited family
 * requirement — an unverified ingress rating or supply voltage must still pull
 * the confidence down rather than sail through as "not requested, not my
 * problem".
 */
export const SAFETY_RELEVANT_CONSTRAINTS: ReadonlySet<string> = new Set([
  "minIpRating",
  "ip69k",
  "operatingTempC",
  "supplyVoltageV",
  "outputType",
  "responseTimeMs",
  "connector",
]);

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything a run needs, injected.
 *
 * Nothing in this file constructs a client, opens an index or reads a file: a
 * test builds a real retriever over a real slice of the catalog, hands in a
 * scripted {@link LlmClient}, and exercises the exact production code path with
 * no network anywhere.
 */
export interface MigrationDeps {
  readonly client: LlmClient;
  readonly retriever: Retriever;
  readonly competitors: CompetitorIndex;
  /**
   * Raw Anthropic client used for the nameplate-photo path.
   *
   * Separate from `client` because {@link readLabel} sends an image content
   * block, which the structured {@link LlmClient} wrapper does not model.
   * Optional so the three text paths need no vision plumbing — but a caller
   * that passes an `image` input without it gets a hard error from the
   * resolver rather than a silent downgrade, because reading a part number off
   * a label is the whole job in that modality.
   */
  readonly vision?: VisionClient;
  /** Existing trace to append to. Omit and the run creates its own. */
  readonly trace?: Trace;
  readonly signal?: AbortSignal;
}

/** One audited BOM line: the row as parsed, and what the pipeline made of it. */
export interface BomAuditEntry {
  row: BomRow;
  report: MigrationReport;
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

/** Mutable counters for one run. */
interface Meter {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

/**
 * Wrap the client so every call any stage makes is counted.
 *
 * `resolve` and `challengeAll` return domain objects, not usage — deliberately,
 * because a stage's contract should be about what it decided rather than what it
 * cost. That leaves the orchestrator with no way to fill `MigrationReport.stats`
 * except to meter the shared client, which has the pleasant side effect of
 * catching calls made by stages this file does not know about yet.
 *
 * The wrapper is transparent: refusals, throws and results pass through
 * untouched. It only ever adds.
 */
function meteredClient(inner: LlmClient, meter: Meter): LlmClient {
  const add = (usage: Usage): void => {
    meter.inputTokens += usage.inputTokens;
    meter.outputTokens += usage.outputTokens;
  };
  return {
    async structured<T>(opts: StructuredRequest): Promise<StructuredOk<T> | Refused> {
      const out = await inner.structured<T>(opts);
      add(out.usage);
      return out;
    },
    async withTools(opts: ToolLoopRequest): Promise<ToolLoopOk | Refused> {
      const out = await inner.withTools(opts);
      add(out.usage);
      if (!isRefused(out)) meter.toolCalls += out.toolCalls;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

/**
 * Retrieval vocabulary per sensing principle, Spanish first.
 *
 * The BM25 lane indexes catalog cards whose spec text is Spanish with an English
 * gloss (`supresión del fondo (background suppression)`), so a query in one
 * language reaches roughly half the surface. Both are emitted for every
 * principle. `unknown` maps to nothing: a principle we could not canonicalize
 * has no vocabulary to contribute, and padding the query with the literal word
 * "unknown" would drag in every card containing it.
 */
const PRINCIPLE_QUERY_TERMS: Readonly<Record<SensingPrinciple, string>> = {
  diffuse: "fotocélula de detección sobre objeto diffuse energética",
  "background-suppression": "supresión del fondo background suppression",
  "foreground-suppression": "supresión del primer plano foreground suppression",
  retroreflective: "reflexión sobre espejo autocolimación retroreflective",
  "through-beam": "barrera de luz unidireccional through-beam opposed",
  inductive: "sensor de proximidad inductivo inductive",
  capacitive: "sensor de proximidad capacitivo capacitive",
  magnetic: "sensor magnético magnetic cilindro",
  ultrasonic: "sensor ultrasónico ultrasonido ultrasonic",
  "laser-distance": "medición de distancia láser laser distance",
  contrast: "sensor de contraste contrast marca",
  luminescence: "sensor de luminiscencia luminescence",
  color: "sensor de color colour",
  fork: "sensor de horquilla fork",
  "light-grid": "rejilla óptica light grid cortina",
  "safety-light-curtain": "cortina óptica de seguridad safety light curtain",
  encoder: "encoder codificador incremental absoluto",
  vision: "cámara de visión vision inspección",
  identification: "identificación lector de código bar code identification",
  fluid: "sensor de fluidos caudal presión nivel fluid",
  "safety-switch": "interruptor de seguridad safety switch enclavamiento",
  "safety-controller": "controlador de seguridad safety controller relé",
  unknown: "",
};

const HOUSING_QUERY_TERMS: Readonly<Record<string, string>> = {
  plastic: "plástico plastic",
  metal: "metal metálico",
  "stainless-steel": "acero inoxidable stainless steel",
  other: "",
};

const LIGHT_QUERY_TERMS: Readonly<Record<string, string>> = {
  red: "luz roja red light",
  infrared: "infrarrojo infrared",
  laser: "láser laser",
  white: "luz blanca white light",
  rgb: "rgb",
  green: "luz verde green light",
  other: "",
};

/** Longest query we will send. Past this BM25 is just diluting every term. */
const MAX_QUERY_CHARS = 600;

/**
 * Build the retrieval query from the resolved constraints and the identified
 * part's description.
 *
 * Two things are deliberately **not** in it. The competitor's vendor, series and
 * model never appear in the SICK catalog, so including them can only dilute the
 * terms that do match. And nothing here is a filter: the hard narrowing is
 * `SearchOptions.constraints`, which prefilters structurally *before* either
 * lane ranks. This string exists purely to map an engineer's words onto the
 * Spanish spec vocabulary.
 *
 * Exported so a test can assert the query is built from constraints rather than
 * from a raw part number.
 */
export function buildRetrievalQuery(resolved: ResolvedInput, input: AgentInput): string {
  const parts: string[] = [];
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.trim() !== "") parts.push(value.trim());
  };

  // The user's own words carry the application context nothing else does.
  if (input.kind === "description" || input.kind === "problem") push(input.value);
  if (input.kind === "image") push(input.note);
  push(resolved.identified?.description);

  const constraints = resolved.constraints;
  for (const principle of constraints.principle ?? []) push(PRINCIPLE_QUERY_TERMS[principle]);
  for (const housing of constraints.housing ?? []) {
    if (housing !== undefined) push(HOUSING_QUERY_TERMS[housing]);
  }
  for (const light of constraints.light ?? []) {
    if (light !== undefined) push(LIGHT_QUERY_TERMS[light]);
  }
  for (const output of constraints.outputType ?? []) push(output);
  for (const connector of constraints.connector ?? []) {
    if (connector !== undefined && connector !== "unknown") push(connector);
  }
  if (constraints.ioLink === true) push("IO-Link");
  if (constraints.minIpRating !== undefined) push(`IP ${String(constraints.minIpRating)}`);
  if (constraints.ip69k === true) push("IP 69K");
  const range = constraints.sensingRangeMm;
  if (range !== undefined) {
    const distance = range.max ?? range.min;
    if (distance !== undefined) push(`${String(distance)} mm`);
  }
  const response = constraints.responseTimeMs;
  if (response?.max !== undefined) push(`${String(response.max)} ms`);

  const query = parts.join(" ").replace(/\s+/g, " ").trim();
  return query.length <= MAX_QUERY_CHARS ? query : query.slice(0, MAX_QUERY_CHARS).trimEnd();
}

/**
 * Which lanes actually produced a ranking, read off the hits' own signals.
 *
 * Derived rather than configured on purpose: the dense lane fails open when
 * there is no Voyage key, and the reranker reports `null` when it fell back to
 * the fused order. A trace that claims a lane ran because it was *enabled* is a
 * lie on the screen a judge is auditing.
 */
function lanesOf(results: readonly RetrievalResult[]): {
  bm25: boolean;
  dense: boolean;
  rerank: boolean;
} {
  return {
    bm25: results.some((r) => r.signals.bm25Rank !== null),
    dense: results.some((r) => r.signals.denseRank !== null),
    rerank: results.some((r) => r.signals.rerankRank !== null),
  };
}

/** Distinct SKU order numbers from a hit list, in retrieval order. */
function retrievedOrderNumbers(results: readonly RetrievalResult[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const orderNumber = result.chunk.orderNumber ?? result.product?.orderNumber;
    if (orderNumber === undefined || seen.has(orderNumber)) continue;
    seen.add(orderNumber);
    out.push(orderNumber);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Confidence in the *equivalence claim* — never in the retrieval score.
 *
 * The rule, enforced here rather than asked for in a prompt:
 *
 * - `high` requires every requested constraint verified `pass` **and** no upheld
 *   `major` (or `fatal`) challenge.
 * - Any `unknown` on a requested or safety-relevant constraint caps at `low`,
 *   however well the candidate ranked. This is the whole reason the function
 *   exists: `SolveResult.viable` only means "nothing printed contradicts the
 *   request", and a SKU with five unknowns and zero fails is viable while being
 *   almost entirely unverified.
 * - A solve with no verdicts at all is `low`: nothing was checked, so there is
 *   nothing to be confident about. An empty check list is not a clean bill.
 *
 * `medium` is therefore the narrow band where everything requested is verified
 * but the Challenger landed a major objection.
 */
export function confidenceFor(
  solve: SolveResult,
  challenge?: ChallengeReport,
): Recommendation["confidence"] {
  // Nothing verified ⇒ nothing to be confident about.
  if (solve.verdicts.length === 0) return "low";
  if (solve.failed > 0) return "low";

  // A verdict exists only for a constraint the caller actually stated, so this
  // set *is* the requested set. It is derived rather than assumed so the rule
  // below reads as what it enforces: unknown on requested OR safety-relevant.
  const requested = new Set(solve.verdicts.map((verdict) => verdict.field));
  const blockingUnknown = solve.verdicts.some(
    (verdict) =>
      verdict.status === "unknown" &&
      (requested.has(verdict.field) || SAFETY_RELEVANT_CONSTRAINTS.has(verdict.field)),
  );
  if (blockingUnknown) return "low";

  const upheld = (challenge?.challenges ?? []).filter((c) => c.verdict === "upheld");
  if (upheld.some((c) => c.severity === "fatal" || c.severity === "major")) return "medium";
  return "high";
}

// ---------------------------------------------------------------------------
// Recommendation assembly
// ---------------------------------------------------------------------------

/** Dedupe while preserving order — `lost` and `tradeoffs` are read by a human. */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** What you give up relative to the stated requirement, in plain language. */
function tradeoffsFor(solve: SolveResult, challenge: ChallengeReport | undefined): string[] {
  const out: string[] = [];
  for (const verdict of solve.verdicts) {
    if (verdict.status === "fail") out.push(`Violates the requirement: ${verdict.detail}`);
  }
  for (const item of challenge?.challenges ?? []) {
    if (item.verdict === "upheld") out.push(`${item.claim} — ${item.evidence} (${item.severity})`);
    if (item.verdict === "unverifiable") {
      out.push(`Unquantified risk: ${item.claim} — the catalog is silent, so this stands unchecked.`);
    }
  }
  return unique(out);
}

/**
 * Everything the candidate costs you, enumerated concretely.
 *
 * Three sources, all of them required: verified violations, upheld objections,
 * and **unverified constraints**. That last one is the reason a `no_equivalent`
 * is worth reading — "you also lose the ability to confirm the response time"
 * is a real cost, and omitting it would make the refusal look narrower than it
 * is.
 */
function lostFor(solve: SolveResult, challenge: ChallengeReport | undefined): string[] {
  const out: string[] = [];
  for (const verdict of solve.verdicts) {
    if (verdict.status === "fail") out.push(`${verdict.field}: ${verdict.detail}`);
  }
  for (const item of challenge?.challenges ?? []) {
    if (item.verdict === "upheld") out.push(`${item.claim} — ${item.evidence}`);
  }
  for (const verdict of solve.verdicts) {
    if (verdict.status === "unknown") {
      out.push(`Unverifiable: ${verdict.detail} — you lose the ability to confirm this from the catalog.`);
    }
  }
  return unique(out);
}

function buildRecommendation(
  rank: number,
  solve: SolveResult,
  challenge: ChallengeReport | undefined,
  resolved: ResolvedInput,
): Recommendation {
  return {
    rank,
    product: solve.product,
    solve,
    comparison: buildComparison(resolved.identified, solve.product, solve.spec, solve),
    ...(challenge !== undefined ? { challenge } : {}),
    citation: citationFor(solve.product),
    confidence: confidenceFor(solve, challenge),
    tradeoffs: tradeoffsFor(solve, challenge),
  };
}

/** The objection that killed a candidate, for the promotion event's `because`. */
function killReason(report: ChallengeReport): string {
  const fatal = report.challenges.find((c) => c.verdict === "upheld" && c.severity === "fatal");
  const upheld = fatal ?? report.challenges.find((c) => c.verdict === "upheld");
  return upheld === undefined ? report.summary : `${upheld.claim} — ${upheld.evidence}`;
}

/**
 * The question asked when the resolver declared the input insufficient but
 * produced no question of its own.
 *
 * `needs_input` with an empty question list is a dead end for the user: they are
 * told the run stopped and given nothing to do about it. So the gate always
 * yields at least one actionable ask.
 */
const FALLBACK_QUESTION: ClarifyingQuestion = {
  field: "principle",
  question:
    "What is the sensor doing — what does it detect, at roughly what distance, and what does it drive?",
  why: "Without a sensing principle and at least one quantitative constraint, the catalog's 1,776 SKUs cannot be discriminated, and any part named would be a guess dressed up as an answer.",
};

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Run one migration: messy input in, a defensible recommendation or an honest
 * refusal out.
 *
 * The stage order is not negotiable — see the module doc. In particular an
 * insufficient resolve returns immediately, having touched neither the retriever
 * nor the Challenger, and the recommendation order is the deterministic solver's
 * ordering rather than retrieval's.
 *
 * Never throws for a "no answer" case: no candidates, nothing viable, everything
 * killed by the Challenger all come back as `no_equivalent`, which is a
 * successful run. It *does* propagate a transport failure or an abort — those
 * are genuine failures and swallowing them would present an aborted run as a
 * considered refusal.
 *
 * @example
 * ```ts
 * const report = await runMigration({ kind: "part_number", value: "QS18VN6LV" }, deps);
 * if (report.outcome.kind === "needs_input") console.log(renderMarkdown(report));
 * ```
 */
export async function runMigration(
  input: AgentInput,
  deps: MigrationDeps,
): Promise<MigrationReport> {
  const trace = deps.trace ?? createTrace();
  // Where this run's events start in a (possibly shared) log, so the report
  // carries its own events and not a previous row's.
  const traceOffset = trace.events().length;
  const startedAt = trace.elapsed();
  const meter: Meter = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  const client = meteredClient(deps.client, meter);
  const signalOpts = deps.signal !== undefined ? { signal: deps.signal } : {};

  const finish = (
    outcome: MigrationOutcome,
    resolved: ResolvedInput | undefined,
    candidates: RetrievalResult[],
  ): MigrationReport => {
    trace.emit({ type: "report.ready", label: `report ready · ${outcome.kind}`, outcome: outcome.kind });
    return {
      input,
      ...(resolved !== undefined ? { resolved } : {}),
      outcome,
      candidates,
      trace: trace.events().slice(traceOffset),
      stats: {
        ms: Math.max(0, Math.round(trace.elapsed() - startedAt)),
        inputTokens: meter.inputTokens,
        outputTokens: meter.outputTokens,
        toolCalls: meter.toolCalls,
      },
    };
  };

  // A BOM is many independent resolutions, not one. Collapsing it into a single
  // constraint set would blend unrelated sensors into one incoherent spec vector
  // and then confidently answer it, so the caller is redirected rather than
  // quietly served a wrong shape.
  if (input.kind === "bom") {
    throw new Error(
      "runMigration() does not take a BOM. Use runBomAudit(csv, deps), which runs one migration per row and reports rows with no part number as unprocessable.",
    );
  }

  trace.emit({ type: "run.start", label: `migration · ${input.kind}`, input: input.kind });

  // ---- 1. Resolve -------------------------------------------------------
  const resolved = await resolve(input, {
    client,
    competitors: deps.competitors,
    trace,
    ...(deps.vision !== undefined ? { vision: deps.vision } : {}),
    ...signalOpts,
  });

  // ---- 2. RULE 2. The gate. -------------------------------------------
  // No retrieval, no solve, no challenge. A run that proceeds on thin input
  // defeats the entire product: the output would be answer-shaped, and an
  // answer-shaped output is believed regardless of the caveat printed above it.
  if (!resolved.sufficient) {
    const questions = resolved.questions.length > 0 ? resolved.questions : [FALLBACK_QUESTION];
    return finish({ kind: "needs_input", questions }, resolved, []);
  }

  // ---- 3. Retrieve ------------------------------------------------------
  const query = buildRetrievalQuery(resolved, input);
  trace.emit({ type: "retrieval.start", label: `searching the catalog`, query });

  let candidates: RetrievalResult[] = [];
  if (query !== "") {
    const options: SearchOptions = {
      topK: RETRIEVAL_TOP_K,
      constraints: resolved.constraints,
      ...signalOpts,
    };
    candidates = [...(await deps.retriever.search(query, options))];
  }
  const lanes = lanesOf(candidates);
  trace.emit({
    type: "retrieval.results",
    label: `${String(candidates.length)} candidate(s) · lanes ${
      [lanes.bm25 ? "bm25" : null, lanes.dense ? "dense" : null, lanes.rerank ? "rerank" : null]
        .filter((l): l is string => l !== null)
        .join("+") || "none"
    }`,
    count: candidates.length,
    lanes,
  });

  // ---- 4. Solve ---------------------------------------------------------
  const orderNumbers = retrievedOrderNumbers(candidates);
  trace.emit({
    type: "solver.start",
    label: `solving ${String(orderNumbers.length)} candidate(s) against ${String(
      Object.keys(resolved.constraints).length,
    )} constraint group(s)`,
    candidateCount: orderNumbers.length,
  });

  let ranked: SolveResult[];
  if (orderNumbers.length > 0) {
    ranked = deps.retriever.solveConstraints(resolved.constraints, { candidates: orderNumbers });
  } else if (query === "") {
    // A purely structural constraint set has no words for a similarity lane to
    // rank, so there is nothing for retrieval to narrow. The deterministic solve
    // over the whole catalog is the documented path for that question — and it
    // is strictly more conservative than search, not less.
    ranked = deps.retriever.solveConstraints(resolved.constraints, { topK: RETRIEVAL_TOP_K });
  } else {
    ranked = [];
  }

  for (const solve of ranked) {
    trace.emit({
      type: "solver.verdicts",
      label: `${solve.product.typeCode ?? solve.product.orderNumber} · ${String(
        solve.passed,
      )} pass / ${String(solve.failed)} fail / ${String(solve.unknown)} unverified`,
      orderNumber: solve.product.orderNumber,
      passed: solve.passed,
      failed: solve.failed,
      unknown: solve.unknown,
    });
  }

  // ASSERTION, load-bearing: `ranked` is `solveConstraints`'s ordering — viable
  // first, then fewest unknowns, then most passes. Retrieval rank was consumed
  // when the order numbers were extracted and must not leak past this line. Do
  // not "stabilize" this list against `candidates`; doing so would make a
  // text-similarity score decide which part an engineer bolts onto a machine.

  if (ranked.length === 0) {
    return finish(
      {
        kind: "no_equivalent",
        reason:
          query === ""
            ? "The resolved constraints produced no searchable text and no catalog row satisfies them structurally."
            : `Retrieval surfaced no SKU that survives the stated constraints (query: “${query}”). Nothing was ranked, so there is nothing to recommend.`,
        lost: unique(
          Object.entries(resolved.constraints).map(
            ([field, value]) => `No catalog row satisfies the requested ${field}: ${JSON.stringify(value)}`,
          ),
        ),
      },
      resolved,
      candidates,
    );
  }

  // ---- 5. Challenge, in solver rank order -------------------------------
  const attacked: ChallengeCandidate[] = ranked
    .slice(0, MAX_CHALLENGED_CANDIDATES)
    .map((solve) => ({ product: solve.product, solve }));
  // Where the challenge phase's events begin, so the promotion check below can
  // tell whether the Challenger already announced a promotion of its own.
  const challengeOffset = trace.events().length;
  const reports = await challengeAll(
    attacked,
    {
      resolved,
      ...(resolved.identified !== undefined ? { identified: resolved.identified } : {}),
    },
    { client, trace, ...signalOpts },
  );

  const solveByOrder = new Map(ranked.map((solve) => [solve.product.orderNumber, solve]));
  const reportByOrder = new Map<string, ChallengeReport>();
  for (const report of reports) {
    if (!solveByOrder.has(report.orderNumber)) {
      // RULE 1's last line of defence: a challenge report naming a SKU the
      // solver never ranked cannot become a recommendation. Recoverable — the
      // rest of the reports are still usable.
      trace.emit({
        type: "error",
        label: "challenge report names an unranked SKU",
        message: `Challenge report for ${report.orderNumber} was discarded: that order number is not in the solver's ranked candidate set. An agent may reject a candidate, never introduce one.`,
        recoverable: true,
      });
      continue;
    }
    if (!reportByOrder.has(report.orderNumber)) reportByOrder.set(report.orderNumber, report);
  }

  const considered = reports.filter((report) => solveByOrder.has(report.orderNumber));
  const survivors = considered.filter((report) => report.survives);
  const first = considered[0];
  const promotedTo = survivors[0];
  // `challengeAll` announces its own promotion between consecutive candidates.
  // The orchestrator guarantees the event exists at the *pipeline* level — rank 1
  // died, rank 2 is what you are being shown — without emitting a second one and
  // making the trace panel look like two promotions happened.
  const alreadyAnnounced = trace
    .events()
    .slice(challengeOffset)
    .some((event) => event.type === "candidate.promoted");
  if (
    !alreadyAnnounced &&
    first !== undefined &&
    promotedTo !== undefined &&
    !first.survives &&
    first.orderNumber !== promotedTo.orderNumber
  ) {
    trace.emit({
      type: "candidate.promoted",
      label: `${first.orderNumber} died · ${promotedTo.orderNumber} promoted`,
      from: first.orderNumber,
      to: promotedTo.orderNumber,
      because: killReason(first),
    });
  }

  // ---- 6. Outcome -------------------------------------------------------
  if (survivors.length > 0) {
    const recommendations: Recommendation[] = [];
    for (const report of survivors) {
      const solve = solveByOrder.get(report.orderNumber);
      if (solve === undefined) continue;
      recommendations.push(buildRecommendation(recommendations.length + 1, solve, report, resolved));
    }
    return finish({ kind: "recommendation", recommendations }, resolved, candidates);
  }

  // No survivor. This is a successful run: name the closest miss and price it.
  const closestSolve = ranked[0];
  if (closestSolve === undefined) {
    return finish(
      {
        kind: "no_equivalent",
        reason: "Nothing was ranked, so there is no closest candidate to report.",
        lost: [],
      },
      resolved,
      candidates,
    );
  }
  const closestReport = reportByOrder.get(closestSolve.product.orderNumber);
  const closest = buildRecommendation(1, closestSolve, closestReport, resolved);
  const reason =
    considered.length === 0
      ? `The solver ranked ${String(ranked.length)} candidate(s) but none was adversarially validated, so none can be recommended.`
      : `Every candidate the solver ranked was rejected under adversarial validation. The closest is ${
          closestSolve.product.typeCode ?? closestSolve.product.orderNumber
        } (${closestSolve.product.orderNumber}): ${String(closestSolve.passed)} verified, ${String(
          closestSolve.failed,
        )} violated, ${String(closestSolve.unknown)} unverified — ${
          closestReport?.summary ?? "no challenge summary was produced"
        }`;

  return finish(
    { kind: "no_equivalent", closest, reason, lost: lostFor(closestSolve, closestReport) },
    resolved,
    candidates,
  );
}

// ---------------------------------------------------------------------------
// BOM audit
// ---------------------------------------------------------------------------

/** The questions attached to a BOM line we could not get a part number out of. */
function unprocessableQuestions(row: BomRow): ClarifyingQuestion[] {
  const context =
    row.description === undefined ? "" : ` The line reads: “${row.description}”.`;
  return [
    {
      field: "partNumber",
      question: `BOM line ${String(row.line)} has no identifiable part number. What part is it?${context}`,
      why: "Nothing can be cross-referenced without a part number, and inferring one from a free-text line would produce a confident answer about a part nobody named — the exact failure a BOM audit exists to catch.",
    },
  ];
}

/**
 * Audit a BOM, one migration run per row.
 *
 * **No row is skipped.** A line whose part number could not be identified — a
 * `TOTAL`, a note to the supplier, a row where the buyer left the part column
 * blank — comes back as a `needs_input` report naming the line number, not as a
 * silent gap in the output. A parser that quietly drops the three lines it did
 * not understand is how a quote ships missing three lines, and nobody finds out
 * until the panel is half built.
 *
 * Rows run **sequentially**. Parallelism here would multiply the API rate a
 * single audit hits by the width of the BOM, and would interleave the trace of
 * twenty rows into one unreadable log. A 40-line BOM is a coffee break, not a
 * latency budget.
 *
 * Each row gets its own trace so `report.trace` holds that row's events and
 * nothing else. When `deps.trace` is supplied, every row event is *also*
 * forwarded into a labelled child of it, so a live panel sees the whole audit on
 * one timeline while each report stays self-contained.
 */
export async function runBomAudit(csv: string, deps: MigrationDeps): Promise<BomAuditEntry[]> {
  const rows = parseBom(csv);
  const out: BomAuditEntry[] = [];

  for (const row of rows) {
    const parent = deps.trace?.child(`bom line ${String(row.line)}`);
    const rowTrace = createTrace(
      parent === undefined ? {} : { onEvent: (event) => { parent.emit(event); } },
    );
    const rowDeps: MigrationDeps = {
      client: deps.client,
      retriever: deps.retriever,
      competitors: deps.competitors,
      trace: rowTrace,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    };

    if (row.partNumber === undefined) {
      // Reported, never skipped — and reported without spending a model call on
      // a line that carries no part to look up.
      const questions = unprocessableQuestions(row);
      rowTrace.emit({ type: "run.start", label: `migration · bom line ${String(row.line)}`, input: "bom" });
      rowTrace.emit({
        type: "resolver.question",
        label: `bom line ${String(row.line)} is unprocessable`,
        questions,
      });
      rowTrace.emit({ type: "report.ready", label: "report ready · needs_input", outcome: "needs_input" });
      out.push({
        row,
        report: {
          input: { kind: "bom", csv },
          outcome: { kind: "needs_input", questions },
          candidates: [],
          trace: rowTrace.events().slice(),
          stats: { ms: Math.max(0, Math.round(rowTrace.elapsed())), inputTokens: 0, outputTokens: 0, toolCalls: 0 },
        },
      });
      continue;
    }

    const input: AgentInput = {
      kind: "part_number",
      value: row.partNumber,
      ...(row.vendor !== undefined ? { vendorHint: row.vendor } : {}),
    };
    out.push({ row, report: await runMigration(input, rowDeps) });
  }

  return out;
}
