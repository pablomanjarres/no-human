/**
 * The Resolver — the gate every run passes through.
 *
 * Its job is to turn whatever a human handed us (a part number, a sentence, a
 * photograph of a corroded nameplate) into a {@link SpecConstraints} vector, and
 * then to answer one question honestly: *is this enough to recommend on?*
 *
 * Everything downstream is deterministic and defensible. Retrieval ranks, the
 * solver verifies, the Challenger attacks — all of it against the constraint set
 * this module emits. Which means a bad constraint set does not produce a bad
 * answer; it produces a **confident** bad answer, fully cited, with a green
 * comparison table. That is the failure this file exists to prevent, and it is
 * why so much of what follows is about refusing to fill a blank.
 *
 * ## Four rules enforced here, in code, not in a prompt
 *
 * 1. **The dataset beats the model.** For a competitor part we hold real
 *    extracted data on, constraints are built by {@link toConstraints} — a pure
 *    function over a JSONL row with a page number behind it. The model is not
 *    consulted at all, because a model asked to recall a Banner spec will answer,
 *    fluently, and a hallucinated *competitor* spec is caught by nothing
 *    downstream: it becomes the left-hand column of the comparison and every
 *    verdict derived from it is wrong in a way no citation can reveal.
 * 2. **A thin input returns a question.** The sufficiency gate
 *    ({@link assessSufficiency}) is arithmetic over stated fields, not a judgement
 *    call by a model. See its doc for the exact criterion.
 * 3. **The model may not name a part.** Structurally: the extraction schema has
 *    no field that can hold one (no `family`, no `section`, no free identifier).
 *    Defensively: every string the model produces is swept by
 *    {@link containsSickPartReference} and dropped if it names one, with the
 *    violation recorded in `rationale`. Asking the prompt nicely is not enforcement.
 * 4. **Every inference is rejectable.** Anything the Resolver concluded rather
 *    than read lands in `assumptions`, phrased so a user can strike one line.
 *
 * ## What this module deliberately does not do
 *
 * - It does not read `competitors.priorRecommendation()` or `knownGap()`. Those
 *   rows name SICK parts, and a resolver that has already seen the answer will
 *   write constraints that select it. The crossref is the orchestrator's
 *   sanity-check *after* a solve, never the Resolver's input.
 * - It does not scan free text for competitor part numbers. `M12` is a real
 *   Banner series *and* the most common connector token in the language; a
 *   substring lookup would turn "M12 connector" into a dataset-backed
 *   identification of a through-beam sensor. Part numbers arrive through
 *   `kind: "part_number"` or off a nameplate, where they are actually asserted.
 * - It does not handle `bom` or `problem`. The orchestrator drives `parseBom` and
 *   calls this per row; consultant mode is a different agent entirely.
 */

import type {
  ConnectorType,
  NormalizedSpec,
  NumericConstraint,
  OutputType,
  SensingPrinciple,
  SpecConstraints,
} from "@no-human/rag";

import type { LlmClient } from "./claude.js";
import { isRefused } from "./claude.js";
import type { CompetitorIndex, CompetitorMatch } from "./competitors.js";
import { toConstraints, toIdentifiedPart } from "./competitors.js";
import type { LabelReading, VisionClient } from "./inputs/vision.js";
import { readLabel } from "./inputs/vision.js";
import type { Trace } from "./trace.js";
import { RESOLVER_EFFORT } from "./types.js";
import type { AgentInput, ClarifyingQuestion, IdentifiedPart, ResolvedInput } from "./types.js";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything {@link resolve} needs, injected.
 *
 * `vision` is separate from `client` because {@link readLabel} predates the
 * {@link LlmClient} wrapper and speaks the SDK's `messages.create` shape
 * directly — it needs image content blocks and its own honesty clamps. It is
 * optional so that the three text paths need no vision plumbing at all; an
 * `image` input without it throws rather than silently degrading to a guess.
 */
