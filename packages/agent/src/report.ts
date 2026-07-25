/**
 * Rendering — the last place an `unknown` can be laundered into a `pass`, and
 * therefore the place this package guards hardest.
 *
 * Everything upstream is careful three-valued logic: the solver says
 * `pass` / `fail` / `unknown`, the Challenger says `upheld` / `refuted` /
 * `unverifiable`. All of that care is worth exactly nothing if the renderer
 * prints an empty table cell where the catalog was silent, because a blank cell
 * next to a filled one reads as agreement. An engineer skimming a comparison
 * table does not think "the catalog does not state the response time"; they
 * think "response time is fine, nothing flagged".
 *
 * So the two rules of this module:
 *
 * 1. **Silence is rendered as words, never as whitespace.** Every cell that has
 *    no value carries {@link SOURCE_NOT_STATED} or {@link SICK_NOT_STATED} —
 *    which side is missing is always visible on the row itself.
 * 2. **An assertion without a citation is not an assertion.** A
 *    {@link ComparisonRow} carries a `citation` only when the SICK catalog
 *    actually prints the value, so "has a citation" and "is a verified claim"
 *    are the same predicate. Rows the catalog is silent about have no citation
 *    and are labelled `unverified` in the markdown.
 *
 * ## What lives here
 *
 * - {@link buildComparison} — the field-by-field table, source part vs. SICK.
 * - {@link renderMarkdown} — the engineer-facing report.
 * - {@link renderTraceSummary} — the compact terminal trace.
 *
 * All three are pure: no I/O, no clock, no model. Given the same
 * {@link MigrationReport} they produce the same bytes, which is what makes a
 * recorded demo run reproducible.
 */

import {
  citationFor,
  describeSpecs,
  type Citation,
  type ConstraintVerdict,
  type NormalizedSpec,
  type NumericConstraint,
  type SickProduct,
  type SolveResult,
  type SpecConstraints,
  type SpecFieldReport,
} from "@no-human/rag";

