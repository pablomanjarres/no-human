/**
 * Consultant mode — the second use case.
 *
 * An engineer describes a *problem* ("I need to detect black boxes on a
 * conveyor") and does not know what they need. A search box answers that with a
 * ranked list. A SICK application engineer answers it with two questions and
 * then a complete installation. This module is the second thing.
 *
 * ## Why this file is mostly not prompt
 *
 * Three of the four hard guarantees here are enforced by code, because a prompt
 * cannot enforce anything:
 *
 * 1. **Underspecified input returns questions, not a guess.** The blocking-gap
 *    set ({@link blockingGapsFor}) is computed here, from the model's *evidence*
 *    rather than its self-assessment. A model that claims the user stated a
 *    sensing distance must quote the words that said so, and the quote is
 *    checked against the actual input text. Unsupported claims of coverage are
 *    downgraded to `missing` and traced. This is what stops "confident answer
 *    from thin input", which is the single failure this product exists to avoid.
 * 2. **No part number arrives from memory.** Consultant mode is the one place a
 *    model is allowed to *propose* SICK order numbers — it has to, since there
 *    is no source part to solve against. So every proposed order number is
 *    resolved against the retriever and dropped, loudly and traceably, if the
 *    catalog does not carry it. A model cannot smuggle a plausible-looking
 *    7-digit number into a BOM.
 * 3. **Compatibility is derived, never asserted.** {@link SolutionDesign.compatibility}
 *    is computed from normalized catalog specs in {@link runCompatibilityChecks},
 *    not taken from the model. The catalog prints supply voltage for 41 of 1,776
 *    SKUs, so most electrical checks *must* come back `unverified` — and a model
 *    asked to grade its own BOM will not reliably say so. `unverified` is the
 *    honest answer and this module is built so it is also the easy one.
 *
 * The fourth guarantee, the citation on every BOM line, is structural: the
 * citation is built from the resolved catalog row, so a line cannot exist
 * without a page to check it on.
 *
 * ## Unknown is not pass
 *
 * A compatibility check whose inputs the catalog does not print is `unverified`,
 * never `ok`. Confidence is capped by the code (see {@link capConfidence}) so a
 * design resting on unverified electrical specs cannot present itself as `high`
 * no matter what the model claims about its own work.
 */

import {
  citationFor,
  createCatalogTools,
  type Citation,
  type NormalizedSpec,
  type Retriever,
  type SickProduct,
} from "@no-human/rag";

import { isRefused, RefusalError, type Effort, type LlmClient } from "./claude.js";
import type { Trace, TraceEventInput } from "./trace.js";
import type { ClarifyingQuestion, ConsultOutcome, SolutionDesign } from "./types.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** What the user brings to a consultation. */
export interface ConsultInput {
  /** The problem in the engineer's own words. Never pre-normalized. */
  problem: string;
  /**
   * Answers to a previous run's {@link ClarifyingQuestion}s, keyed by
   * {@link ClarifyingQuestion.field}.
   *
   * A key present here counts as *stated* without any quote-checking: it came
   * back through our own question, so its provenance is the conversation rather
   * than the model's reading of the problem text.
   */
  answers?: Record<string, string>;
}

/** Everything {@link consult} needs from the outside world. */
export interface ConsultDeps {
  client: LlmClient;
  /** The catalog. Used both as the model's toolset and as the code-side
   *  authority that every proposed order number is checked against. */
  retriever: Retriever;
  /** Omit to run untraced. Nothing here depends on the trace existing. */
  trace?: Trace;
  signal?: AbortSignal;
}

/**
 * The standard gaps a SICK application engineer probes before designing.
 *
 * Ordered the way the interview actually goes: what, how far, how fast, where,
 * wired to what, for how much.
 */
export const CONSULT_GAP_FIELDS = [
  "targetObject",
  "targetSurface",
  "sensingDistance",
  "lineSpeed",
  "ambientConditions",
  "mountingSpace",
  "outputType",
  "supplyVoltage",
  "budget",
] as const;

/** One of {@link CONSULT_GAP_FIELDS}. */
export type ConsultGapField = (typeof CONSULT_GAP_FIELDS)[number];

/**
 * Gaps that block a design outright, whatever the sensing principle.
 *
 * Deliberately short. Every field here changes *which part*, not just how
 * confident the answer is: without a target you cannot pick a principle,
 * without a distance you cannot pick a variant, and without an output type you
 * cannot pick an order number — PNP and NPN are different SKUs of the same
 * sensor. Line speed, ambient conditions and budget refine a design; these
 * three decide whether one is possible at all.
 */
export const BLOCKING_GAP_FIELDS: readonly ConsultGapField[] = [
  "targetObject",
  "sensingDistance",
  "outputType",
];

/**
 * `targetSurface` blocks only for photoelectric problems — and there it blocks
 * hard.
 *
 * A diffuse sensor reads reflected light, so matte black (roughly 6 % remission)
 * costs most of its published range, and a transparent target may not trip it at
 * all. Both cases force a different *principle*, not a different variant. For an
 * inductive or capacitive job the surface finish is irrelevant, and asking about
 * it would be the stalling the `why` field exists to disprove.
 */
const SURFACE_CRITICAL_FAMILY = "photoelectric";

/** How the problem is likely to be solved. Decides whether surface blocks. */
type PrincipleFamily =
  | "photoelectric"
  | "proximity"
  | "measurement"
  | "identification"
  | "safety"
  | "other";

const PRINCIPLE_FAMILIES: readonly PrincipleFamily[] = [
  "photoelectric",
  "proximity",
  "measurement",
  "identification",
  "safety",
  "other",
];

/**
 * The effort level for both consultant calls.
 *
 * `high`, same as the Resolver and the Challenger. The triage call decides
 * whether to stop and ask, which is the highest-leverage judgement in this
 * package; the design call has to hold a whole installation in its head at once.
 * Neither is a place to save tokens.
 */
const CONSULT_EFFORT: Effort = "high";

// ---------------------------------------------------------------------------
// Fallback questions
// ---------------------------------------------------------------------------

