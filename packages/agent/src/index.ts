/**
 * `@no-human/agent` — the public surface of the runtime agent layer.
 *
 * `@no-human/rag` answers "which SICK parts are worth considering, and where can
 * each claim be checked". This package turns messy human input into that
 * question and turns the answer into a defensible recommendation — or an honest
 * refusal. Importing this barrel is the supported way to consume it; deep
 * imports into `src/**` are not part of the contract and will move.
 *
 * ## Where to start
 *
 * - {@link runMigration} — the whole pipeline for one part: a competitor part
 *   number, a plain description, a nameplate photo, or a BOM row.
 * - {@link runBomAudit} — the same pipeline across a whole CSV.
 * - {@link consult} — the second use case: a described *problem* rather than a
 *   part, answered like an application engineer rather than a search box.
 * - {@link createTrace} — the event bus every step reports to. Pass one in and
 *   the run becomes watchable; leave it out and nothing changes about the answer.
 * - {@link createFakeClient} — a scripted {@link LlmClient} for tests. Nothing in
 *   this package should ever reach the real API from a test.
 *
 * ## The rules a consumer needs to know about
 *
 * The outcome types are the contract, and two of their branches are *successes*
 * that a caller must render rather than treat as errors:
 *
 * - `{ kind: "needs_input", questions }` — the input could not discriminate, so
 *   the run stopped and asked. Each question carries a `why` naming the concrete
 *   engineering consequence of the answer.
 * - `{ kind: "no_equivalent", closest, reason, lost }` — nothing in the catalog
 *   honestly replaces the source part. The closest miss and what it costs are
 *   attached.
 *
 * And the one that will bite a renderer: a `ConstraintVerdict` of `unknown` means
 * the printed catalog is **silent** about that spec. It is not a pass. This is
 * the summary catalog — supply voltage is printed for 41 of 1,776 SKUs — so
 * `unknown` is common, and displaying it as anything other than an unverified
 * risk is the most damaging bug available in a consumer of this package.
 *
 * ## Why the CLI is not here
 *
 * `src/cli.ts` is a binary entry point: it reads `process.argv`, touches the
 * filesystem and writes to stdout. Re-exporting it would drag those side effects
 * into every library import, so it is reachable only through the `sick-agent`
 * bin.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export type {
  AgentInput,
  Challenge,
  ChallengeReport,
  ChallengeSeverity,
  ClarifyingQuestion,
  ComparisonRow,
  ConsultOutcome,
  IdentifiedPart,
  MigrationOutcome,
  MigrationReport,
  Recommendation,
  ResolvedInput,
  SolutionDesign,
  TraceEvent,
  TraceSink,
} from "./types.js";

export { AGENT_MODEL, CHALLENGER_EFFORT, RESOLVER_EFFORT } from "./types.js";

// ---------------------------------------------------------------------------
// The Anthropic boundary — one wrapper, one place refusal is handled
// ---------------------------------------------------------------------------

export type {
  AnthropicMessagesClient,
  ClaudeClientOptions,
  Effort,
  FakeCall,
  FakeLlmClient,
  LlmClient,
  LlmTool,
  MessageCreateBody,
  MessageParam,
  Refused,
  ScriptedResponse,
  StructuredOk,
  StructuredRequest,
  ToolCallEvent,
  ToolLoopOk,
  ToolLoopRequest,
  ToolResultEvent,
  Usage,
} from "./claude.js";

export {
  createClaudeClient,
  createFakeClient,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  isRefused,
  MAX_NON_STREAMING_TOKENS,
  RefusalError,
} from "./claude.js";

// ---------------------------------------------------------------------------
// Trace — the evidence that the agents did real work
// ---------------------------------------------------------------------------

export type { CreateTraceOptions, ReplayOptions, Trace, TraceEventInput, TraceSummary } from "./trace.js";

export { createTrace, fromNdjson, replayTrace, summarizeTrace, toNdjson } from "./trace.js";

// ---------------------------------------------------------------------------
// Competitor data — looked up and cited, never recalled
// ---------------------------------------------------------------------------

export type {
  BannerConnection,
  BannerOutput,
  BannerProduct,
  BannerSensingMode,
  BannerSensingModeName,
  CompetitorIndex,
  CompetitorMatch,
  CompetitorMatchKind,
  CrossRefConfidence,
  CrossRefRow,
} from "./competitors.js";

export {
  BANNER_MODE_TO_PRINCIPLE,
  bannerCitation,
  bannerModeToPrinciple,
  loadCompetitorIndex,
  normalizeModeToken,
  normalizePartKey,
  parseCsv,
  toConstraints,
  toIdentifiedPart,
} from "./competitors.js";

// ---------------------------------------------------------------------------
// Input adapters
// ---------------------------------------------------------------------------

export type { BomRow } from "./inputs/bom.js";

export { parseBom } from "./inputs/bom.js";

export type {
  LabelImageMediaType,
  LabelReading,
  LabelReadingFailure,
  VisionClient,
  VisionRequest,
  VisionResponse,
} from "./inputs/vision.js";

export { applyHonestyClamps, LabelReadingError, readLabel } from "./inputs/vision.js";

// ---------------------------------------------------------------------------
// Resolver — messy input to a spec vector, with the sufficiency gate
// ---------------------------------------------------------------------------

export type { ResolverDeps, SufficiencyAssessment } from "./resolver.js";

export {
  assessSufficiency,
  containsSickPartReference,
  DISCRIMINATING_FIELDS,
  ELECTRICAL_FIELDS,
  MAX_QUESTIONS,
  QUANTITATIVE_FIELDS,
  resolve,
  statedFields,
} from "./resolver.js";

// ---------------------------------------------------------------------------
// Challenger — adversarial validation, deterministic seeds plus model attacks
// ---------------------------------------------------------------------------

export type { ChallengeCandidate, ChallengeContext, ChallengeDeps } from "./challenger.js";

export { challenge, challengeAll, MAX_MODEL_CHALLENGES, seedChallenges } from "./challenger.js";

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export type { BomAuditEntry, MigrationDeps } from "./orchestrator.js";

export {
  confidenceFor,
  MAX_CHALLENGED_CANDIDATES,
  RETRIEVAL_TOP_K,
  runBomAudit,
  runMigration,
  SAFETY_RELEVANT_CONSTRAINTS,
} from "./orchestrator.js";

export { buildComparison, constraintRows, renderMarkdown, renderTraceSummary } from "./report.js";

// ---------------------------------------------------------------------------
// Consultant mode
// ---------------------------------------------------------------------------

export type {
  BomRole,
  CheckStatus,
  CompatibilityCheck,
  ConsultDeps,
  ConsultGapField,
  ConsultInput,
  DesignRequirements,
  ResolvedLine,
} from "./consultant.js";

export {
  BLOCKING_GAP_FIELDS,
  blockingGapsFor,
  capConfidence,
  consult,
  CONSULT_GAP_FIELDS,
  runCompatibilityChecks,
} from "./consultant.js";