import { summarizeTrace } from "./trace.js";
import type {
  ChallengeReport,
  ClarifyingQuestion,
  ComparisonRow,
  IdentifiedPart,
  MigrationReport,
  Recommendation,
  TraceEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// The words that stand in for silence
// ---------------------------------------------------------------------------

/**
 * Rendered on the source side when the input never pinned this spec down.
 *
 * Exported because the phrase is asserted in tests: the exact failure this
 * module exists to prevent is this cell being empty, so the string is part of
 * the contract rather than a cosmetic choice.
 */
export const SOURCE_NOT_STATED = "not specified for the source part";

/** Rendered on the SICK side when the printed catalog is silent about a spec. */
export const SICK_NOT_STATED = "not stated in the SICK catalog";

/** Suffix marking a value the catalog printed in prose rather than a spec cell. */
const LOW_CONFIDENCE_SUFFIX = " (low-confidence source)";

/** Suffix marking a source-side value a model read off the input rather than a dataset. */
const INFERRED_SUFFIX = " (inferred from the input, not sourced)";

// ---------------------------------------------------------------------------
// The comparison field table
// ---------------------------------------------------------------------------

/** Which direction is an improvement, for the fields where a delta is meaningful. */
type Polarity = "higher" | "lower";

/**
 * One row of the comparison, declared rather than computed.
 *
 * `field` is deliberately the {@link SpecConstraints} key, not the
 * {@link SpecFieldReport} key, because that is what the solver's verdicts are
 * keyed on — it is the join column between "what was asked for" and "what the
 * catalog prints", and having two spellings of it is how a requirement silently
 * stops being checked.
 */
interface ComparisonFieldDef {
  /** {@link SpecConstraints} key. Matches {@link ConstraintVerdict.field}. */
  field: string;
  label: string;
  /** A single `describeSpecs` field backing the SICK side. */
  specField?: string;
  /** A stated interval backing the SICK side (`min`/`max` `describeSpecs` fields). */
  pair?: { min: string; max: string };
  /** Rendered after the value, e.g. `mm`. Empty for enums and booleans. */
  unit?: string;
  /** Rendered before the value, e.g. `IP `. */
  prefix?: string;
  /** Present only for fields where a single scalar delta is honest. */
  delta?: {
    polarity: Polarity;
    /** The candidate number the requirement is compared against. */
    candidate: (spec: NormalizedSpec) => number | undefined;
    better: string;
    worse: string;
  };
}

/**
 * The comparable surface, in the order an engineer reads a datasheet: what it
 * senses, how far, how fast, what it outputs, how it mounts, what it survives.
 *
 * Every field is emitted for every candidate whether or not anyone constrained
 * it and whether or not the catalog prints it. A table that lists only the
 * populated fields makes "nobody checked the response time" invisible, and
 * invisible silence is indistinguishable from a satisfied requirement.
 *
 * Deltas exist only on the four single-scalar fields. Operating temperature and
 * supply voltage are two-sided windows: there is no one number that describes
 * "−25 … +55 °C required, −20 … +60 °C offered", and inventing one (picking the
 * worse end, averaging) would be a fabricated quantity in the column an engineer
 * trusts most.
 */
const COMPARISON_FIELDS: readonly ComparisonFieldDef[] = [
  { field: "principle", label: "Sensing principle", specField: "principle" },
  {
    field: "sensingRangeMm",
    label: "Sensing range",
    pair: { min: "sensingRangeMinMm", max: "sensingRangeMaxMm" },
    unit: "mm",
    delta: {
      polarity: "higher",
      candidate: (s) => s.sensingRangeMaxMm,
      better: "more reach than required",
      worse: "short of the required distance",
    },
  },
  {
    field: "responseTimeMs",
    label: "Response time",
    specField: "responseTimeMs",
    unit: "ms",
    delta: {
      polarity: "lower",
      candidate: (s) => s.responseTimeMs,
      better: "faster than required",
      worse: "slower than required",
    },
  },
  {
    field: "switchingFrequencyHz",
    label: "Switching frequency",
    specField: "switchingFrequencyHz",
    unit: "Hz",
    delta: {
      polarity: "higher",
      candidate: (s) => s.switchingFrequencyHz,
      better: "faster switching than required",
      worse: "slower switching than required",
    },
  },
  { field: "outputType", label: "Switching output", specField: "outputType" },
  { field: "ioLink", label: "IO-Link", specField: "ioLink" },
  { field: "connector", label: "Connection", specField: "connector" },
  { field: "connectorPins", label: "Connector pins", specField: "connectorPins" },
  {
    field: "minIpRating",
    label: "Enclosure rating",
    specField: "ipRating",
    prefix: "IP ",
    delta: {
      polarity: "higher",
      candidate: (s) => s.ipRating,
      better: "above the required ingress rating",
      worse: "below the required ingress rating",
    },
  },
  { field: "ip69k", label: "IP69K washdown", specField: "ip69k" },
  {
    field: "operatingTempC",
    label: "Operating temperature",
    pair: { min: "operatingTempMinC", max: "operatingTempMaxC" },
    unit: "°C",
  },
  {
    field: "supplyVoltageV",
    label: "Supply voltage",
    pair: { min: "supplyVoltageMinV", max: "supplyVoltageMaxV" },
    unit: "V",
  },
  { field: "housing", label: "Housing material", specField: "housing" },
  { field: "light", label: "Light source", specField: "light" },
];

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** Trim binary-float artifacts out of a catalog number before a human sees it. */
function fmtNumber(n: number): string {
  return String(Number(n.toFixed(6)));
}

function fmtValue(value: string | number | boolean | null): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return fmtNumber(value);
  const text = value.trim();
  return text === "" ? undefined : text;
}

/**
 * Split a solver `detail` into the requirement half.
 *
 * `filter/constraints.ts` builds every detail as
 * `requires <requirement>, catalog <finding>`, so the first `, catalog ` is a
 * reliable seam. When it is not found the whole detail is returned rather than
 * a guess — a slightly verbose cell is a fixable annoyance, a silently truncated
 * requirement is a wrong comparison nobody can see.
 */
function requirementOf(detail: string): string {
  const seam = detail.search(/,\s*catalog\s/);
  const phrase = seam >= 0 ? detail.slice(0, seam) : detail;
  return phrase.replace(/^requires\s+/i, "").trim();
}