/** A question the code can ask on its own when the model does not supply one. */
interface GapGuidance {
  question: string;
  /** Why the answer changes the recommendation. Never a restatement of the
   *  question — it has to name the concrete engineering consequence. */
  why: string;
  options?: readonly string[];
}

/**
 * Code-owned fallbacks for every standard gap.
 *
 * These exist so rule 2 survives a lazy model. If the triage call returns no
 * questions at all — or returns questions with an empty `why` — the blocking
 * gate still produces a real interview, because the reason a sensing distance
 * matters is a fact about photoelectrics, not something a model needs to be
 * asked for. The `why` strings are written to be readable by the engineer who
 * has to answer them.
 */
const GAP_GUIDANCE: Readonly<Record<ConsultGapField, GapGuidance>> = {
  targetObject: {
    question: "What exactly is being detected, and what is it made of?",
    why: "Material decides the sensing principle before anything else. Metal at short range is an inductive job; a cardboard box is photoelectric; a liquid through a tank wall is capacitive or ultrasonic. Pick the wrong family and no variant of it will work.",
  },
  targetSurface: {
    question:
      "Is the surface matte black, glossy, transparent, or ordinary matte light-coloured?",
    why: "A diffuse sensor works off reflected light, and matte black returns roughly 6 % of it — most of the published range disappears, and a transparent target may not trip the sensor at all. Either case forces background suppression or a retroreflective/through-beam setup rather than a cheaper diffuse one.",
    options: ["matte black", "glossy / shiny", "transparent", "matte light-coloured", "mixed"],
  },
  sensingDistance: {
    question: "How far is the sensor from the target, and how much does that distance vary?",
    why: "Sensing range is the field that splits a family into variants, and the published figure is for a standard white target — a dark or angled one gets less. Without a distance the only honest output is a family, not an order number.",
  },
  lineSpeed: {
    question: "How fast does the target move past the sensor, and how long is it in the beam?",
    why: "Object dwell time versus response time is what decides whether a detection is seen at all. A 20 mm part at 2 m/s is in the beam for 10 ms, which rules out anything slower than that plus the PLC's own scan.",
  },
  ambientConditions: {
    question:
      "What is the environment — washdown, dust, oil, vibration, direct sunlight, temperature extremes?",
    why: "Environment sets the enclosure rating and housing, which changes the order number and often the family. High-pressure washdown means IP69K and stainless steel; heavy dust favours through-beam over diffuse because a fouled lens loses reflected light long before it loses a direct beam.",
  },
  mountingSpace: {
    question: "How much room is there to mount the sensor, and in what orientation?",
    why: "Housing size and mounting axis decide the family as surely as the sensing principle does. A miniature rectangular housing and an M18 barrel solve the same detection job and do not fit the same bracket, and the bracket is part of the deliverable.",
  },
  outputType: {
    question: "What does the sensor wire into — PNP or NPN inputs, IO-Link, analog, or a relay?",
    why: "PNP and NPN are different order numbers of the same sensor, not a setting. Getting this wrong produces a part that mounts perfectly and never switches the PLC input.",
    options: ["PNP (sourcing)", "NPN (sinking)", "IO-Link", "analog", "relay", "not sure"],
  },
  supplyVoltage: {
    question: "What supply voltage is available at the machine — 24 V DC, or something else?",
    why: "Most of this catalog is 10–30 V DC, but not all of it, and the summary catalog prints supply voltage for only 41 of 1,776 SKUs. Stating the available voltage is what lets the answer say which parts are verified against it and which are not.",
  },
  budget: {
    question: "Is there a price ceiling, or is reliability the priority?",
    why: "It changes the recommendation between a diffuse sensor that is adequate on a good day and a through-beam pair that is immune to the surface entirely. This catalog carries no prices, so the trade-off has to be stated in parts rather than numbers.",
  },
};

// ---------------------------------------------------------------------------
// Model output shapes
// ---------------------------------------------------------------------------

/** One gap as the triage call reports it. */
interface RawGap {
  field?: unknown;
  status?: unknown;
  evidence?: unknown;
  question?: unknown;
  why?: unknown;
  options?: unknown;
}

interface RawTriage {
  understood?: unknown;
  principleFamily?: unknown;
  requirements?: unknown;
  assumptions?: unknown;
  gaps?: unknown;
}

interface RawBomLine {
  role?: unknown;
  orderNumber?: unknown;
  quantity?: unknown;
  why?: unknown;
}

interface RawDesign {
  problem?: unknown;
  requirements?: unknown;
  assumptions?: unknown;
  approach?: unknown;
  alternativesConsidered?: unknown;
  billOfMaterials?: unknown;
  requiredOutputType?: unknown;
  requiredSupplyVoltageV?: unknown;
  requiredSensingDistanceMm?: unknown;
  requiresWashdown?: unknown;
  limitations?: unknown;
  confidence?: unknown;
}

/**
 * Requirements the compatibility checks are run against.
 *
 * Derived from the user's words by the model, then consumed by *code*. Every
 * field is a statement about the **application**, never about a part — which is
 * why a model is allowed to produce it at all. `null` means the user did not
 * state it, and a check that needs it is simply not run rather than run against
 * a default.
 */
export interface DesignRequirements {
  outputType: string | null;
  supplyVoltageV: number | null;
  sensingDistanceMm: number | null;
  washdown: boolean;
}

// ---------------------------------------------------------------------------
// JSON schemas
// ---------------------------------------------------------------------------

const stringArray = { type: "array", items: { type: "string" } } as const;

/**
 * Triage schema.
 *
 * `evidence` is the load-bearing field: a gap may only be reported `stated` if
 * the model can quote the words that state it. That quote is verified against
 * the actual input in {@link isActuallyStated}, which is what turns "the model
 * says it knows the distance" into "the user said the distance".
 */