export interface ResolverDeps {
  readonly client: LlmClient;
  readonly competitors: CompetitorIndex;
  readonly trace: Trace;
  /** Required only for `kind: "image"`. Anything exposing `messages.create`. */
  readonly vision?: VisionClient;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// The sufficiency gate
// ---------------------------------------------------------------------------

/**
 * Numeric constraint fields that meaningfully cut the catalog down.
 *
 * These are the specs an engineer states when they know what they need, and the
 * ones the SICK catalog actually prints often enough to filter on.
 */
export const QUANTITATIVE_FIELDS: readonly string[] = [
  "sensingRangeMm",
  "responseTimeMs",
  "switchingFrequencyHz",
  "supplyVoltageV",
  "operatingTempC",
];

/** Electrical / ingress fields that discriminate as hard as a number does. */
export const ELECTRICAL_FIELDS: readonly string[] = [
  "outputType",
  "connector",
  "connectorPins",
  "ioLink",
  "minIpRating",
  "ip69k",
];

/**
 * Fields that count toward the "at least one discriminating constraint" half of
 * the gate. `housing` and `light` are deliberately excluded: they narrow, but
 * neither one turns "a sensor" into "this sensor", and letting them satisfy the
 * gate would wave through a run whose only real content is "make it plastic".
 */
export const DISCRIMINATING_FIELDS: readonly string[] = [
  ...QUANTITATIVE_FIELDS,
  ...ELECTRICAL_FIELDS,
];

/**
 * How many principles (or catalog sections) may be listed and still count as an
 * anchor.
 *
 * A Banner MINI-BEAM covers through-beam, retroreflective, diffuse *and*
 * convergent optics in one series card. Searching all four at once with no range
 * is not a search — it is section B of the catalog, several hundred SKUs, with
 * nothing to choose between them. Two is the point where a comparison is still
 * meaningful ("through-beam or retroreflective, I have a reflector either way");
 * three is where the user has to tell us which machine they are actually
 * standing in front of.
 */
export const MAX_ANCHOR_BREADTH = 2;

/** Most questions to ask in one round. Past this it reads as an interrogation
 *  and the user answers none of them. */
export const MAX_QUESTIONS = 4;

/** Every constraint field this module tracks, for `ResolvedInput.missing`. */
const TRACKED_FIELDS: readonly string[] = [
  "principle",
  "sensingRangeMm",
  "responseTimeMs",
  "switchingFrequencyHz",
  "outputType",
  "connector",
  "connectorPins",
  "minIpRating",
  "ip69k",
  "ioLink",
  "supplyVoltageV",
  "operatingTempC",
  "housing",
  "light",
];

function bounded(constraint: NumericConstraint | undefined): boolean {
  if (constraint === undefined) return false;
  const hasMin = typeof constraint.min === "number" && Number.isFinite(constraint.min);
  const hasMax = typeof constraint.max === "number" && Number.isFinite(constraint.max);
  return hasMin || hasMax;
}

/** A list constraint counts only when it holds at least one *informative* token
 *  — an `["unknown"]` output type is the absence of a requirement wearing a
 *  requirement's clothes. */
function informative(values: readonly (string | undefined)[] | undefined): boolean {
  return values !== undefined && values.some((v) => v !== undefined && v !== "unknown");
}

/**
 * Which constraint fields this set actually states.
 *
 * Exported because "stated" is a load-bearing definition here — an empty array,
 * a `{ }` numeric range and an `["unknown"]` enum list are all *absent*, and any
 * code that decides otherwise starts treating unknowns as requirements.
 */
export function statedFields(constraints: SpecConstraints): string[] {
  const out: string[] = [];
  if (informative(constraints.principle)) out.push("principle");
  if (bounded(constraints.sensingRangeMm)) out.push("sensingRangeMm");
  if (bounded(constraints.responseTimeMs)) out.push("responseTimeMs");
  if (bounded(constraints.switchingFrequencyHz)) out.push("switchingFrequencyHz");
  if (bounded(constraints.supplyVoltageV)) out.push("supplyVoltageV");
  if (bounded(constraints.operatingTempC)) out.push("operatingTempC");
  if (informative(constraints.outputType)) out.push("outputType");
  if (informative(constraints.connector)) out.push("connector");
  if (typeof constraints.connectorPins === "number") out.push("connectorPins");
  if (typeof constraints.minIpRating === "number") out.push("minIpRating");
  if (typeof constraints.ip69k === "boolean") out.push("ip69k");
  if (typeof constraints.ioLink === "boolean") out.push("ioLink");
  if (informative(constraints.housing)) out.push("housing");
  if (informative(constraints.light)) out.push("light");
  if (informative(constraints.section)) out.push("section");
  if (informative(constraints.family)) out.push("family");
  return out;
}

/** The gate's finding, with enough detail to write a rationale from. */
export interface SufficiencyAssessment {
  /** True only when both halves of the criterion hold. */
  sufficient: boolean;
  /** True when the search space is anchored to a principle or a catalog category. */
  anchored: boolean;
  /** The discriminating fields actually stated. Empty means the second half fails. */
  discriminators: string[];
  /** One line, quoted verbatim into `ResolvedInput.rationale`. */
  reason: string;
}

/**
 * Decide whether a constraint set can responsibly drive a recommendation.
 *
 * The criterion, stated so it can be argued with rather than felt:
 *
 * > **A** — the space is *anchored*: a sensing principle naming 1–{@link
 * > MAX_ANCHOR_BREADTH} principles, **or** a catalog category (`family`, or
 * > `section` naming at most {@link MAX_ANCHOR_BREADTH} sections).
 * >
 * > **B** — at least one *discriminating* constraint is stated: a bounded
 * > quantitative field or an electrical/ingress field
 * > ({@link DISCRIMINATING_FIELDS}).
 * >
 * > Sufficient ⟺ A ∧ B.
 *
 * Why both halves. **A** alone ("a diffuse photoelectric sensor") describes
 * roughly a third of section B and gives the solver nothing to fail a candidate
 * on, so the top hit is decided by text-similarity — a heuristic, presented as
 * an engineering answer. **B** alone ("PNP, 12 ms") spans inductive, photo-
 * electric and ultrasonic families that solve completely different problems;
 * ranking picks between them on wording. Neither failure is visible in the
 * output, which is exactly why the check is here and not left to judgement.
 *
 * The breadth clamp on **A** is the same argument applied to modular competitor
 * series — see {@link MAX_ANCHOR_BREADTH}.
 */
export function assessSufficiency(constraints: SpecConstraints): SufficiencyAssessment {
  const stated = new Set(statedFields(constraints));

  const principles = (constraints.principle ?? []).filter((p) => p !== "unknown");
  const sections = constraints.section ?? [];
  const byPrinciple = principles.length >= 1 && principles.length <= MAX_ANCHOR_BREADTH;
  const bySection = sections.length >= 1 && sections.length <= MAX_ANCHOR_BREADTH;
  const byFamily = (constraints.family ?? []).length >= 1;
  const anchored = byPrinciple || bySection || byFamily;

  const discriminators = DISCRIMINATING_FIELDS.filter((f) => stated.has(f));
  const sufficient = anchored && discriminators.length > 0;

  let reason: string;
  if (sufficient) {
    reason =
      `Sufficient: the search is anchored (${anchorLabel(principles, sections, byFamily)}) and ` +
      `${String(discriminators.length)} discriminating constraint${discriminators.length === 1 ? "" : "s"} ` +
      `(${discriminators.join(", ")}) can be verified per candidate.`;
  } else if (!anchored && discriminators.length === 0) {
    reason =
      "Not sufficient: nothing anchors the search to a sensing principle or catalog category, and no " +
      "quantitative or electrical constraint was stated. This would rank 1,776 SKUs by wording alone.";
  } else if (!anchored) {
    reason =
      principles.length > MAX_ANCHOR_BREADTH
        ? `Not sufficient: ${String(principles.length)} sensing principles are in play (${principles.join(", ")}), ` +
          `which is a whole catalog section rather than a search. One principle has to be chosen before a ` +
          `range or a candidate list means anything.`
        : "Not sufficient: no sensing principle or catalog category anchors the search, so the constraints " +
          "that were stated would be applied across unrelated sensor families.";
  } else {
    reason =
      "Not sufficient: the sensing principle is known but no quantitative or electrical constraint was " +
      "stated, so the solver would have nothing to fail a candidate on and ranking would decide the answer.";
  }

  return { sufficient, anchored, discriminators, reason };
}

function anchorLabel(
  principles: readonly SensingPrinciple[],
  sections: readonly string[],
  byFamily: boolean,
): string {
  if (principles.length > 0 && principles.length <= MAX_ANCHOR_BREADTH) {
    return `principle: ${principles.join(" or ")}`;
  }
  if (byFamily) return "family";
  if (sections.length > 0) return `section ${sections.join("/")}`;
  return "category";
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Ask-order, most discriminating first.
 *
 * The ordering is the point. `partNumber` leads because an unconfirmed
 * identifier invalidates every other answer the user could give. `principle`
 * follows because it is the only field that changes *which part of the catalog*
 * is searched, and range comes next because it is the hardest numeric filter the
 * SICK data actually prints. `supplyVoltageV` sits far down on purpose — only 41
 * of 1,776 SKUs state one, so the answer usually cannot be verified against
 * anything and asking for it early spends the user's patience on a question we
 * cannot use.
 */
const QUESTION_RANK: readonly string[] = [
  "partNumber",
  "description",
  "principle",
  "sensingRangeMm",
  "outputType",
  "connector",
  "minIpRating",
  "responseTimeMs",
  "switchingFrequencyHz",
  "connectorPins",
  "ioLink",
  "operatingTempC",
  "supplyVoltageV",
  "housing",
  "light",
];

interface QuestionTemplate {
  question: string;
  why: string;
  options?: string[];
}

/**
 * Default phrasing per field.
 *
 * Each `why` states how the answer changes the recommendation, because a
 * question the user cannot see the point of reads as a stalling tactic and gets
 * answered with "just pick something" — which is the outcome the gate exists to
 * avoid.
 */
const QUESTION_TEMPLATES: Readonly<Record<string, QuestionTemplate>> = {
  principle: {
    question:
      "Which sensing mode does this application actually run — through-beam, retroreflective, diffuse, or background suppression?",
    why: "The sensing mode decides which part of the catalog is even searched. A modular series covers several modes at once, and their ranges differ by two orders of magnitude, so until one is chosen no candidate list is meaningful.",
    options: [
      "through-beam",
      "retroreflective",
      "diffuse",
      "background-suppression",
      "ultrasonic",
      "inductive",
      "capacitive",
    ],
  },
  sensingRangeMm: {
    question: "At what distance does the sensor have to detect the target, in mm?",
    why: "Range is the hardest numeric filter this catalog supports. Without it every optical family stays in the running and the top result is decided by wording rather than by physics.",
  },
  outputType: {
    question: "What switching output does the existing input card expect — PNP, NPN, push-pull, or analog?",
    why: "A PNP sensor wired into an NPN input does not switch at all. This is a hard pass/fail per candidate and it eliminates roughly half the catalog either way.",
    options: ["PNP", "NPN", "PNP/NPN", "push-pull", "analog", "relay"],
  },
  connector: {
    question: "How is the sensor wired — M12 connector, M8, M5, or a fixed cable?",
    why: "The connector decides whether this is a drop-in swap or a rewire. It is the most common reason a spec-correct replacement gets sent back.",
    options: ["M12", "M8", "M5", "cable", "terminal"],
  },
  minIpRating: {
    question: "What ingress protection does the installation need — IP65, IP67, IP69K?",
    why: "In a wash-down cell an under-rated housing fails within weeks. The rating removes whole families from consideration, so it narrows hard and it is safety-relevant.",
    options: ["IP65", "IP66", "IP67", "IP68", "IP69K"],
  },
  responseTimeMs: {
    question: "What is the maximum acceptable response time, in ms?",
    why: "Response time bounds the line speed the sensor can keep up with. Too slow and the target is missed — and unlike mounting or wiring, this is not something the installation can compensate for.",
  },
  switchingFrequencyHz: {
    question: "What switching frequency does the application need, in Hz?",
    why: "Switching frequency and response time together decide whether the sensor can see every part on a moving line; a candidate that fails it is disqualified regardless of range.",
  },
  connectorPins: {
    question: "How many pins does the connector have — 3, 4, or 5?",
    why: "Pin count decides whether the existing cable fits. A 4-pin M12 cable on a 5-pin sensor leaves a function unwired.",
    options: ["3", "4", "5"],
  },
  ioLink: {
    question: "Does the sensor need IO-Link?",
    why: "IO-Link is a hard filter: either the device speaks it or the controller cannot configure it remotely, and the SICK variants that do carry different order numbers.",
    options: ["yes", "no"],
  },
  operatingTempC: {
    question: "What ambient temperature range does the sensor have to survive, in °C?",
    why: "Temperature is stated often enough in this catalog to be checkable, and an out-of-range sensor fails intermittently rather than obviously — the worst way for one to fail.",
  },
  supplyVoltageV: {
    question: "What supply voltage is available at the sensor?",
    why: "It rules out AC-only and 110 V variants outright. Worth knowing, but be aware the SICK summary catalog prints a supply voltage for only 41 of its 1,776 SKUs, so for most candidates this will come back unverified rather than confirmed.",
  },
  housing: {
    question: "Does the housing have to be metal, stainless steel, or is plastic acceptable?",
    why: "Housing material decides chemical and impact survivability in the cell, and stainless variants are separate order numbers.",
    options: ["plastic", "metal", "stainless-steel"],
  },
  light: {
    question: "What light source does the application need — visible red, infrared, or laser?",
    why: "Visible red is alignable by eye, infrared is not, and laser gives a small spot on a small target. This changes which variant of the same family you want.",
  },
};

/** A generic fallback for the case where we know we cannot proceed but have no
 *  specific field to name — a model refusal, most often. */
const FALLBACK_QUESTION: ClarifyingQuestion = {
  field: "description",
  question:
    "Can you describe the application — what is being detected, at what distance, and what the sensor has to plug into?",
  why: "Nothing usable could be extracted from the input, so there is no constraint set to search with. Any recommendation made from here would be a guess dressed as an answer.",
};

function templateQuestion(field: string): ClarifyingQuestion {
  const template = QUESTION_TEMPLATES[field];
  if (template === undefined) {
    return {
      field,
      question: `What value should ${field} take?`,
      why: "This field is unconstrained, and the solver cannot verify a requirement that was never stated.",
    };
  }
  return {
    field,
    question: template.question,
    why: template.why,
    ...(template.options !== undefined ? { options: [...template.options] } : {}),
  };
}

/** Sort by {@link QUESTION_RANK}; unranked fields trail in insertion order. */
function byDiscriminatingPower(a: ClarifyingQuestion, b: ClarifyingQuestion): number {
  const rank = (q: ClarifyingQuestion): number => {
    const index = QUESTION_RANK.indexOf(q.field);
    return index === -1 ? QUESTION_RANK.length : index;
  };
  return rank(a) - rank(b);
}

// ---------------------------------------------------------------------------
// Rule 1 enforcement: the model may not name a SICK part
// ---------------------------------------------------------------------------

/** SICK *Referencia* — exactly seven digits, e.g. `1052445`. */
const SICK_ORDER_NUMBER = /\b\d{7}\b/;

/**
 * SICK *Tipo* — e.g. `GTB6-P4212`, `WTB4-3P2264`, `DT35-B15251`.
 *
 * Deliberately conservative. The suffix must be five or more characters and
 * contain a digit, which keeps ordinary engineering prose out of it: `M12-4PIN`
 * (four-character suffix) and `IP67-rated` (lowercase) do not match, and neither
 * does any Banner series name in the dataset. A false positive here costs one
 * dropped sentence and a note in the rationale; a false negative lets a model
 * hand the user a part number, which is rule 1 gone.
 */
const SICK_TYPE_CODE = /\b[A-Z]{2,4}\d{1,3}[A-Z]?-(?=[A-Z0-9]{5,}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{5,}\b/;

/**
 * True when a string looks like it names a SICK SKU.
 *
 * Used to sweep every free-text string a model produced. Exported because this
 * is a safety property of the package and deserves to be asserted directly
 * rather than only through the paths that call it.
 */
export function containsSickPartReference(text: string): boolean {
  return SICK_ORDER_NUMBER.test(text) || SICK_TYPE_CODE.test(text);
}

// ---------------------------------------------------------------------------
// Extraction schema
// ---------------------------------------------------------------------------

const PRINCIPLES: readonly SensingPrinciple[] = [
  "diffuse",
  "background-suppression",
  "foreground-suppression",
  "retroreflective",
  "through-beam",
  "inductive",
  "capacitive",
  "magnetic",
  "ultrasonic",
  "laser-distance",
  "contrast",
  "luminescence",
  "color",
  "fork",
  "light-grid",
  "safety-light-curtain",
  "encoder",
  "vision",
  "identification",
  "fluid",
  "safety-switch",
  "safety-controller",
];

const OUTPUT_TYPES: readonly OutputType[] = [
  "PNP",
  "NPN",
  "PNP/NPN",
  "push-pull",
  "analog",
  "relay",
];

const CONNECTORS: readonly ConnectorType[] = ["M8", "M12", "M5", "cable", "terminal", "other"];

type HousingToken = Exclude<NormalizedSpec["housing"], undefined>;
type LightToken = Exclude<NormalizedSpec["light"], undefined>;

const HOUSINGS: readonly HousingToken[] = ["plastic", "metal", "stainless-steel", "other"];
const LIGHTS: readonly LightToken[] = ["red", "infrared", "laser", "white", "rgb", "green", "other"];

/**
 * The only shape the model is allowed to answer in.
 *
 * Note what is *absent*: `family`, `section`, and any free identifier field.
 * There is nowhere in this schema to put a SICK part number, which makes rule 1
 * a structural property rather than a request. The remaining free text
 * (`questions`, `assumptions`, `notes`) is swept by
 * {@link containsSickPartReference} before it reaches a caller.
 *
 * Numerics are flat and nullable rather than nested objects: models comply far
 * more reliably with "always emit the key, use null when the input did not say"
 * than with optionality, and one flattening pass in {@link toSpecConstraints}
 * is cheaper than a class of silently-empty nested ranges.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "principle",
    "sensingRangeMinMm",
    "sensingRangeMaxMm",
    "responseTimeMaxMs",
    "switchingFrequencyMinHz",
    "supplyVoltageMinV",
    "supplyVoltageMaxV",
    "operatingTempMinC",
    "operatingTempMaxC",
    "outputType",
    "connector",
    "connectorPins",
    "minIpRating",
    "ip69k",
    "ioLink",
    "housing",
    "light",
    "questions",
    "assumptions",
    "notes",
  ],
  properties: {
    principle: {
      type: ["array", "null"],
      items: { type: "string", enum: [...PRINCIPLES] },
      description:
        "Sensing principles the input states or unambiguously implies. null when the input does not say how the target is to be detected. Do not list every principle that could work.",
    },
    sensingRangeMinMm: {
      type: ["number", "null"],
      description: "Distance in mm the sensor must be able to detect at. Convert m/cm/inches to mm.",
    },
    sensingRangeMaxMm: {
      type: ["number", "null"],
      description: "Upper bound on sensing distance in mm, only when the input states one.",
    },
    responseTimeMaxMs: {
      type: ["number", "null"],
      description: "Maximum acceptable response time in ms.",
    },
    switchingFrequencyMinHz: {
      type: ["number", "null"],
      description: "Minimum required switching frequency in Hz.",
    },
    supplyVoltageMinV: { type: ["number", "null"], description: "Lowest supply voltage available, in V." },
    supplyVoltageMaxV: { type: ["number", "null"], description: "Highest supply voltage available, in V." },
    operatingTempMinC: { type: ["number", "null"], description: "Lowest ambient temperature, in °C." },
    operatingTempMaxC: { type: ["number", "null"], description: "Highest ambient temperature, in °C." },
    outputType: {
      type: ["array", "null"],
      items: { type: "string", enum: [...OUTPUT_TYPES] },
      description: "Acceptable switching output types. null when the input does not state one.",
    },
    connector: {
      type: ["array", "null"],
      items: { type: "string", enum: [...CONNECTORS] },
      description: "Acceptable electrical connections. null when the input does not state one.",
    },
    connectorPins: { type: ["integer", "null"], description: "Required pin count on the connector." },
    minIpRating: {
      type: ["integer", "null"],
      description: "Minimum ingress protection as an integer: IP67 becomes 67.",
    },
    ip69k: {
      type: ["boolean", "null"],
      description: "true only when IP69K specifically is required. null when ingress was not discussed.",
    },
    ioLink: { type: ["boolean", "null"], description: "true when IO-Link is required. null when not discussed." },
    housing: {
      type: ["array", "null"],
      items: { type: "string", enum: [...HOUSINGS] },
      description: "Acceptable housing materials.",
    },
    light: {
      type: ["array", "null"],
      items: { type: "string", enum: [...LIGHTS] },
      description: "Acceptable light sources.",
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "question", "why", "options"],
        properties: {
          field: { type: "string", description: "The constraint field this question would populate." },
          question: { type: "string" },
          why: {
            type: "string",
            description: "How the answer changes the recommendation. Not a restatement of the question.",
          },
          options: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Suggested answers when the space is small and enumerable. null otherwise.",
          },
        },
      },
      description: "What you would need to know to discriminate. Empty array when the input is already specific.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Every inference you made rather than read, phrased so the user can reject it in one sentence. Empty array when you inferred nothing.",
    },
    notes: {
      type: ["string", "null"],
      description: "One sentence on how you read the input. No part numbers, no product recommendations.",
    },
  },
} as const;

const SYSTEM_PROMPT = `You turn a messy engineering request into a CONSTRAINT SET for an industrial sensor. You do not choose a product, and you never will — a deterministic solver picks parts from a catalog by checking your constraints against a spec table, and it is the only thing allowed to.

1. NEVER name, invent, imply or hint at a SICK part number, type code or product family. Any part identifier in your output is discarded and recorded as a rule violation, and the run is worse for it. Describe requirements, not products.
2. Emit a constraint ONLY for something the input states or unambiguously implies. null is the correct answer for everything else. A guessed constraint is indistinguishable downstream from a real requirement: it silently disqualifies correct parts and endorses wrong ones, and no citation can reveal it.
3. Put every inference you did make in "assumptions", one sentence each, phrased so a user can strike it out.
4. When the input cannot discriminate — no sensing principle, no distance, no electrical detail — fill "questions" instead of filling the constraints. Order them so the one that narrows the search most comes first, and make each "why" state how the answer changes the recommendation. A question costs one round trip; a confident wrong answer costs a machine.
5. Units are fixed: mm for distance, ms for time, Hz for frequency, V for supply, °C for temperature. Convert (2 m becomes 2000, 5 inches becomes 127). If the source unit was ambiguous, convert anyway and record the conversion as an assumption.
6. "sensingRangeMinMm" is the distance the sensor must REACH, not the size of the target and not the mounting distance you would prefer.

Absent is not failing. A spec nobody stated is unknown, and unknown must survive to the user as an unverified risk — it is never quietly upgraded into a requirement or into a pass.`;

// ---------------------------------------------------------------------------
// Reading the model's answer
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  const n = readNumber(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Keep only tokens that are in the canonical union. A model that invents
 *  `"photoelectric"` must not smuggle it into a constraint the solver will then
 *  fail to interpret — dropping it yields `unknown`, which is the truth. */
function readEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const match = allowed.find((a) => a === item);
    if (match !== undefined && !out.includes(match)) out.push(match);
  }
  return out.length > 0 ? out : undefined;
}

function numericConstraint(min: number | undefined, max: number | undefined): NumericConstraint | undefined {
  if (min === undefined && max === undefined) return undefined;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

/** Flatten one extraction payload into {@link SpecConstraints}, dropping
 *  anything that was null, out-of-union or unbounded. */
function toSpecConstraints(raw: Record<string, unknown>): SpecConstraints {
  const principle = readEnumList(raw["principle"], PRINCIPLES);
  const outputType = readEnumList(raw["outputType"], OUTPUT_TYPES);
  const connector = readEnumList(raw["connector"], CONNECTORS);
  const housing = readEnumList(raw["housing"], HOUSINGS);
  const light = readEnumList(raw["light"], LIGHTS);

  const sensingRangeMm = numericConstraint(
    readNumber(raw["sensingRangeMinMm"]),
    readNumber(raw["sensingRangeMaxMm"]),
  );
  const responseTimeMs = numericConstraint(undefined, readNumber(raw["responseTimeMaxMs"]));
  const switchingFrequencyHz = numericConstraint(readNumber(raw["switchingFrequencyMinHz"]), undefined);
  const supplyVoltageV = numericConstraint(
    readNumber(raw["supplyVoltageMinV"]),
    readNumber(raw["supplyVoltageMaxV"]),
  );
  const operatingTempC = numericConstraint(
    readNumber(raw["operatingTempMinC"]),
    readNumber(raw["operatingTempMaxC"]),
  );

  const connectorPins = readInteger(raw["connectorPins"]);
  const minIpRating = readInteger(raw["minIpRating"]);
  const ip69k = readBoolean(raw["ip69k"]);
  const ioLink = readBoolean(raw["ioLink"]);

  return {
    ...(principle !== undefined ? { principle } : {}),
    ...(outputType !== undefined ? { outputType } : {}),
    ...(connector !== undefined ? { connector } : {}),
    ...(housing !== undefined ? { housing } : {}),
    ...(light !== undefined ? { light } : {}),
    ...(sensingRangeMm !== undefined ? { sensingRangeMm } : {}),
    ...(responseTimeMs !== undefined ? { responseTimeMs } : {}),
    ...(switchingFrequencyHz !== undefined ? { switchingFrequencyHz } : {}),
    ...(supplyVoltageV !== undefined ? { supplyVoltageV } : {}),
    ...(operatingTempC !== undefined ? { operatingTempC } : {}),
    ...(connectorPins !== undefined ? { connectorPins } : {}),
    ...(minIpRating !== undefined ? { minIpRating } : {}),
    ...(ip69k !== undefined ? { ip69k } : {}),
    ...(ioLink !== undefined ? { ioLink } : {}),
  };
}

/** Everything a model turn contributed, after the rule-1 sweep. */
interface Extraction {
  constraints: SpecConstraints;
  questions: ClarifyingQuestion[];
  assumptions: string[];
  notes: string | undefined;
  /** True when at least one model-authored string named a SICK part and was
   *  therefore discarded. Surfaced in `rationale`, never swallowed. */
  violated: boolean;
}

function readExtraction(value: unknown): Extraction {
  const raw = isRecord(value) ? value : {};
  let violated = false;

  /** Accept a model string only if it names no SICK part. */
  const clean = (text: unknown): string | undefined => {
    if (typeof text !== "string") return undefined;
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    if (containsSickPartReference(trimmed)) {
      violated = true;
      return undefined;
    }
    return trimmed;
  };

  const assumptions: string[] = [];
  if (Array.isArray(raw["assumptions"])) {
    for (const entry of raw["assumptions"]) {
      const text = clean(entry);
      if (text !== undefined) assumptions.push(text);
    }
  }

  const questions: ClarifyingQuestion[] = [];
  if (Array.isArray(raw["questions"])) {
    for (const entry of raw["questions"]) {
      if (!isRecord(entry)) continue;
      const field = clean(entry["field"]);
      const question = clean(entry["question"]);
      const why = clean(entry["why"]);
      // A question whose field, prompt or justification had to be discarded is
      // dropped whole — a half-sanitized question would read as if the missing
      // half never existed.
      if (field === undefined || question === undefined || why === undefined) continue;
      const options = Array.isArray(entry["options"])
        ? entry["options"].map(clean).filter((o): o is string => o !== undefined)
        : [];
      questions.push({
        field,
        question,
        why,
        ...(options.length > 0 ? { options } : {}),
      });
    }
  }

  return {
    constraints: toSpecConstraints(raw),
    questions,
    assumptions,
    notes: clean(raw["notes"]),
    violated,
  };
}

// ---------------------------------------------------------------------------
// Drafts — what each input path produces before the gate runs
// ---------------------------------------------------------------------------

interface Draft {
  constraints: SpecConstraints;
  identified: IdentifiedPart | undefined;
  assumptions: string[];
  /** Sentences joined into `ResolvedInput.rationale`. */
  rationale: string[];
  /** Questions that must be asked whatever the gate says — a nameplate that
   *  could not be read, most importantly. Their presence forces `sufficient:
   *  false`, because a constraint set built on a misread identifier is worse
   *  than no constraint set at all. */
  blocking: ClarifyingQuestion[];
  /** Model-authored questions, keyed by field, preferred over the generic
   *  template when the gate decides to ask about that field. */
  suggested: Map<string, ClarifyingQuestion>;
  /** Overrides for the `principle` question's options — the competitor record's
   *  own sensing-mode vocabulary, so the user can answer in the words printed
   *  on their own datasheet. */
  principleOptions: string[] | undefined;
}

function emptyDraft(): Draft {
  return {
    constraints: {},
    identified: undefined,
    assumptions: [],
    rationale: [],
    blocking: [],
    suggested: new Map(),
    principleOptions: undefined,
  };
}

// ---------------------------------------------------------------------------
// Path: part number
// ---------------------------------------------------------------------------

/** Distinct sensing-mode tokens on a competitor record, in file order. */
function modeOptions(match: CompetitorMatch): string[] {
  const seen: string[] = [];
  for (const mode of match.product.sensingModes) {
    const label = mode.variant === undefined ? mode.mode : `${mode.mode} (${mode.variant})`;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen;
}

/**
 * Build a draft from a dataset hit, with no model involved at any point.
 *
 * {@link toConstraints} is a pure function over the extracted Banner row, so the
 * left-hand column of the eventual comparison is a file with a page number
 * behind it. The assumptions it bakes in — "the longest-range variant of this
 * mode", "the family envelope rather than your specific model" — are hoisted out
 * here into `assumptions` so the user can reject them individually.
 */
function fromDatasetHit(match: CompetitorMatch, deps: ResolverDeps): Draft {
  const draft = emptyDraft();
  draft.constraints = toConstraints(match);
  draft.identified = toIdentifiedPart(match);
  draft.principleOptions = modeOptions(match);

  const label = match.product.model ?? match.product.series ?? match.matchedKey;
  draft.rationale.push(
    `Identified "${match.query}" as Banner ${label} in the competitor dataset (${match.kind} match on ` +
      `"${match.matchedKey}", page ${String(match.product.sourcePage)}). Constraints were derived from that ` +
      `record deterministically — no model was asked to recall a spec.`,
  );

  if (match.kind === "series") {
    draft.assumptions.push(
      `"${match.query}" matched the ${label} series card rather than one configured model, so these specs are ` +
        `the family's envelope; your specific variant may be narrower.`,
    );
  }
  if (match.kind === "series-prefix") {
    draft.assumptions.push(
      `Only the leading "${match.matchedKey}" family token of "${match.query}" was recognised. The suffix — output ` +
        `type, connector and range variant — was not understood, and nothing about it is reflected in these constraints.`,
    );
  }
  if (match.alternatives.length > 0) {
    draft.assumptions.push(
      `The dataset holds ${String(match.alternatives.length)} other record${
        match.alternatives.length === 1 ? "" : "s"
      } under "${match.matchedKey}"; the most fully specified one was used.`,
    );
  }
  if (draft.constraints.sensingRangeMm?.min !== undefined) {
    draft.assumptions.push(
      `Assumed you need the longest-range variant of this sensing mode (${String(
        draft.constraints.sensingRangeMm.min,
      )} mm). Say so if yours is shorter — a shorter requirement opens up smaller, cheaper housings.`,
    );
  }
  if (draft.constraints.operatingTempC !== undefined) {
    draft.assumptions.push(
      `Carried Banner's stated operating temperature range across as a requirement. If your cell never sees those ` +
        `extremes, relaxing it will admit candidates that are otherwise a better match.`,
    );
  }
  if (draft.constraints.outputType === undefined) {
    draft.assumptions.push(
      "No output type was constrained: this Banner record lists every output option the series sells, and pinning " +
        "one would invent a configuration you never stated.",
    );
  }

  deps.trace.emit({
    type: "resolver.identified",
    label: `identified ${match.product.vendor} ${label} (dataset)`,
    part: draft.identified,
  });

  return draft;
}

/**
 * Fall back to the model for a competitor part we hold no record of.
 *
 * The result is marked `specSource: "inferred"` and says so in `assumptions`,
 * because everything here came out of a model's recollection of a datasheet it
 * may never have seen. That distinction is the difference between a comparison
 * a customer can act on and one they should verify first.
 */
async function fromUnknownPartNumber(
  partNumber: string,
  vendorHint: string | undefined,
  deps: ResolverDeps,
): Promise<Draft> {
  const draft = emptyDraft();
  const vendorLine = vendorHint === undefined ? "" : ` The user says the vendor is ${vendorHint}.`;
  const extraction = await extract(
    `A user wants to replace this sensor, identified only by part number: ${partNumber}.${vendorLine}\n\n` +
      `We hold no extracted datasheet for it. Emit constraints ONLY for what the identifier itself makes ` +
      `unambiguous — many part numbers encode housing size, sensing mode, output type or connector, and those are ` +
      `fair to read. Do not reconstruct a spec table from memory: a recalled range or response time is ` +
      `indistinguishable downstream from a measured one. Anything you are not certain the identifier encodes ` +
      `belongs in questions, not in constraints.`,
    deps,
  );

  if (extraction === undefined) {
    draft.rationale.push(
      `The model declined to interpret "${partNumber}", so no constraints could be inferred for it.`,
    );
    draft.blocking.push(FALLBACK_QUESTION);
    return draft;
  }

  applyExtraction(draft, extraction);

  const stated = statedFields(draft.constraints);
  const specSource: IdentifiedPart["specSource"] = stated.length > 0 ? "inferred" : "unknown";
  draft.identified = {
    vendor: vendorHint ?? "unknown",
    rawInput: partNumber,
    specSource,
  };
  draft.rationale.push(
    `"${partNumber}" is not in the competitor dataset (which currently covers Banner only), so its constraints were ` +
      `${specSource === "inferred" ? "inferred by the model from the identifier itself" : "not recoverable at all"} ` +
      `rather than read from an extracted datasheet.`,
  );
  if (specSource === "inferred") {
    draft.assumptions.push(
      `Every constraint here was inferred from the part number "${partNumber}", not read from a datasheet we hold. ` +
        `Confirm them before ordering — an inferred spec carries no citation and nothing downstream can check it.`,
    );
  }

  deps.trace.emit({
    type: "resolver.identified",
    label: `unrecognised part "${partNumber}" — specs ${specSource}`,
    part: draft.identified,
  });

  return draft;
}

async function fromPartNumber(
  partNumber: string,
  vendorHint: string | undefined,
  deps: ResolverDeps,
): Promise<Draft> {
  const trimmed = partNumber.trim();
  if (trimmed === "") {
    const draft = emptyDraft();
    draft.rationale.push("An empty part number was supplied; there is nothing to identify.");
    draft.blocking.push(FALLBACK_QUESTION);
    return draft;
  }

  // Dataset first, always. See the module doc for why a model must never be
  // asked to recall a competitor spec we could have looked up.
  const match = deps.competitors.lookup(trimmed);
  if (match !== undefined) return fromDatasetHit(match, deps);

  return fromUnknownPartNumber(trimmed, vendorHint, deps);
}

// ---------------------------------------------------------------------------
// Path: description
// ---------------------------------------------------------------------------

async function fromDescription(text: string, deps: ResolverDeps): Promise<Draft> {
  const draft = emptyDraft();
  const trimmed = text.trim();
  if (trimmed === "") {
    draft.rationale.push("An empty description was supplied.");
    draft.blocking.push(FALLBACK_QUESTION);
    return draft;
  }

  const extraction = await extract(
    `Extract the sensor constraint set from this request. Anything the user did not state stays null.\n\n${trimmed}`,
    deps,
  );

  if (extraction === undefined) {
    draft.rationale.push("The model declined to interpret this description, so no constraints were extracted.");
    draft.blocking.push(FALLBACK_QUESTION);
    return draft;
  }

  applyExtraction(draft, extraction);
  draft.rationale.unshift(
    `Constraints were extracted from free text by the model; ${String(
      statedFields(draft.constraints).length,
    )} constraint field(s) were stated clearly enough to keep.`,
  );
  return draft;
}

// ---------------------------------------------------------------------------
// Path: image
// ---------------------------------------------------------------------------

/**
 * Phrase the "I read X but I am not certain" question from the reading's own
 * ambiguity report.
 *
 * `uncertainCharacters` arrives as `<1-based index>:<candidates>`, so the
 * question can name the exact glyph in doubt — "the 8 in position 4 could be a
 * B" is answerable in two seconds, where "please confirm the part number" makes
 * the user re-read a plate they already photographed because it was hard to read.
 */
function confirmationQuestion(reading: LabelReading): ClarifyingQuestion {
  const partNumber = reading.partNumber;
  const doubts: string[] = [];
  for (const entry of reading.uncertainCharacters) {
    const [indexRaw, candidatesRaw] = entry.split(":");
    const index = Number.parseInt(indexRaw ?? "", 10);
    const candidates = (candidatesRaw ?? "").split("|").filter((c) => c !== "");
    if (!Number.isFinite(index) || candidates.length === 0 || partNumber === undefined) continue;
    const read = partNumber.charAt(index - 1);
    const others = candidates.filter((c) => c !== read);
    if (others.length === 0) continue;
    doubts.push(
      `the "${read === "" ? candidates[0] ?? "?" : read}" in position ${String(index)} could be ${others
        .map((c) => `"${c}"`)
        .join(" or ")}`,
    );
  }

  if (partNumber === undefined) {
    return {
      field: "partNumber",
      question:
        "No part number could be read off this nameplate. What does it say, or what does the sensor have to do?",
      why: "Without an identifier there is nothing to look up and no specs to compare against. Guessing a part number from the housing shape would produce a comparison that looks correct and is not.",
    };
  }

  const uncertainty =
    doubts.length > 0
      ? ` — but ${doubts.join(", and ")}`
      : partNumber.includes("?")
        ? " — but the characters shown as \"?\" could not be read at all"
        : " — but the reading is not certain";

  return {
    field: "partNumber",
    question: `I read "${partNumber}" off the plate${uncertainty}. Can you confirm the exact part number?`,
    why: "A single misread character resolves to a different product, and the comparison built on it looks completely correct — every spec lines up, every citation resolves, and the wrong sensor gets ordered. Confirming costs one message.",
  };
}

async function fromImage(
  input: Extract<AgentInput, { kind: "image" }>,
  deps: ResolverDeps,
): Promise<Draft> {
  const vision = deps.vision;
  if (vision === undefined) {
    throw new Error(
      "resolve() was given an image input but no `vision` client. A nameplate has to be transcribed before it can " +
        "be resolved; there is no honest fallback that skips that step.",
    );
  }

  const reading = await readLabel(
    vision,
    { mediaType: input.mediaType, base64: input.base64 },
    {
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
  );

  const plate =
    reading.otherText.length > 0 ? ` Other text on the plate: ${reading.otherText.join("; ")}.` : "";

  // `legible` is a trust flag, not an image-quality flag — see LabelReading. A
  // reading that required one guess is not an identification, and treating it as
  // one is the single most expensive mistake this pipeline can make.
  if (!reading.legible || reading.partNumber === undefined) {
    const draft = emptyDraft();
    draft.blocking.push(confirmationQuestion(reading));
    draft.rationale.push(
      `The nameplate was transcribed but the part number is not trustworthy (confidence: ${reading.confidence}` +
        `${reading.partNumber === undefined ? ", no part number found" : `, best reading "${reading.partNumber}"`}).` +
        ` No identification was committed to.${plate}`,
    );
    if (reading.vendor !== undefined) {
      draft.identified = {
        vendor: reading.vendor,
        ...(reading.partNumber !== undefined ? { rawInput: reading.partNumber } : {}),
        specSource: "unknown",
      };
      deps.trace.emit({
        type: "resolver.identified",
        label: `nameplate: ${reading.vendor}, part number unconfirmed`,
        part: draft.identified,
      });
    }
    deps.trace.emit({
      type: "tool.result",
      label: "nameplate read — illegible",
      tool: "readLabel",
      summary: `legible=false confidence=${reading.confidence} uncertain=[${reading.uncertainCharacters.join(",")}]`,
    });
    return draft;
  }

  deps.trace.emit({
    type: "tool.result",
    label: `nameplate read — "${reading.partNumber}"`,
    tool: "readLabel",
    summary: `legible=true confidence=${reading.confidence}`,
  });

  // A clean reading is an identifier like any other, so it takes the part-number
  // path — dataset first, model only as a fallback.
  const draft = await fromPartNumber(reading.partNumber, reading.vendor, deps);
  draft.rationale.unshift(
    `Read "${reading.partNumber}" off the nameplate photograph character by character with no ambiguities ` +
      `(confidence: ${reading.confidence}).${plate}`,
  );
  return draft;
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

/**
 * One structured extraction turn.
 *
 * Returns `undefined` on a refusal rather than throwing: a safety classifier
 * declining is an operational fact the run should report and keep going from,
 * exactly like an unreadable nameplate. The caller turns it into a question.
 */
async function extract(userText: string, deps: ResolverDeps): Promise<Extraction | undefined> {
  const result = await deps.client.structured<unknown>({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
    schema: EXTRACTION_SCHEMA,
    effort: RESOLVER_EFFORT,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });

  if (isRefused(result)) {
    deps.trace.emit({
      type: "error",
      label: "resolver · model declined the extraction",
      message: result.reason,
      recoverable: true,
    });
    return undefined;
  }

  return readExtraction(result.value);
}

/** Fold a model turn into the draft, keeping the rule-1 violation visible. */
function applyExtraction(draft: Draft, extraction: Extraction): void {
  draft.constraints = { ...draft.constraints, ...extraction.constraints };
  draft.assumptions.push(...extraction.assumptions);
  for (const question of extraction.questions) {
    if (!draft.suggested.has(question.field)) draft.suggested.set(question.field, question);
  }
  if (extraction.notes !== undefined) draft.rationale.push(extraction.notes);
  if (extraction.violated) {
    draft.rationale.push(
      "Rule 1 violation: the model's output named a SICK part number or type code. The offending text was " +
        "discarded and is not reflected anywhere in this result — an agent may narrow or reject, never select.",
    );
  }
}

// ---------------------------------------------------------------------------
// Assembling the answer
// ---------------------------------------------------------------------------

/** Pick the fields worth asking about, most discriminating first. */
function chooseQuestions(draft: Draft, assessment: SufficiencyAssessment): ClarifyingQuestion[] {
  const stated = new Set(statedFields(draft.constraints));
  const wanted: string[] = [];

  if (!assessment.anchored) wanted.push("principle");
  if (assessment.discriminators.length === 0) {
    for (const field of QUESTION_RANK) {
      if (wanted.length >= MAX_QUESTIONS) break;
      if (!DISCRIMINATING_FIELDS.includes(field)) continue;
      if (stated.has(field)) continue;
      wanted.push(field);
    }
  }

  const out: ClarifyingQuestion[] = [...draft.blocking];
  for (const field of wanted) {
    if (out.some((q) => q.field === field)) continue;
    const suggested = draft.suggested.get(field);
    const question = suggested ?? templateQuestion(field);
    if (field === "principle" && draft.principleOptions !== undefined && draft.principleOptions.length > 0) {
      // The user's own datasheet vocabulary beats ours: they are looking at a
      // Banner series card, not a SICK principle taxonomy.
      out.push({ ...question, options: [...draft.principleOptions] });
    } else {
      out.push(question);
    }
  }

  // Anything the model raised that the gate did not already cover, but only up
  // to the cap — a wall of questions gets none of them answered.
  for (const [field, question] of draft.suggested) {
    if (out.length >= MAX_QUESTIONS) break;
    if (out.some((q) => q.field === field)) continue;
    out.push(question);
  }

  if (out.length === 0) out.push(FALLBACK_QUESTION);
  return [...out].sort(byDiscriminatingPower).slice(0, MAX_QUESTIONS);
}

function finish(draft: Draft, deps: ResolverDeps): ResolvedInput {
  const assessment = assessSufficiency(draft.constraints);
  const blocked = draft.blocking.length > 0;
  const sufficient = assessment.sufficient && !blocked;

  const stated = new Set(statedFields(draft.constraints));
  const missing = TRACKED_FIELDS.filter((field) => !stated.has(field));
  const questions = sufficient ? [] : chooseQuestions(draft, assessment);

  const rationale = [...draft.rationale, assessment.reason];
  if (blocked) {
    rationale.push(
      "Held back regardless of the constraint count: the identifier itself is unconfirmed, and constraints built " +
        "on a misread part number are worse than none.",
    );
  }

  deps.trace.emit({
    type: "resolver.constraints",
    label: `${String(stated.size)} constraint(s), ${String(missing.length)} unspecified`,
    constraints: draft.constraints,
    missing,
  });

  if (questions.length > 0) {
    deps.trace.emit({
      type: "resolver.question",
      label: `needs input — ${String(questions.length)} question(s)`,
      questions,
    });
  }

  return {
    constraints: draft.constraints,
    ...(draft.identified !== undefined ? { identified: draft.identified } : {}),
    missing,
    questions,
    sufficient,
    rationale: rationale.join(" "),
    assumptions: draft.assumptions,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Turn one input into a constraint vector, or into the questions that would
 * make one possible.
 *
 * Check `sufficient` before doing anything with `constraints`. When it is
 * `false` the orchestrator must stop and surface `questions` as a
 * `needs_input` outcome — that is rule 2, and it is the whole reason this module
 * sits in front of retrieval. Proceeding anyway produces a ranked list decided
 * by text similarity and presented with citations, which is the most convincing
 * wrong answer this system can generate.
 *
 * Never throws for a *product* reason. An unreadable nameplate, a part number we
 * do not hold, a model refusal — all come back as `sufficient: false` with
 * questions. It throws only on a wiring error: an `image` input with no `vision`
 * client, or a `bom` / `problem` input, which belong to other entry points.
 *
 * @example
 * ```ts
 * const resolved = await resolve({ kind: "part_number", value: "T18U" }, deps);
 * if (!resolved.sufficient) return { kind: "needs_input", questions: resolved.questions };
 * const hits = await retriever.search(queryFor(resolved), { constraints: resolved.constraints });
 * ```
 */
export async function resolve(input: AgentInput, deps: ResolverDeps): Promise<ResolvedInput> {
  deps.trace.emit({ type: "resolver.start", label: `resolver · reading ${input.kind} input` });

  switch (input.kind) {
    case "part_number":
      return finish(await fromPartNumber(input.value, input.vendorHint, deps), deps);
    case "description":
      return finish(await fromDescription(input.value, deps), deps);
    case "image":
      return finish(await fromImage(input, deps), deps);
    case "bom":
      throw new Error(
        "resolve() does not take a BOM. Parse it with parseBom() and call resolve() once per row — a BOM is many " +
          "independent resolutions, and collapsing them into one constraint set would blend unrelated sensors.",
      );
    case "problem":
      throw new Error(
        "resolve() does not take a problem statement. Consultant mode designs a solution rather than matching a " +
          "part, and routing it through the Resolver would answer a design question with a replacement lookup.",
      );
  }
}