/**
 * The number a scalar delta is measured against.
 *
 * The *largest* number in the requirement phrase is the right pick for both
 * polarities: for a reach requirement it is the farthest distance that must be
 * covered, and for a ceiling requirement (`≤ 12 ms`, `12 ms ... 20 ms`) it is
 * the ceiling itself. Returns `undefined` when the phrase carries no number,
 * which is the normal case for enum constraints.
 */
function requestedMagnitude(requirement: string): number | undefined {
  const matches = requirement.match(/-?\d+(?:\.\d+)?/g);
  if (matches === null || matches.length === 0) return undefined;
  const numbers = matches.map(Number).filter((n) => Number.isFinite(n));
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

interface SickSide {
  text: string;
  /** True when the catalog actually prints this spec for this SKU. */
  stated: boolean;
  lowConfidence: boolean;
}

/** Render the SICK column for one field, with silence spelled out. */
function sickSideOf(def: ComparisonFieldDef, byField: ReadonlyMap<string, SpecFieldReport>): SickSide {
  const unit = def.unit === undefined ? "" : ` ${def.unit}`;
  const prefix = def.prefix ?? "";
  const wrap = (body: string, lowConfidence: boolean): SickSide => ({
    text: `${prefix}${body}${unit}`,
    stated: true,
    lowConfidence,
  });

  if (def.pair !== undefined) {
    const min = byField.get(def.pair.min);
    const max = byField.get(def.pair.max);
    const minText = min?.stated === true ? fmtValue(min.value) : undefined;
    const maxText = max?.stated === true ? fmtValue(max.value) : undefined;
    const low = (min?.lowConfidence ?? false) || (max?.lowConfidence ?? false);
    if (minText !== undefined && maxText !== undefined) return wrap(`${minText} … ${maxText}`, low);
    if (maxText !== undefined) return wrap(`≤ ${maxText}`, low);
    if (minText !== undefined) return wrap(`≥ ${minText}`, low);
    return { text: SICK_NOT_STATED, stated: false, lowConfidence: false };
  }

  const single = def.specField === undefined ? undefined : byField.get(def.specField);
  const text = single?.stated === true ? fmtValue(single.value) : undefined;
  if (text === undefined) return { text: SICK_NOT_STATED, stated: false, lowConfidence: false };
  return wrap(text, single?.lowConfidence ?? false);
}

/** A computed scalar delta, plus whether it favours the SICK part. */
interface Delta {
  text: string;
  favorable: boolean;
}

/**
 * Quantify the gap between requirement and catalog value.
 *
 * Only ever called when the verdict is `pass` or `fail` — i.e. when the catalog
 * actually states a value. An `unknown` has nothing to subtract, and printing a
 * delta against a value nobody published is the exact fabrication this module is
 * built to prevent.
 */
function deltaOf(
  def: ComparisonFieldDef,
  verdict: ConstraintVerdict,
  spec: NormalizedSpec,
): Delta | undefined {
  if (def.delta === undefined || verdict.status === "unknown") return undefined;
  const requested = requestedMagnitude(requirementOf(verdict.detail));
  if (requested === undefined) return undefined;
  const candidate = def.delta.candidate(spec);
  if (candidate === undefined) return undefined;

  const gap = candidate - requested;
  if (gap === 0) return { text: "exactly at the requirement", favorable: false };
  const favorable = def.delta.polarity === "higher" ? gap > 0 : gap < 0;
  const unit = def.unit === undefined ? "" : ` ${def.unit}`;
  const signed = `${gap > 0 ? "+" : "−"}${fmtNumber(Math.abs(gap))}`;
  return { text: `${signed}${unit} ${favorable ? def.delta.better : def.delta.worse}`, favorable };
}

/**
 * Line the source part up against a SICK candidate, field by field.
 *
 * The source column is the *requirement that was actually stated* — the solver's
 * verdict details are the only record of what the input pinned down, and using
 * them means the left-hand column can never claim a spec the input did not
 * carry. When `identified.specSource` is not `dataset`, every source value is
 * suffixed {@link INFERRED_SUFFIX}: those numbers came out of a model reading
 * the input, and a reader comparing two columns needs to know that one of them
 * is not sourced.
 *
 * A row's `citation` is present **iff** the SICK catalog prints the value, which
 * makes "has a citation" and "is a verified claim" the same test downstream.
 * Rows where either side is unstated come back `status: "unknown"` with the
 * missing side spelled out in words — never as an empty cell, which is the one
 * rendering that reads like a match when it is nothing of the kind.
 *
 * Pure. `solve.verdicts` supplies the requirements, `spec` and `product` supply
 * the catalog side, and nothing is read from anywhere else.
 */
export function buildComparison(
  identified: IdentifiedPart | undefined,
  product: SickProduct,
  spec: NormalizedSpec,
  solve: SolveResult,
): ComparisonRow[] {
  const specReports = new Map<string, SpecFieldReport>();
  for (const report of describeSpecs(product, spec)) specReports.set(report.field, report);

  const verdicts = new Map<string, ConstraintVerdict>();
  for (const verdict of solve.verdicts) {
    if (!verdicts.has(verdict.field)) verdicts.set(verdict.field, verdict);
  }

  // A part we hold no dataset row for has specs a model read off the input.
  // Everything derived from those has to say so, on every row.
  const sourceSuffix =
    identified !== undefined && identified.specSource !== "dataset" ? INFERRED_SUFFIX : "";
  const citation = citationFor(product);

  return COMPARISON_FIELDS.map((def): ComparisonRow => {
    const sick = sickSideOf(def, specReports);
    const verdict = verdicts.get(def.field);
    const sourceValue =
      verdict === undefined ? SOURCE_NOT_STATED : `${requirementOf(verdict.detail)}${sourceSuffix}`;
    const sickValue = sick.lowConfidence ? `${sick.text}${LOW_CONFIDENCE_SUFFIX}` : sick.text;

    const delta = verdict === undefined ? undefined : deltaOf(def, verdict, spec);

    let status: ComparisonRow["status"];
    if (verdict === undefined || verdict.status === "unknown" || !sick.stated) {
      // Either side unstated ⇒ unknown, full stop. A `pass` verdict on a spec
      // the catalog does not print is a pass on an assumption, not on evidence.
      status = "unknown";
    } else if (verdict.status === "fail") {
      status = "worse";
    } else {
      status = delta?.favorable === true ? "better" : "match";
    }

    return {
      field: def.field,
      label: def.label,
      sourceValue,
      sickValue,
      status,
      ...(delta !== undefined ? { delta: delta.text } : {}),
      // Citation iff the catalog states it: no page, no claim.
      ...(sick.stated ? { citation } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Make a value safe to drop inside a GFM table cell. */
function cell(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "—";
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** `B-16` (PDF page 42) — the two coordinates a reviewer needs to open the page. */
function citationText(citation: Citation): string {
  const parts = [`catalog page ${citation.sourcePage}`, `PDF page ${String(citation.pdfPage)}`];
  return parts.join(", ");
}

/** How a SKU is named in prose: `GTB6-P4212 (1052442)`. */
function productLabel(product: SickProduct): string {
  return product.typeCode === undefined
    ? product.orderNumber
    : `${product.typeCode} (${product.orderNumber})`;
}

/** How the source part is named in prose. Falls back to the raw input. */
function sourceLabel(identified: IdentifiedPart | undefined): string {
  if (identified === undefined) return "the described part";
  const name = [identified.vendor, identified.series, identified.model]
    .filter((part): part is string => part !== undefined && part.trim() !== "")
    .join(" ");
  return name === "" ? (identified.rawInput ?? "the described part") : name;
}

/** Verdict glyph + word. `unknown` never renders as a tick or a blank. */
function verdictBadge(status: ConstraintVerdict["status"]): string {
  if (status === "pass") return "✅ pass";
  if (status === "fail") return "❌ fail";
  return "⚠️ unverified";
}

function statusBadge(status: ComparisonRow["status"]): string {
  if (status === "match") return "match";
  if (status === "better") return "better";
  if (status === "worse") return "worse";
  return "unknown";
}

/** Render a numeric constraint the way it was asked for. */
function constraintText(value: NumericConstraint, unit: string): string {
  if (value.min !== undefined && value.max !== undefined) {
    return value.min === value.max
      ? `${fmtNumber(value.min)} ${unit}`
      : `${fmtNumber(value.min)} … ${fmtNumber(value.max)} ${unit}`;
  }
  if (value.min !== undefined) return `≥ ${fmtNumber(value.min)} ${unit}`;
  if (value.max !== undefined) return `≤ ${fmtNumber(value.max)} ${unit}`;
  return "(unconstrained)";
}

/**
 * The requirement set, as rows.
 *
 * Reads {@link SpecConstraints} field by field rather than looping
 * `Object.entries`, so a constraint the renderer does not know about shows up as
 * a raw JSON row instead of vanishing. A requirement that silently fails to
 * render is a requirement the reader believes was never asked for.
 */
export function constraintRows(constraints: SpecConstraints): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | undefined): void => {
    if (value !== undefined) rows.push({ label, value });
  };
  const list = (values: readonly (string | undefined)[] | undefined): string | undefined =>
    values === undefined || values.length === 0
      ? undefined
      : values.filter((v): v is string => v !== undefined).join(" or ");

  push("Sensing principle", list(constraints.principle));
  push(
    "Sensing range",
    constraints.sensingRangeMm === undefined
      ? undefined
      : constraintText(constraints.sensingRangeMm, "mm"),
  );
  push(
    "Response time",
    constraints.responseTimeMs === undefined
      ? undefined
      : constraintText(constraints.responseTimeMs, "ms"),
  );
  push(
    "Switching frequency",
    constraints.switchingFrequencyHz === undefined
      ? undefined
      : constraintText(constraints.switchingFrequencyHz, "Hz"),
  );
  push("Switching output", list(constraints.outputType));
  push("IO-Link", constraints.ioLink === undefined ? undefined : constraints.ioLink ? "required" : "not wanted");
  push("Connection", list(constraints.connector));
  push(
    "Connector pins",
    constraints.connectorPins === undefined ? undefined : String(constraints.connectorPins),
  );
  push(
    "Enclosure rating",
    constraints.minIpRating === undefined ? undefined : `≥ IP ${fmtNumber(constraints.minIpRating)}`,
  );
  push("IP69K washdown", constraints.ip69k === undefined ? undefined : constraints.ip69k ? "required" : "not wanted");
  push(
    "Operating temperature",
    constraints.operatingTempC === undefined
      ? undefined
      : constraintText(constraints.operatingTempC, "°C"),
  );
  push(
    "Supply voltage",
    constraints.supplyVoltageV === undefined
      ? undefined
      : constraintText(constraints.supplyVoltageV, "V"),
  );
  push("Housing material", list(constraints.housing));
  push("Light source", list(constraints.light));
  push("Catalog section", list(constraints.section));
  push("Row type", list(constraints.rowType));
  push("Family", list(constraints.family));
  return rows;
}

function renderQuestions(questions: readonly ClarifyingQuestion[]): string[] {
  const lines: string[] = [];
  questions.forEach((question, i) => {
    lines.push(`### ${String(i + 1)}. ${question.question}`, "");
    lines.push(`- **Constraint it would pin down:** \`${question.field}\``);
    lines.push(`- **Why it changes the answer:** ${question.why}`);
    if (question.options !== undefined && question.options.length > 0) {
      lines.push(`- **Options:** ${question.options.join(" · ")}`);
    }
    lines.push("");
  });
  return lines;
}

function renderVerdictTable(solve: SolveResult): string[] {
  if (solve.verdicts.length === 0) {
    return [
      "> No constraint could be checked against this candidate — nothing about it is verified.",
      "",
    ];
  }
  const lines = ["| Constraint | Verdict | What the catalog says |", "| --- | --- | --- |"];
  for (const verdict of solve.verdicts) {
    lines.push(
      `| \`${verdict.field}\` | ${verdictBadge(verdict.status)}${
        verdict.lowConfidence === true ? " (low-confidence source)" : ""
      } | ${cell(verdict.detail)} |`,
    );
  }
  lines.push("");
  lines.push(
    `**${String(solve.passed)} verified · ${String(solve.failed)} violated · ${String(
      solve.unknown,
    )} unverified.** An unverified constraint means the printed catalog is silent about that spec for this SKU. It is **not** a pass.`,
  );
  lines.push("");
  return lines;
}

function renderComparisonTable(rows: readonly ComparisonRow[], product: SickProduct): string[] {
  const lines = [
    `| Spec | Source part | SICK ${productLabel(product)} | Status | Delta | Source page |`,
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${cell(row.label)} | ${cell(row.sourceValue)} | ${cell(row.sickValue)} | ${statusBadge(
        row.status,
      )} | ${cell(row.delta)} | ${row.citation === undefined ? "unverified" : cell(citationText(row.citation))} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderChallenges(challenge: ChallengeReport | undefined): string[] {
  if (challenge === undefined) {
    return [
      "> This candidate was not adversarially validated, so nothing here has been attacked.",
      "",
    ];
  }
  if (challenge.challenges.length === 0) {
    return [`${challenge.summary}`, "", "> The challenger raised no objection.", ""];
  }
  const lines = [challenge.summary, "", "| Objection | Severity | Outcome | Evidence | Source page |", "| --- | --- | --- | --- | --- |"];
  for (const item of challenge.challenges) {
    lines.push(
      `| ${cell(item.claim)} | ${item.severity} | ${item.verdict} | ${cell(item.evidence)} | ${
        item.citation === undefined ? "unverified" : cell(citationText(item.citation))
      } |`,
    );
  }
  lines.push("");
  const unverifiable = challenge.challenges.filter((c) => c.verdict === "unverifiable");
  if (unverifiable.length > 0) {
    lines.push(
      `> ${String(unverifiable.length)} objection(s) came back **unverifiable** — the catalog is silent, so the risk stands unquantified. That is neither a landed hit nor a clean bill of health.`,
      "",
    );
  }
  return lines;
}

/** The unknowns, restated as the risks they are. */
function limitationLines(recommendation: Recommendation): string[] {
  const lines: string[] = [];
  for (const verdict of recommendation.solve.verdicts) {
    if (verdict.status !== "unknown") continue;
    lines.push(`- **Unverified (\`${verdict.field}\`):** ${verdict.detail}`);
  }
  const lowConfidence = recommendation.solve.verdicts.filter((v) => v.lowConfidence === true);
  for (const verdict of lowConfidence) {
    lines.push(
      `- **Low-confidence source (\`${verdict.field}\`):** the value was read from catalog prose rather than a labelled spec cell.`,
    );
  }
  const unverifiable = (recommendation.challenge?.challenges ?? []).filter(
    (c) => c.verdict === "unverifiable",
  );
  for (const item of unverifiable) {
    lines.push(`- **Unquantified risk:** ${item.claim} — ${item.evidence}`);
  }
  if (lines.length === 0) {
    lines.push("- Every requested constraint was verified against a printed catalog page.");
  }
  return lines;
}

const CONFIDENCE_NOTE: Readonly<Record<Recommendation["confidence"], string>> = {
  high: "Every requested constraint is verified `pass` against a cited page and no major objection was upheld.",
  medium:
    "Every requested constraint is verified, but a major objection was upheld — read the challenger findings before ordering.",
  low: "At least one requested constraint could not be verified from the printed catalog, or a constraint is violated. Treat this as a lead to check against the full datasheet, not a confirmed equivalence.",
};

function renderRecommendation(recommendation: Recommendation, heading: string): string[] {
  const lines: string[] = [];
  lines.push(
    `${heading} ${productLabel(recommendation.product)} — confidence: ${recommendation.confidence}`,
    "",
  );
  if (recommendation.product.productName !== undefined) {
    lines.push(recommendation.product.productName, "");
  }
  lines.push(`Cited to ${citationText(recommendation.citation)}.`, "");
  lines.push(...renderVerdictTable(recommendation.solve));
  lines.push("#### Comparison", "");
  lines.push(...renderComparisonTable(recommendation.comparison, recommendation.product));
  lines.push("#### Challenger findings", "");
  lines.push(...renderChallenges(recommendation.challenge));
  lines.push("#### Trade-offs", "");
  if (recommendation.tradeoffs.length === 0) {
    lines.push("- None identified beyond the limitations below.", "");
  } else {
    for (const tradeoff of recommendation.tradeoffs) lines.push(`- ${tradeoff}`);
    lines.push("");
  }
  lines.push("#### Limitations", "");
  lines.push(...limitationLines(recommendation));
  lines.push("");
  lines.push("#### Confidence", "");
  lines.push(`**${recommendation.confidence}** — ${CONFIDENCE_NOTE[recommendation.confidence]}`, "");
  return lines;
}

/** Every distinct citation the report asserts something on, deduped by page. */
function citationSection(report: MigrationReport): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (citation: Citation): void => {
    const key = `${citation.sourcePage}|${String(citation.pdfPage)}|${citation.orderNumber ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const name = citation.typeCode ?? citation.orderNumber ?? citation.family ?? "catalog page";
    const url = citation.productUrl === undefined ? "" : ` — ${citation.productUrl}`;
    lines.push(`- ${name} — ${citationText(citation)}${url}`);
  };

  const recommendations: Recommendation[] =
    report.outcome.kind === "recommendation"
      ? [...report.outcome.recommendations]
      : report.outcome.kind === "no_equivalent" && report.outcome.closest !== undefined
        ? [report.outcome.closest]
        : [];

  if (report.resolved?.identified?.citation !== undefined) add(report.resolved.identified.citation);
  for (const recommendation of recommendations) {
    add(recommendation.citation);
    for (const row of recommendation.comparison) {
      if (row.citation !== undefined) add(row.citation);
    }
    for (const item of recommendation.challenge?.challenges ?? []) {
      if (item.citation !== undefined) add(item.citation);
    }
  }
  if (lines.length === 0) lines.push("- No catalog page was cited: nothing in this report is asserted.");
  return lines;
}

/** The problem, restated in the agent's own words so the reader can reject it. */
function problemStatement(report: MigrationReport): string {
  const input = report.input;
  if (input.kind === "part_number") {
    return `Find the SICK equivalent of competitor part \`${input.value}\`${
      input.vendorHint === undefined ? "" : ` (${input.vendorHint})`
    }.`;
  }
  if (input.kind === "description") return `Find a SICK part matching: “${input.value}”.`;
  if (input.kind === "problem") return `Application problem: “${input.value}”.`;
  if (input.kind === "image") {
    return `Identify the part on the supplied nameplate photo${
      input.note === undefined ? "" : ` (note: “${input.note}”)`
    } and find its SICK equivalent.`;
  }
  return "Audit a bill of materials row by row against the SICK catalog.";
}

/**
 * The engineer-facing report.
 *
 * Three shapes, one per {@link MigrationOutcome}:
 *
 * - `needs_input` renders **only** the questions. Not a partial comparison, not
 *   a shortlist, not "here is what we would have looked at" — the whole point of
 *   the sufficiency gate is that a thin input produces no answer-shaped output
 *   at all, and a reader who is shown candidates will anchor on them regardless
 *   of the disclaimer above.
 * - `no_equivalent` leads with the refusal and what it costs. This is a
 *   successful run and it is rendered as one.
 * - `recommendation` renders the full audit trail: verdicts, comparison,
 *   challenger findings, trade-offs, limitations, confidence, citations.
 *
 * Pure and deterministic — the same report renders to the same bytes.
 */
export function renderMarkdown(report: MigrationReport): string {
  const lines: string[] = [];
  const outcome = report.outcome;

  if (outcome.kind === "needs_input") {
    lines.push("# More information needed", "");
    lines.push(
      "The input does not pin down enough to discriminate across the catalog. Answering anyway would produce a confident recommendation resting on assumptions nobody stated, so the run stopped here.",
      "",
    );
    lines.push("## Questions", "");
    if (outcome.questions.length === 0) {
      lines.push(
        "- The resolver reported the input as insufficient but produced no question. Re-state the requirement with a sensing principle and at least one quantitative constraint.",
        "",
      );
    } else {
      lines.push(...renderQuestions(outcome.questions));
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const source = sourceLabel(report.resolved?.identified);

  if (outcome.kind === "no_equivalent") {
    lines.push(`# No honest SICK equivalent for ${source}`, "");
    lines.push(`> ${outcome.reason}`, "");
    lines.push("## What you give up", "");
    if (outcome.lost.length === 0) {
      lines.push("- Nothing could be enumerated: no candidate got far enough to cost anything.", "");
    } else {
      for (const lost of outcome.lost) lines.push(`- ${lost}`);
      lines.push("");
    }
  } else {
    lines.push(`# SICK equivalent for ${source}`, "");
  }

  lines.push("## Problem", "");
  lines.push(problemStatement(report), "");

  const resolved = report.resolved;
  lines.push("## Requirements detected", "");
  const requirements = resolved === undefined ? [] : constraintRows(resolved.constraints);
  if (requirements.length === 0) {
    lines.push("- None. Nothing was constrained, so nothing could be verified.", "");
  } else {
    lines.push("| Requirement | Value |", "| --- | --- |");
    for (const row of requirements) lines.push(`| ${cell(row.label)} | ${cell(row.value)} |`);
    lines.push("");
  }

  lines.push("## Assumptions", "");
  const assumptions = resolved?.assumptions ?? [];
  if (assumptions.length === 0) {
    lines.push("- None recorded.", "");
  } else {
    for (const assumption of assumptions) lines.push(`- ${assumption}`);
    lines.push("");
  }
  if (resolved !== undefined && resolved.missing.length > 0) {
    lines.push(
      `> Not pinned down by the input: ${resolved.missing.map((m) => `\`${m}\``).join(", ")}. Those constraints were not checked and are not claimed.`,
      "",
    );
  }
  if (resolved?.identified !== undefined && resolved.identified.specSource !== "dataset") {
    lines.push(
      `> Source-part specs are \`${resolved.identified.specSource}\` — we hold no extracted record for it, so the left-hand column of every comparison below is not sourced.`,
      "",
    );
  }

  if (outcome.kind === "no_equivalent") {
    if (outcome.closest === undefined) {
      lines.push("## Closest candidate", "", "- None. Nothing survived retrieval or the solve.", "");
    } else {
      lines.push("## Closest candidate (rejected)", "");
      lines.push(...renderRecommendation(outcome.closest, "###"));
    }
  } else {
    lines.push("## Recommendations", "");
    outcome.recommendations.forEach((recommendation) => {
      lines.push(...renderRecommendation(recommendation, `### ${String(recommendation.rank)}.`));
    });
  }

  lines.push("## Citations", "");
  lines.push(...citationSection(report));
  lines.push("");
  lines.push(
    `_Solved over ${String(report.candidates.length)} retrieved candidate(s) in ${String(
      report.stats.ms,
    )} ms · ${String(report.stats.inputTokens)} in / ${String(report.stats.outputTokens)} out tokens · ${String(
      report.stats.toolCalls,
    )} tool call(s)._`,
  );

  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Terminal trace
// ---------------------------------------------------------------------------

/** One-line gloss per event type, for the compact terminal view. */
function traceLine(event: TraceEvent): string {
  const at = `${String(Math.round(event.at)).padStart(6)} ms`;
  const type = event.type.padEnd(22);
  return `${at}  ${type}  ${event.label}`;
}

/**
 * The compact per-stage trace, for a terminal.
 *
 * Deliberately one line per event with no wrapping and no colour: this is what
 * gets pasted into an issue when a run went wrong, and a reader needs to see the
 * stage order and the timings without a renderer. The header counters come from
 * {@link summarizeTrace}, which keeps `upheld` and `unverifiable` challenge
 * counts apart — folding them together here would be the same unknown-as-pass
 * bug in a different font.
 */
export function renderTraceSummary(report: MigrationReport): string {
  const summary = summarizeTrace(report.trace);
  const lines: string[] = [];
  lines.push(
    `run · ${report.input.kind} → ${report.outcome.kind} · ${String(report.trace.length)} events · ${String(
      summary.ms,
    )} ms`,
  );
  lines.push(
    `tools ${String(summary.toolCalls)} · attacks ${String(summary.attacks)} · upheld ${String(
      summary.upheld,
    )} · tokens ${String(report.stats.inputTokens)}/${String(report.stats.outputTokens)}`,
  );
  lines.push("-".repeat(72));
  for (const event of report.trace) lines.push(traceLine(event));
  if (report.trace.length === 0) lines.push("(no events recorded)");
  return `${lines.join("\n")}\n`;
}