const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    understood: {
      type: "string",
      description: "The detection problem restated in your own words, in one or two sentences.",
    },
    principleFamily: {
      type: "string",
      enum: PRINCIPLE_FAMILIES,
      description:
        "The sensing family this problem most likely lands in. 'photoelectric' whenever light is used to see the target; 'proximity' for inductive/capacitive/magnetic.",
    },
    requirements: {
      ...stringArray,
      description: "Hard requirements the user actually stated. Do not invent any.",
    },
    assumptions: {
      ...stringArray,
      description: "Things you are assuming that the user did not state, and could reject.",
    },
    gaps: {
      type: "array",
      description: `One entry for EVERY field in this list, in order: ${CONSULT_GAP_FIELDS.join(", ")}.`,
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: CONSULT_GAP_FIELDS },
          status: {
            type: "string",
            enum: ["stated", "missing"],
            description:
              "'stated' ONLY when the user's own words pin this down. If you are inferring it, it is missing.",
          },
          evidence: {
            type: ["string", "null"],
            description:
              "When status is 'stated', the verbatim words from the user's input that state it. Quote, do not paraphrase — a paraphrase is treated as missing. Null when status is 'missing'.",
          },
          question: {
            type: "string",
            description: "The question you would ask to fill this gap. Concrete and answerable.",
          },
          why: {
            type: "string",
            description:
              "How the answer changes the recommendation, in engineering terms. Name the consequence: which principle, which variant, which failure. Never restate the question.",
          },
          options: {
            ...stringArray,
            description: "Suggested answers when the space is small. Empty array otherwise.",
          },
        },
        required: ["field", "status", "evidence", "question", "why", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["understood", "principleFamily", "requirements", "assumptions", "gaps"],
  additionalProperties: false,
};

/**
 * Design schema.
 *
 * The BOM carries **order numbers, not products**. The model names candidates;
 * this module resolves them against the catalog and builds the
 * {@link SickProduct} and {@link Citation} from the row it found. A model cannot
 * describe a part into existence here — at worst it names one that gets dropped.
 */
const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    problem: { type: "string", description: "The problem as you understood it." },
    requirements: { ...stringArray, description: "The requirements this design satisfies." },
    assumptions: {
      ...stringArray,
      description: "Assumptions the user should be able to reject. Be explicit about every one.",
    },
    approach: {
      type: "string",
      description:
        "The sensing approach and why THIS one. Name the principle and the physical reason it suits the target and surface.",
    },
    alternativesConsidered: {
      type: "array",
      description:
        "Approaches you rejected, with the technical reason. At least two. A recommendation with no rejected alternatives reads as a lookup, not engineering judgement.",
      items: {
        type: "object",
        properties: {
          approach: { type: "string" },
          rejectedBecause: { type: "string" },
        },
        required: ["approach", "rejectedBecause"],
        additionalProperties: false,
      },
    },
    billOfMaterials: {
      type: "array",
      description:
        "The complete installation: the sensor PLUS the brackets, cordsets, connectors, reflectors and interfaces it needs. Every order number must be one you actually saw in a tool result.",
      items: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: ["sensor", "accessory", "cable", "connector", "interface", "other"],
          },
          orderNumber: {
            type: "string",
            description:
              "The 7-digit SICK order number exactly as a tool returned it. Never one you remember.",
          },
          quantity: { type: "integer", minimum: 1 },
          why: { type: "string", description: "What this line is for in the installation." },
        },
        required: ["role", "orderNumber", "quantity", "why"],
        additionalProperties: false,
      },
    },
    requiredOutputType: {
      type: ["string", "null"],
      enum: ["PNP", "NPN", "PNP/NPN", "push-pull", "analog", "relay", null],
      description: "The output type the user's PLC needs, if they stated one. Null otherwise.",
    },
    requiredSupplyVoltageV: {
      type: ["number", "null"],
      description: "Supply voltage available at the machine, in volts, if stated. Null otherwise.",
    },
    requiredSensingDistanceMm: {
      type: ["number", "null"],
      description:
        "The distance the sensor must detect at, in millimetres. Convert first: 40 cm is 400.",
    },
    requiresWashdown: {
      type: "boolean",
      description: "True only when the user described high-pressure or chemical washdown.",
    },
    limitations: {
      ...stringArray,
      description:
        "What this design does not cover, and which specs you could not verify from the catalog.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "problem",
    "requirements",
    "assumptions",
    "approach",
    "alternativesConsidered",
    "billOfMaterials",
    "requiredOutputType",
    "requiredSupplyVoltageV",
    "requiredSensingDistanceMm",
    "requiresWashdown",
    "limitations",
    "confidence",
  ],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM = [
  "You are a SICK application engineer taking a sensing problem from a customer. You are not a search box.",
  "",
  "Your only job on this turn is to work out what you do NOT know. Do not name any part, family or order number.",
  "",
  "For every field in the gap list, decide whether the customer's own words pin it down.",
  "- 'stated' requires a verbatim quote from their input. If you are filling it in from experience, it is MISSING.",
  "- Inference is not knowledge. 'A conveyor implies about 2 m/s' is an assumption, not a stated line speed.",
  "",
  "Write each question so the customer can see it is load-bearing. The `why` must name the concrete consequence:",
  "which sensing principle it forces, which variant it selects, or which failure it prevents. 'It would help to know'",
  "is not a reason. 'A diffuse sensor loses most of its range on matte black, which may force background suppression",
  "or a retroreflective setup' is.",
].join("\n");

const DESIGN_SYSTEM = [
  "You are a SICK application engineer designing a complete solution from the catalog you can search with your tools.",
  "",
  "RULES THAT ARE CHECKED IN CODE AFTER YOU ANSWER:",
  "1. Every order number in your bill of materials must be one a tool returned to you on this turn. Order numbers",
  "   you recall from memory are resolved against the catalog and DROPPED — the customer sees the gap, not the guess.",
  "2. Deliver an installation, not a part number. Use list_family to find the brackets, cordsets, connectors and",
  "   reflectors that go with the sensor; they are catalog rows with rowType 'accessory' and they have order numbers.",
  "3. Do not assert a compatibility you cannot source. The compatibility table is computed from the catalog after you",
  "   answer; your job is to choose parts whose specs are actually printed where it matters.",
  "",
  "This is the SICK 2015/2016 SUMMARY catalog. It prints ordering options, not full datasheets: supply voltage appears",
  "for 41 of 1,776 SKUs, response time for 96. A spec the page does not print is unknown, never satisfied. Say so in",
  "`limitations` rather than implying coverage you do not have.",
  "",
  "Investigate first, then write your findings as plain notes: the shortlist you considered, the order numbers and page",
  "codes you found, and the approaches you rejected and why. Those notes are the only thing carried into the final answer.",
].join("\n");

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed non-empty string, or `undefined`. Blank strings are absent. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = text(item);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold text for quote matching: lowercase, and every run of non-alphanumerics
 * becomes one space.
 *
 * Deliberately forgiving about punctuation and spacing and nothing else. The
 * check has to survive a model quoting `"40 cm"` when the user typed `"40cm,"`,
 * while still failing when the model quotes words the user never wrote. Stemming
 * or fuzzy matching here would defeat the purpose — a near-miss quote means the
 * model is paraphrasing its own inference back at us.
 */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// The gap gate
// ---------------------------------------------------------------------------

/** One gap after code-side verification. */
interface Gap {
  field: ConsultGapField;
  stated: boolean;
  question: string;
  why: string;
  options: string[];
  /** Set when the model claimed `stated` but its quote is not in the input. */
  downgradedFrom?: string;
}

function isGapField(value: unknown): value is ConsultGapField {
  return typeof value === "string" && (CONSULT_GAP_FIELDS as readonly string[]).includes(value);
}

/**
 * Is this gap genuinely covered by what the user gave us?
 *
 * Two ways to be true, and neither is the model's opinion:
 *
 * - the field came back through one of our own questions (`answers[field]`), or
 * - the model quoted words that actually appear in the problem text.
 *
 * Everything else is `missing`. That includes the common and dangerous case of
 * a model quoting a plausible paraphrase of its own assumption — which reads
 * exactly like real evidence in a log, and is the reason this check compares
 * against the input rather than trusting the `status` field.
 */
function isActuallyStated(gap: RawGap, haystack: string, answered: ReadonlySet<string>): boolean {
  const field = gap.field;
  if (typeof field === "string" && answered.has(field)) return true;
  if (gap.status !== "stated") return false;
  const evidence = text(gap.evidence);
  if (evidence === undefined) return false;
  const folded = fold(evidence);
  if (folded === "") return false;
  return haystack.includes(folded);
}

/** Build the question for a field, preferring the model's wording and falling
 *  back to {@link GAP_GUIDANCE} whenever the model left it thin. */
function questionFor(field: ConsultGapField, gap: RawGap | undefined): ClarifyingQuestion {
  const fallback = GAP_GUIDANCE[field];
  const question = text(gap?.question) ?? fallback.question;
  const why = text(gap?.why) ?? fallback.why;
  const modelOptions = textList(gap?.options);
  const options = modelOptions.length > 0 ? modelOptions : [...(fallback.options ?? [])];
  return {
    field,
    question,
    why,
    ...(options.length > 0 ? { options } : {}),
  };
}

/**
 * Which gaps block a design for this problem.
 *
 * {@link BLOCKING_GAP_FIELDS} always, plus `targetSurface` when the problem is
 * photoelectric — see {@link SURFACE_CRITICAL_FAMILY} for why that one is
 * conditional rather than universal.
 */
export function blockingGapsFor(principleFamily: string): ConsultGapField[] {
  const blocking = [...BLOCKING_GAP_FIELDS];
  if (principleFamily === SURFACE_CRITICAL_FAMILY) blocking.push("targetSurface");
  return blocking;
}

// ---------------------------------------------------------------------------
// BOM resolution
// ---------------------------------------------------------------------------

/** What a bill-of-materials line is for. Mirrors {@link SolutionDesign}. */
export type BomRole = SolutionDesign["billOfMaterials"][number]["role"];

const BOM_ROLES: readonly BomRole[] = [
  "sensor",
  "accessory",
  "cable",
  "connector",
  "interface",
  "other",
];

/**
 * A bill-of-materials line that survived resolution against the catalog.
 *
 * Carries the normalized spec alongside the row because the compatibility
 * checks run off `spec`, and re-normalizing per check would be both slower and
 * a second place for the two to disagree.
 */
export interface ResolvedLine {
  role: BomRole;
  product: SickProduct;
  spec: NormalizedSpec;
  quantity: number;
  why: string;
  citation: Citation;
}

function readRole(value: unknown): BomRole {
  return BOM_ROLES.find((r) => r === value) ?? "other";
}

/** Quantities are counts of physical parts: at least one, whole numbers only. */
function readQuantity(value: unknown): number {
  const n = finite(value);
  if (n === undefined || n < 1) return 1;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/** `unverified` is a first-class status, not an error — see {@link runCompatibilityChecks}. */
export type CheckStatus = "ok" | "warning" | "unverified";

/** One row of {@link SolutionDesign.compatibility}. */
export type CompatibilityCheck = SolutionDesign["compatibility"][number];

function check(name: string, status: CheckStatus, detail: string): CompatibilityCheck {
  return { check: name, status, detail };
}

/** The standing sentence appended to every `unverified` electrical check. */
const SILENT_CATALOG =
  "The summary catalog does not print this spec for the parts involved, so it cannot be checked from this source — verify against the full datasheet before ordering.";

/**
 * Derive the compatibility table from the catalog, not from the model.
 *
 * Every check is one of three things and never anything else:
 *
 * - `ok` — the catalog prints both sides and they agree.
 * - `warning` — the catalog prints both sides and they disagree. This is the
 *   only status that can be produced by evidence of a problem.
 * - `unverified` — the catalog is silent about at least one side. **Not a pass.**
 *   With supply voltage printed for 41 of 1,776 SKUs, this will be the majority
 *   verdict, and that is the honest outcome rather than a defect of the check.
 *
 * The asymmetry matters: nothing here can turn silence into agreement. A model
 * asked to grade its own BOM produces `ok` for specs nobody printed, which is
 * the exact laundering of `unknown` into `pass` this codebase is built to
 * prevent — hence this function taking no model input at all.
 */
export function runCompatibilityChecks(
  lines: readonly ResolvedLine[],
  requirements: DesignRequirements,
): CompatibilityCheck[] {
  const checks: CompatibilityCheck[] = [];
  const sensors = lines.filter((l) => l.role === "sensor");
  const cordsets = lines.filter((l) => l.role === "cable" || l.role === "connector");
  const accessories = lines.filter((l) => l.role !== "sensor");

  // -- Sensing range -------------------------------------------------------
  const required = requirements.sensingDistanceMm;
  if (required !== null) {
    for (const sensor of sensors) {
      const max = sensor.spec.sensingRangeMaxMm;
      const label = `Sensing range covers ${String(required)} mm (${sensor.product.orderNumber})`;
      if (max === undefined) {
        checks.push(
          check(
            label,
            "unverified",
            `The catalog does not print a maximum sensing range for ${sensor.product.orderNumber} on page ${sensor.product.sourcePage}. ${SILENT_CATALOG}`,
          ),
        );
      } else if (max >= required) {
        checks.push(
          check(
            label,
            "ok",
            `Printed maximum is ${String(max)} mm against a required ${String(required)} mm (page ${sensor.product.sourcePage}). Note the printed figure assumes a standard white target; a dark or angled one returns less.`,
          ),
        );
      } else {
        checks.push(
          check(
            label,
            "warning",
            `Printed maximum is ${String(max)} mm, short of the required ${String(required)} mm (page ${sensor.product.sourcePage}).`,
          ),
        );
      }
    }
  }

  // -- Output type vs the PLC input ---------------------------------------
  const wanted = requirements.outputType;
  if (wanted !== null) {
    for (const sensor of sensors) {
      const actual = sensor.spec.outputType;
      const label = `Output type matches the stated PLC input (${sensor.product.orderNumber})`;
      if (actual === undefined || actual === "unknown") {
        checks.push(
          check(
            label,
            "unverified",
            `The catalog does not state a switching output type for ${sensor.product.orderNumber}. ${SILENT_CATALOG} PNP and NPN are different order numbers, so this one must be confirmed before ordering.`,
          ),
        );
      } else if (actual === wanted || actual === "PNP/NPN" || wanted === "PNP/NPN") {
        checks.push(
          check(
            label,
            "ok",
            `Catalog states ${actual} against a required ${wanted} (page ${sensor.product.sourcePage}).`,
          ),
        );
      } else {
        checks.push(
          check(
            label,
            "warning",
            `Catalog states ${actual}, but the application needs ${wanted} (page ${sensor.product.sourcePage}). This is a different order number, not a setting.`,
          ),
        );
      }
    }
  }

  // -- Supply voltage ------------------------------------------------------
  const volts = requirements.supplyVoltageV;
  if (volts !== null) {
    const stated = lines.filter(
      (l) => l.spec.supplyVoltageMinV !== undefined || l.spec.supplyVoltageMaxV !== undefined,
    );
    if (stated.length === 0) {
      checks.push(
        check(
          `Supply voltage consistent at ${String(volts)} V`,
          "unverified",
          `No part in this bill of materials prints a supply voltage range. ${SILENT_CATALOG} The catalog states supply voltage for 41 of its 1,776 SKUs.`,
        ),
      );
    } else {
      for (const line of stated) {
        const min = line.spec.supplyVoltageMinV;
        const max = line.spec.supplyVoltageMaxV;
        const inRange = (min === undefined || volts >= min) && (max === undefined || volts <= max);
        const window = `${min === undefined ? "?" : String(min)}–${max === undefined ? "?" : String(max)} V`;
        checks.push(
          check(
            `Supply voltage ${String(volts)} V within range (${line.product.orderNumber})`,
            inRange ? "ok" : "warning",
            `Catalog states ${window} on page ${line.product.sourcePage}.`,
          ),
        );
      }
    }
  }

  // -- Connector: cordset against sensor -----------------------------------
  for (const sensor of sensors) {
    const sensorConnector = sensor.spec.connector;
    for (const cordset of cordsets) {
      const label = `Connector matches (${sensor.product.orderNumber} ↔ ${cordset.product.orderNumber})`;
      const cordsetConnector = cordset.spec.connector;
      if (
        sensorConnector === undefined ||
        sensorConnector === "unknown" ||
        cordsetConnector === undefined ||
        cordsetConnector === "unknown"
      ) {
        checks.push(
          check(
            label,
            "unverified",
            `The catalog does not print a connection type for ${sensorConnector === undefined || sensorConnector === "unknown" ? sensor.product.orderNumber : cordset.product.orderNumber}. ${SILENT_CATALOG}`,
          ),
        );
      } else if (sensorConnector === cordsetConnector) {
        checks.push(
          check(
            label,
            "ok",
            `Both state ${sensorConnector} (pages ${sensor.product.sourcePage} and ${cordset.product.sourcePage}). Pin count and gender are not always printed — confirm those.`,
          ),
        );
      } else {
        checks.push(
          check(
            label,
            "warning",
            `Sensor states ${sensorConnector}, cordset states ${cordsetConnector} (pages ${sensor.product.sourcePage} and ${cordset.product.sourcePage}).`,
          ),
        );
      }
    }
    if (cordsets.length === 0 && sensorConnector !== undefined && sensorConnector !== "cable") {
      checks.push(
        check(
          `Cordset specified for the ${sensorConnector} connection (${sensor.product.orderNumber})`,
          "warning",
          `${sensor.product.orderNumber} is a ${sensorConnector} plug-connector variant, and no cordset is included in this bill of materials. It will not wire up as delivered.`,
        ),
      );
    }
  }

  // -- Washdown ------------------------------------------------------------
  if (requirements.washdown) {
    for (const sensor of sensors) {
      const label = `Enclosure suits washdown (${sensor.product.orderNumber})`;
      const ip = sensor.spec.ipRating;
      if (ip === undefined) {
        checks.push(
          check(
            label,
            "unverified",
            `The catalog does not print an enclosure rating for ${sensor.product.orderNumber}. ${SILENT_CATALOG}`,
          ),
        );
      } else if (sensor.spec.ip69k === true) {
        checks.push(
          check(label, "ok", `Catalog states IP69K on page ${sensor.product.sourcePage}.`),
        );
      } else {
        checks.push(
          check(
            label,
            "warning",
            `Catalog states IP${String(ip)} on page ${sensor.product.sourcePage}. High-pressure washdown needs an explicit IP69K rating; IP67 or IP68 does not cover it.`,
          ),
        );
      }
    }
  }

  // -- Accessory fitment ---------------------------------------------------
  if (accessories.length > 0) {
    checks.push(
      check(
        "Accessory fitment against the chosen sensor variant",
        "unverified",
        `The catalog lists accessories under a family without stating which variant each one fits. ${accessories.length} accessory line(s) here are sourced from the right family pages, but the fit itself is not printed and must be confirmed.`,
      ),
    );
  }

  return checks;
}

/**
 * Cap the model's self-reported confidence with what the checks actually found.
 *
 * A model that has just designed something reports on its own work, and reports
 * well. The cap is what makes the number mean something: any `warning` drops the
 * design to `low`, and any `unverified` check — or any part dropped for not
 * existing — holds it at `medium` at best. `high` therefore requires an
 * installation whose every check the printed catalog could actually answer,
 * which is rare in a summary catalog and should be.
 */
export function capConfidence(
  claimed: SolutionDesign["confidence"],
  checks: readonly CompatibilityCheck[],
  droppedCount: number,
): SolutionDesign["confidence"] {
  const rank: Record<SolutionDesign["confidence"], number> = { low: 0, medium: 1, high: 2 };
  // No checks at all is NOT a clean bill of health — it means every guard was
  // skipped because the requirement it needed was never established (no stated
  // distance, no output type, no supply voltage, no washdown) or the catalog
  // prints no connection for the part (695 of 1,776 rows print none). An empty
  // table rendered under "Confidence: high" is the worst read on the page: zero
  // verification presented as maximum certainty. Same rule the migration side
  // enforces in `confidenceFor` — nothing verified, nothing to be confident about.
  if (checks.length === 0) return "low";
  const cap: SolutionDesign["confidence"] = checks.some((c) => c.status === "warning")
    ? "low"
    : checks.some((c) => c.status === "unverified") || droppedCount > 0
      ? "medium"
      : "high";
  return rank[claimed] <= rank[cap] ? claimed : cap;
}

// ---------------------------------------------------------------------------
// consult
// ---------------------------------------------------------------------------

/**
 * Run a consultation: triage the problem, ask if anything load-bearing is
 * missing, otherwise design a complete installation from the catalog.
 *
 * Returns `{ kind: "needs_input", questions }` in two situations, and both are
 * successful runs rather than errors:
 *
 * - the problem does not pin down a blocking gap, so designing would mean
 *   guessing; or
 * - the design came back with no sensor that exists in this catalog, in which
 *   case the honest move is to say what could not be found and ask for the one
 *   thing that would widen the search.
 *
 * Throws {@link RefusalError} when the model declines — a refusal is a
 * reportable outcome elsewhere in this package, but {@link ConsultOutcome} has
 * no branch for "we never got an answer", and inventing a question the user
 * cannot usefully answer would be worse than propagating.
 *
 * @example
 * ```ts
 * const out = await consult({ problem: "count transparent bottles" }, { client, retriever });
 * if (out.kind === "needs_input") for (const q of out.questions) console.log(q.question, "—", q.why);
 * ```
 */
export async function consult(input: ConsultInput, deps: ConsultDeps): Promise<ConsultOutcome> {
  const emit = (event: TraceEventInput): void => {
    deps.trace?.emit(event);
  };
  const signalOpts = deps.signal !== undefined ? { signal: deps.signal } : {};

  const problem = text(input.problem) ?? "";
  const answers = input.answers ?? {};
  const answered = new Set(
    Object.keys(answers).filter((key) => text(answers[key]) !== undefined),
  );

  emit({ type: "run.start", label: "consultant · problem in the engineer's words", input: "problem" });

  if (problem === "") {
    // Nothing to triage. Ask the whole standard interview rather than calling a
    // model to discover that an empty string is underspecified.
    const questions = blockingGapsFor("photoelectric").map((field) => questionFor(field, undefined));
    emit({ type: "resolver.question", label: "no problem statement — asking the standard set", questions });
    emit({ type: "report.ready", label: "needs input", outcome: "needs_input" });
    return { kind: "needs_input", questions };
  }

  // -- 1. Triage -----------------------------------------------------------
  emit({ type: "resolver.start", label: "consultant · what do I not know yet" });

  const answerLines = [...answered].map((key) => `- ${key}: ${String(answers[key]).trim()}`);
  const triageMessage = [
    "PROBLEM (verbatim):",
    problem,
    ...(answerLines.length > 0
      ? ["", "ANSWERS ALREADY GIVEN (these count as stated):", ...answerLines]
      : []),
  ].join("\n");

  const triageCall = await deps.client.structured<RawTriage>({
    system: TRIAGE_SYSTEM,
    messages: [{ role: "user", content: triageMessage }],
    schema: TRIAGE_SCHEMA,
    effort: CONSULT_EFFORT,
    ...signalOpts,
  });

  if (isRefused(triageCall)) {
    emit({ type: "error", label: "the model declined to triage this problem", message: triageCall.reason, recoverable: false });
    throw RefusalError.from(triageCall);
  }

  const triage = isRecord(triageCall.value) ? (triageCall.value as RawTriage) : {};
  const principleFamily =
    PRINCIPLE_FAMILIES.find((f) => f === triage.principleFamily) ?? "photoelectric";

  // The haystack every `stated` claim is checked against: the problem plus the
  // answers, folded. Nothing else — a claim can only be evidenced by what the
  // user actually put in front of us.
  const haystack = fold([problem, ...[...answered].map((k) => String(answers[k]))].join(" \n "));

  const rawGaps: RawGap[] = Array.isArray(triage.gaps)
    ? triage.gaps.filter((g): g is RawGap => isRecord(g))
    : [];
  const byField = new Map<ConsultGapField, RawGap>();
  for (const raw of rawGaps) {
    if (!isGapField(raw.field) || byField.has(raw.field)) continue;
    byField.set(raw.field, raw);
  }

  const gaps: Gap[] = CONSULT_GAP_FIELDS.map((field) => {
    const raw = byField.get(field);
    const claimed = raw?.status === "stated";
    const stated = raw !== undefined && isActuallyStated(raw, haystack, answered);
    const question = questionFor(field, raw);
    return {
      field,
      stated,
      question: question.question,
      why: question.why,
      options: question.options ?? [],
      ...(claimed && !stated ? { downgradedFrom: text(raw?.evidence) ?? "(no quote given)" } : {}),
    };
  });

  for (const gap of gaps) {
    if (gap.downgradedFrom === undefined) continue;
    // A model claiming coverage it cannot quote is the failure mode that turns
    // thin input into a confident answer. It is recoverable — we just ask — but
    // it must be visible, because it is evidence about the model, not the user.
    emit({
      type: "error",
      label: `unsupported claim that ${gap.field} was stated`,
      message: `The model reported ${gap.field} as stated, quoting "${gap.downgradedFrom}", but those words are not in the problem or the answers. Treating it as missing.`,
      recoverable: true,
    });
  }

  const blocking = blockingGapsFor(principleFamily);
  const missing = gaps.filter((g) => blocking.includes(g.field) && !g.stated);

  if (missing.length > 0) {
    const questions: ClarifyingQuestion[] = missing.map((gap) => ({
      field: gap.field,
      question: gap.question,
      why: gap.why,
      ...(gap.options.length > 0 ? { options: gap.options } : {}),
    }));
    emit({
      type: "resolver.question",
      label: `${String(questions.length)} blocking gap(s) — asking instead of guessing`,
      questions,
    });
    emit({ type: "report.ready", label: "needs input", outcome: "needs_input" });
    return { kind: "needs_input", questions };
  }

  // -- 2. Investigate the catalog -----------------------------------------
  const stated = gaps.filter((g) => g.stated).map((g) => g.field);
  const unstated = gaps.filter((g) => !g.stated).map((g) => g.field);
  const understood = text(triage.understood) ?? problem;

  const investigationBrief = [
    "PROBLEM (verbatim):",
    problem,
    ...(answerLines.length > 0 ? ["", "ANSWERS GIVEN:", ...answerLines] : []),
    "",
    `AS UNDERSTOOD: ${understood}`,
    `LIKELY FAMILY: ${principleFamily}`,
    ...(triage.requirements !== undefined
      ? ["", "STATED REQUIREMENTS:", ...textList(triage.requirements).map((r) => `- ${r}`)]
      : []),
    "",
    `PINNED DOWN BY THE CUSTOMER: ${stated.length > 0 ? stated.join(", ") : "(none)"}`,
    `NOT STATED — assume nothing, and list what you assumed: ${unstated.length > 0 ? unstated.join(", ") : "(none)"}`,
    "",
    "Search the catalog now. Shortlist sensors, then use list_family to pull the brackets, cordsets, connectors and",
    "reflectors those sensors need. Finish with notes naming every order number and page code you would use, and the",
    "approaches you rejected and why.",
  ].join("\n");

  emit({ type: "retrieval.start", label: "consultant · investigating the catalog", query: understood });

  const tools = createCatalogTools(deps.retriever);
  const investigation = await deps.client.withTools({
    system: DESIGN_SYSTEM,
    messages: [{ role: "user", content: investigationBrief }],
    tools,
    effort: CONSULT_EFFORT,
    onToolCall: (event) => {
      emit({ type: "tool.call", label: `${event.name}`, tool: event.name, input: event.input });
    },
    onToolResult: (event) => {
      emit({
        type: "tool.result",
        label: `${event.name}${event.isError ? " (error)" : ""}`,
        tool: event.name,
        summary: event.summary,
      });
    },
    ...signalOpts,
  });

  if (isRefused(investigation)) {
    emit({ type: "error", label: "the model declined to design a solution", message: investigation.reason, recoverable: false });
    throw RefusalError.from(investigation);
  }

  // Deliberately no `retrieval.results` event here. The investigation's searches
  // happen inside the tool loop, so this module never sees which lanes actually
  // ran — and a `lanes` payload guessed from configuration would put a claim on
  // the trace panel that nothing in this run observed. The `tool.call` /
  // `tool.result` pairs above are the truthful record of what was retrieved.

  // -- 3. Write the design -------------------------------------------------
  const designCall = await deps.client.structured<RawDesign>({
    system: DESIGN_SYSTEM,
    messages: [
      { role: "user", content: investigationBrief },
      {
        role: "user",
        content: [
          "Your investigation notes:",
          investigation.text === "" ? "(the investigation produced no notes)" : investigation.text,
          "",
          "Now write the design. Every order number must appear in your notes above; anything else is dropped.",
        ].join("\n"),
      },
    ],
    schema: DESIGN_SCHEMA,
    effort: CONSULT_EFFORT,
    ...signalOpts,
  });

  if (isRefused(designCall)) {
    emit({ type: "error", label: "the model declined to write the design", message: designCall.reason, recoverable: false });
    throw RefusalError.from(designCall);
  }

  const design = isRecord(designCall.value) ? (designCall.value as RawDesign) : {};

  // -- 4. Resolve every proposed order number against the catalog ----------
  const rawLines: RawBomLine[] = Array.isArray(design.billOfMaterials)
    ? design.billOfMaterials.filter((l): l is RawBomLine => isRecord(l))
    : [];

  const lines: ResolvedLine[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawLines) {
    const orderNumber = text(raw.orderNumber);
    if (orderNumber === undefined) {
      dropped.push("(a bill-of-materials line with no order number)");
      emit({
        type: "error",
        label: "dropped a bill-of-materials line with no order number",
        message: "A proposed line carried no order number, so there is nothing to verify it against.",
        recoverable: true,
      });
      continue;
    }
    if (seen.has(orderNumber)) continue;
    seen.add(orderNumber);

    const hit = deps.retriever.getProduct(orderNumber);
    if (hit === undefined) {
      // The whole point of this loop. A 7-digit number the model produced that
      // this catalog does not carry is indistinguishable from a real one on the
      // page, so it is removed here and the removal is on the record.
      dropped.push(orderNumber);
      emit({
        type: "error",
        label: `dropped ${orderNumber} — not in this catalog`,
        message: `The model proposed order number ${orderNumber}, which the loaded SICK catalog index does not contain. It was removed from the bill of materials rather than presented as orderable.`,
        recoverable: true,
      });
      continue;
    }

    // The catalog decides what a row *is*. A model labelling an accessory row as
    // the sensor would otherwise let the BOM claim a sensor it does not have.
    const proposedRole = readRole(raw.role);
    const role: BomRole =
      hit.product.rowType === "accessory" && proposedRole === "sensor" ? "accessory" : proposedRole;

    lines.push({
      role,
      product: hit.product,
      spec: hit.spec,
      quantity: readQuantity(raw.quantity),
      why: text(raw.why) ?? "No purpose was stated for this line.",
      citation: citationFor(hit.product),
    });
  }

  const sensors = lines.filter((l) => l.role === "sensor");
  if (sensors.length === 0) {
    // Not a design. Rather than ship a bill of materials with no sensor in it,
    // say what happened and ask the one question that would widen the search.
    const questions: ClarifyingQuestion[] = [
      {
        field: "targetObject",
        question:
          "Which of the requirements can be relaxed — the sensing distance, the surface, the output type, or the environment?",
        why:
          dropped.length > 0
            ? `The parts proposed for this problem (${dropped.join(", ")}) are not in the loaded SICK 2015/2016 catalog, so there is no sourced sensor to build a solution around. Relaxing one requirement widens the search to parts this catalog actually prints.`
            : "No sensor in the loaded SICK 2015/2016 catalog was sourced for this combination of requirements. Relaxing one of them is what makes a sourced answer possible; guessing at a part would not.",
      },
    ];
    emit({
      type: "error",
      label: "no sourced sensor survived — refusing to ship a bill of materials without one",
      message: `Every proposed sensor was dropped (${dropped.length > 0 ? dropped.join(", ") : "none proposed"}).`,
      recoverable: true,
    });
    emit({ type: "resolver.question", label: "asking which requirement can be relaxed", questions });
    emit({ type: "report.ready", label: "needs input", outcome: "needs_input" });
    return { kind: "needs_input", questions };
  }

  // -- 5. Check the design against the catalog -----------------------------
  const outputType = text(design.requiredOutputType);
  const requirements: DesignRequirements = {
    outputType: outputType ?? null,
    supplyVoltageV: finite(design.requiredSupplyVoltageV) ?? null,
    sensingDistanceMm: finite(design.requiredSensingDistanceMm) ?? null,
    washdown: design.requiresWashdown === true,
  };
  const compatibility = runCompatibilityChecks(lines, requirements);

  const alternatives = (
    Array.isArray(design.alternativesConsidered) ? design.alternativesConsidered : []
  )
    .filter(isRecord)
    .map((a) => ({
      approach: text(a["approach"]) ?? "(unnamed approach)",
      rejectedBecause: text(a["rejectedBecause"]) ?? "(no reason recorded)",
    }))
    .filter((a) => a.approach !== "(unnamed approach)");

  const limitations = textList(design.limitations);
  if (dropped.length > 0) {
    limitations.push(
      `${String(dropped.length)} proposed part(s) were dropped because the loaded catalog does not carry them: ${dropped.join(", ")}. They are absent from this bill of materials, not substituted.`,
    );
  }
  if (lines.every((l) => l.role === "sensor")) {
    limitations.push(
      "No mounting bracket or cordset was sourced from the catalog, so this is a sensor selection rather than a complete installation.",
    );
  }
  if (alternatives.length === 0) {
    limitations.push(
      "No rejected alternatives were recorded, so this recommendation has not been shown to be better than the approaches it displaced.",
    );
  }
  // Every refining gap the customer did not pin down becomes a stated limitation
  // rather than a silent assumption. These are the fields that passed the
  // blocking gate — they do not stop a design, but the design is weaker for
  // them, and the reader is entitled to see which ones.
  for (const field of unstated) {
    limitations.push(`${field} was not stated; the design assumes a typical case for it.`);
  }

  const unverifiedCount = compatibility.filter((c) => c.status === "unverified").length;
  if (unverifiedCount > 0) {
    limitations.push(
      `${String(unverifiedCount)} compatibility check(s) could not be performed because the summary catalog does not print the specs they need. Unverified is not a pass.`,
    );
  }

  const claimed: SolutionDesign["confidence"] =
    design.confidence === "high" || design.confidence === "medium" ? design.confidence : "low";

  const solution: SolutionDesign = {
    problem: text(design.problem) ?? understood,
    requirements: textList(design.requirements),
    assumptions: textList(design.assumptions),
    approach: text(design.approach) ?? "No approach was recorded.",
    alternativesConsidered: alternatives,
    billOfMaterials: lines.map((l) => ({
      role: l.role,
      product: l.product,
      quantity: l.quantity,
      why: l.why,
      citation: l.citation,
    })),
    compatibility,
    limitations,
    confidence: capConfidence(claimed, compatibility, dropped.length),
  };

  emit({
    type: "report.ready",
    label: `design ready · ${String(solution.billOfMaterials.length)} part(s), ${String(unverifiedCount)} unverified check(s)`,
    outcome: "recommendation",
  });

  return { kind: "solution", design: solution };
}
