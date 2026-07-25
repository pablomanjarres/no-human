/**
 * The Challenger — adversarial validation of one proposed match.
 *
 * Everything upstream of this module is trying to *find* a part. This module is
 * the only thing in the system trying to make sure the part it found is wrong.
 * That asymmetry is deliberate: retrieval optimizes for plausibility, the solver
 * optimizes for what the catalog prints, and neither of them has any way to
 * notice that the replacement needs a different bracket, arrives with a cable
 * where the machine has a plug, or reaches the target with no margin left for a
 * dirty lens. Somebody has to argue the other side, so this module does, on
 * purpose, every time.
 *
 * ## Two sources of challenge, and only one of them is a model
 *
 * 1. **Deterministic seeds** ({@link seedChallenges}) are derived straight from
 *    the {@link SolveResult} before any network call happens. Every `unknown`
 *    verdict becomes an `unverifiable` challenge — the catalog is silent, so the
 *    requirement stands unverified — and every `fail` becomes an automatically
 *    `upheld` `fatal`. These exist whether or not the model is reachable, which
 *    is what makes a total model failure a *degraded* report rather than a
 *    missing one.
 * 2. **Model-generated** challenges cover what a spec table cannot express:
 *    mounting, environment, beam geometry, alignment tolerance, wiring.
 *
 * ## The model does not get the last word on facts we hold
 *
 * Every model challenge that rests on a specific spec value is checked against
 * the actual catalog record ({@link lookupFact}). A value that contradicts the
 * record downgrades the challenge to `refuted`. A value the catalog is *silent*
 * on downgrades an `upheld` challenge to `unverifiable` — upholding a fatal
 * objection on a number no page prints would be asserting a spec without a
 * source, which rule 3 of `types.ts` forbids just as loudly as it forbids
 * asserting a match without one. Both downgrades say so in `evidence`, so the
 * user sees the correction rather than a quietly edited verdict.
 *
 * ## Unknown is never pass
 *
 * The SICK data is the *summary* catalog: 41 of 1,776 SKUs state a supply
 * voltage. An `unknown` verdict is therefore the common case, not an edge case,
 * and the single most damaging bug available here is letting one read as a
 * `pass`. Seeds render it as an explicit `unverifiable` challenge with a citation
 * to the page whose silence you can go and check yourself. Note what that means
 * for {@link ChallengeReport.survives}: it is `no upheld challenge of severity
 * "fatal"`, so a report can survive while carrying a dozen unverified
 * requirements. Survival is "nothing printed contradicts this", never "verified".
 *
 * ## Never throws
 *
 * A refusal, a transport failure, a malformed model response and an aborted run
 * all land in the same place: the deterministic report, with the degradation
 * stated in {@link ChallengeReport.summary}. A challenger that throws takes down
 * a run that had already found the right part.
 */

import type { NormalizedSpec, SickProduct, SolveResult } from "@no-human/rag";
import { citationFor, describeSpecs } from "@no-human/rag";

import type { LlmClient } from "./claude.js";
import { isRefused } from "./claude.js";
import type { Trace } from "./trace.js";
import type {
  Challenge,
  ChallengeReport,
  ChallengeSeverity,
  IdentifiedPart,
  ResolvedInput,
} from "./types.js";
import { CHALLENGER_EFFORT } from "./types.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One candidate to attack: the catalog row plus the solver's scoring of it.
 *
 * Both halves are required even though {@link SolveResult} carries its own
 * `product`. `product` is the identity the report is filed under; `solve.spec`
 * is the normalized projection the fact-check reads. Keeping them as separate
 * inputs means a caller that solved against a different row than it thinks it
 * did gets a mismatched report it can see, rather than a silently reassigned one.
 */
export interface ChallengeCandidate {
  product: SickProduct;
  solve: SolveResult;
}

/**
 * What the run knows about the requirement, for the model's benefit only.
 *
 * The Challenger never re-derives constraints from this — the solver already
 * did, deterministically. This is context so the model can raise objections that
 * depend on the *application* ("a 1.2 m through-beam over a vibrating conveyor")
 * rather than on the spec table alone.
 */
export interface ChallengeContext {
  resolved: ResolvedInput;
  identified?: IdentifiedPart;
}

/** Injected collaborators. `client` is an interface so tests never hit the API. */
export interface ChallengeDeps {
  client: LlmClient;
  trace: Trace;
  signal?: AbortSignal;
}

/**
 * Cap on model-generated challenges per candidate.
 *
 * Eight is past the point where a panel audience stops reading and well past the
 * point where a model starts padding. The deterministic seeds are *not* capped —
 * every unverified requirement must reach the user, however many there are.
 */
export const MAX_MODEL_CHALLENGES = 8;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The adversarial brief.
 *
 * Exported because a prompt that decides whether a match lives or dies is part of
 * this module's behaviour, not an implementation detail — a test that asserts the
 * skeptical default is real should be able to read it.
 *
 * The load-bearing instruction is the one telling the model to uphold when
 * uncertain. A challenger that resolves its own doubt in the candidate's favour
 * is worse than no challenger at all: it launders uncertainty into apparent
 * validation. Killing a viable match costs one more candidate's worth of compute;
 * passing a bad one costs a line stop.
 */
export const CHALLENGER_SYSTEM_PROMPT = `You are the Challenger in a cross-brand industrial sensor equivalence engine.

A deterministic constraint solver has already scored one SICK catalog part against a customer's requirement. Your job is NOT to agree with it. Your job is to KILL it.

Hunt the killer detail — the thing that makes an engineer send the box back:
- a connector that does not fit the existing harness (M12 4-pin vs M8 3-pin, cable vs plug, wrong pin count)
- a response time milliseconds slower than the machine cycle allows
- IO-Link the original had and this one does not
- an IP rating dropping from IP69K washdown to IP67
- a sensing range that only just reaches the target, with no margin for lens contamination, drift, a dark or glossy target, or misalignment
- a switching output where the original was analog, or PNP where the line is wired NPN
- beam geometry, light spot size, minimum detectable object, mounting pattern, cable exit direction, housing material in a chemical washdown, ambient temperature at the machine, alignment tolerance on a long through-beam, supply and wiring differences, commissioning effort

Rules you must follow:

1. You NEVER select or propose a part. Do not name any SICK order number other than the candidate you were given; any other part number you write is redacted before the user sees it. You attack — a deterministic solver decides.

2. Default to UPHOLDING an objection when you are uncertain. A skeptical challenger that occasionally kills a viable match is far cheaper than a credulous one that lets a bad match through. If you cannot tell whether an objection lands, uphold it or mark it unverifiable. Never refute an objection to be agreeable.

3. "Not stated in the catalog" is NOT "fine". This is a summary catalog and most electrical specs are genuinely unprinted. Silence is an unquantified risk: mark it \`unverifiable\`. Never treat an absent spec as satisfied, and never uphold a fatal objection on a number the catalog does not print.

4. Do not invent spec values. If your objection rests on a specific spec value of the SICK candidate, copy that value into \`assertedValue\` from the catalog record shown to you. Your claims are checked against that record: an asserted value that contradicts it downgrades your challenge to \`refuted\`, and one the catalog is silent on downgrades it to \`unverifiable\`.

5. Objections the spec table already answers have been seeded for you and are listed in the brief. Do not restate them. Spend your effort on application-level objections a spec table cannot express.

Severity:
- \`fatal\` — the part cannot do the job. Installing it means a line stop, a rework, or a safety exposure.
- \`major\` — it works, with a real regression the buyer has to accept knowingly.
- \`minor\` — a nuisance: another accessory, a longer commissioning, a small loss of margin.

Verdict:
- \`upheld\` — the objection is real and you can evidence it.
- \`refuted\` — you raised it, checked it against the catalog record, and it does not hold. Say what refuted it.
- \`unverifiable\` — neither the catalog nor the input can answer it. The risk stands, unquantified. This is a legitimate and useful outcome; use it freely.`;

/**
 * Structured-output schema for the model pass.
 *
 * `assertedValue` is the whole reason this is a schema rather than free text: it
 * forces the model to separate "the spec value I am claiming this part has" from
 * the prose around it, which is what makes the claim mechanically checkable
 * against the catalog record. A model that buries `M8` in a sentence cannot be
 * fact-checked; one that puts `M8` in a field can.
 *
 * Every property is `required` with an explicit `null` alternative rather than
 * being optional — strict structured output wants a closed shape, and "the model
 * omitted it" and "the model said there is none" are otherwise indistinguishable.
 */
export const CHALLENGER_SCHEMA: object = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "challenges"],
  properties: {
    summary: {
      type: "string",
      description: "One sentence: your overall read on this candidate, as the attacker.",
    },
    challenges: {
      type: "array",
      maxItems: MAX_MODEL_CHALLENGES,
      description:
        "Application-level objections only. Do not restate the seeded spec-table objections listed in the brief.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "severity", "field", "verdict", "evidence", "assertedValue"],
        properties: {
          claim: {
            type: "string",
            description: "The objection as a concrete technical statement an engineer would recognize.",
          },
          severity: { type: "string", enum: ["fatal", "major", "minor"] },
          field: {
            type: ["string", "null"],
            description:
              "The spec field under attack (e.g. connector, responseTimeMs, sensingRangeMm), or null when the objection is not about a catalog spec.",
          },
          verdict: { type: "string", enum: ["upheld", "refuted", "unverifiable"] },
          evidence: {
            type: "string",
            description: "Why this lands, does not land, or cannot be checked. Cite the catalog record when you can.",
          },
          assertedValue: {
            type: ["string", "null"],
            description:
              "The value you claim the candidate's `field` has, copied from the catalog record. Null when your objection does not rest on a stated spec value. Inventing a value here downgrades your challenge.",
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Deterministic seeds
// ---------------------------------------------------------------------------

/** Human labels for constraint/spec field names, for claims a buyer can read. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  outputType: "output type",
  outputCount: "number of switching outputs",
  outputCurrentMaxMa: "maximum output current",
  ioLink: "IO-Link support",
  connector: "connection type",
  connectorPins: "connector pin count",
  minIpRating: "IP rating",
  ipRating: "IP rating",
  ip69k: "IP69K washdown rating",
  operatingTempC: "operating temperature range",
  sensingRangeMm: "sensing range",
  responseTimeMs: "response time",
  switchingFrequencyHz: "switching frequency",
  supplyVoltageV: "supply voltage",
  principle: "sensing principle",
  housing: "housing material",
  light: "light source",
  section: "catalog section",
  rowType: "catalog row type",
  family: "product family",
  typeCode: "type code",
  interface: "interface",
};

/** Label a field for prose, falling back to the raw name so nothing is hidden. */
function labelOf(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * Derive challenges from the solver alone.
 *
 * Pure, synchronous, and model-free — that is the point. These are the
 * challenges that must appear on a report even when Anthropic is down, the API
 * key is wrong, or the model refuses, because they are the ones that encode the
 * two facts the user is most entitled to: what the catalog says is *wrong*, and
 * what the catalog does not say at all.
 *
 * Three kinds are emitted, in decreasing order of damage:
 *
 * - `fail` → `upheld` / `fatal`. The catalog contradicts the requirement. This
 *   is the only seed that can set `survives` to false, and it does so without a
 *   model ever being consulted.
 * - `unknown` → `unverifiable` / `major`. The catalog is silent. Not fatal
 *   (silence is not a violation) and emphatically not a pass (silence is not
 *   verification) — a risk the buyer carries, stated as one.
 * - `pass` with `lowConfidence` → `unverifiable` / `minor`. The requirement is
 *   met by a value normalization read out of prose or a footnote rather than a
 *   labelled table cell. Weaker evidence than a table cell, so it is reported as
 *   weaker rather than folded into the clean passes.
 *
 * Every seed carries the candidate's citation: the page whose text — or whose
 * silence — you can go and check by hand.
 */
export function seedChallenges(candidate: ChallengeCandidate): Challenge[] {
  const { product, solve } = candidate;
  const citation = citationFor(product);
  const out: Challenge[] = [];

  for (const verdict of solve.verdicts) {
    if (verdict.status !== "fail") continue;
    out.push({
      claim: `The catalog contradicts the required ${labelOf(verdict.field)}.`,
      severity: "fatal",
      field: verdict.field,
      verdict: "upheld",
      evidence: `Deterministic solve against the printed spec table: ${verdict.detail}.`,
      citation,
    });
  }

  for (const verdict of solve.verdicts) {
    if (verdict.status !== "unknown") continue;
    out.push({
      claim: `The ${labelOf(verdict.field)} requirement cannot be verified — the catalog does not state it for this part.`,
      severity: "major",
      field: verdict.field,
      verdict: "unverifiable",
      evidence:
        `${verdict.detail}. This is the summary catalog, so the value is genuinely unprinted rather than missing ` +
        `from our extraction. The requirement stands unverified: absent is not passing, and it must be confirmed ` +
        `on the full datasheet before this part is ordered.`,
      citation,
    });
  }

  for (const verdict of solve.verdicts) {
    if (verdict.status !== "pass" || verdict.lowConfidence !== true) continue;
    out.push({
      claim: `The ${labelOf(verdict.field)} match rests on a value read from prose, not a labelled spec cell.`,
      severity: "minor",
      field: verdict.field,
      verdict: "unverifiable",
      evidence:
        `${verdict.detail} — but the underlying catalog field is flagged low-confidence, meaning it was recovered ` +
        `from a descriptive bullet or footnote. Treat this pass as provisional until the datasheet confirms it.`,
      citation,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Catalog fact-checking
// ---------------------------------------------------------------------------

/** Unit family a numeric assertion about a field is measured in. */
type UnitKind = "mm" | "ms" | "Hz" | "mA" | "V" | "C" | "count";

/**
 * What the catalog actually holds for one field.
 *
 * `stated: false` is a first-class outcome and means "this is a real catalog
 * field and the page does not print it" — which is different from
 * {@link lookupFact} returning `null`, meaning "this is not a catalog field at
 * all" (mounting, alignment, lead time). The two must not be conflated: the
 * first downgrades a model's asserted number, the second leaves the model's
 * judgement alone because we hold no fact to contradict it with.
 */
interface CatalogFact {
  readonly field: string;
  readonly label: string;
  readonly kind: "number" | "text" | "flag";
  readonly unit: UnitKind;
  /** Numbers an assertion about this field may legitimately name (range ends included). */
  readonly numbers: readonly number[];
  /** Categorical tokens, normalized first then the verbatim Spanish as printed. */
  readonly texts: readonly string[];
  /** True only when the catalog positively asserts the flag; flags are never denied. */
  readonly flag: boolean;
  readonly stated: boolean;
  /** How the catalog value reads in evidence prose. */
  readonly display: string;
}

/** Fold a field name so `response_time`, `responseTimeMs` and `Response time` agree. */
function fold(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Field aliases → the canonical key {@link lookupFact} switches on.
 *
 * The model writes whatever an engineer would write, and the solver writes
 * constraint names. Both have to land on the same catalog field or the
 * fact-check silently stops running — which would look exactly like a model that
 * never lies.
 */
const CANONICAL_FIELD: Readonly<Record<string, string>> = {
  outputtype: "outputType",
  output: "outputType",
  switchingoutput: "outputType",
  outputfunction: "outputType",
  outputcount: "outputCount",
  outputcurrent: "outputCurrentMaxMa",
  outputcurrentmaxma: "outputCurrentMaxMa",
  iolink: "ioLink",
  connector: "connector",
  connection: "connector",
  connectortype: "connector",
  connectorpins: "connectorPins",
  pins: "connectorPins",
  pincount: "connectorPins",
  ip: "ipRating",
  iprating: "ipRating",
  miniprating: "ipRating",
  enclosurerating: "ipRating",
  ingressprotection: "ipRating",
  ip69k: "ip69k",
  operatingtemp: "operatingTempC",
  operatingtempc: "operatingTempC",
  operatingtemperature: "operatingTempC",
  temperature: "operatingTempC",
  ambienttemperature: "operatingTempC",
  sensingrange: "sensingRangeMm",
  sensingrangemm: "sensingRangeMm",
  sensingrangemaxmm: "sensingRangeMm",
  sensingrangeminmm: "sensingRangeMm",
  range: "sensingRangeMm",
  responsetime: "responseTimeMs",
  responsetimems: "responseTimeMs",
  switchingfrequency: "switchingFrequencyHz",
  switchingfrequencyhz: "switchingFrequencyHz",
  supplyvoltage: "supplyVoltageV",
  supplyvoltagev: "supplyVoltageV",
  voltage: "supplyVoltageV",
  principle: "principle",
  sensingprinciple: "principle",
  detectionprinciple: "principle",
  housing: "housing",
  housingmaterial: "housing",
  light: "light",
  lighttype: "light",
  lightsource: "light",
  lightspot: "lightSpot",
  adjustment: "adjustment",
  interface: "interface",
  family: "family",
  section: "section",
  rowtype: "rowType",
  typecode: "typeCode",
  scopeofdelivery: "scopeOfDelivery",
};

function numberFact(
  field: string,
  values: readonly (number | undefined)[],
  unit: UnitKind,
  suffix: string,
  verbatim?: string,
): CatalogFact {
  const numbers = values.filter((v): v is number => v !== undefined);
  return {
    field,
    label: labelOf(field),
    kind: "number",
    unit,
    numbers,
    texts: [],
    flag: false,
    stated: numbers.length > 0,
    display:
      numbers.length === 0
        ? "not stated"
        : `${numbers.map((n) => String(n)).join(" … ")}${suffix}${verbatim !== undefined ? ` (catalog: "${verbatim}")` : ""}`,
  };
}

function textFact(field: string, value: string | undefined, verbatim?: string): CatalogFact {
  const texts = [value, verbatim].filter((t): t is string => t !== undefined && t.trim() !== "");
  return {
    field,
    label: labelOf(field),
    kind: "text",
    unit: "count",
    numbers: [],
    texts,
    flag: false,
    stated: value !== undefined && value !== "",
    display:
      texts.length === 0
        ? "not stated"
        : `${value ?? texts[0] ?? ""}${verbatim !== undefined && verbatim !== value ? ` (catalog: "${verbatim}")` : ""}`,
  };
}

/**
 * A predicate the catalog can only ever assert, never deny.
 *
 * `ioLink` and `ip69k` are only ever populated as `true` by normalization, by
 * design. A page that does not mention IO-Link is not a page that says there is
 * none, so anything other than a positive `true` is silence and gets
 * `stated: false` — the same treatment an absent number gets, for the same
 * reason. `false` is accepted at this boundary and treated as silence rather
 * than as a denial, because a denial we cannot source is not a fact.
 */
function flagFact(field: string, value: boolean | undefined, verbatim?: string): CatalogFact {
  return {
    field,
    label: labelOf(field),
    kind: "flag",
    unit: "count",
    numbers: [],
    texts: [],
    flag: value === true,
    stated: value === true,
    display: value === true ? `stated${verbatim !== undefined ? ` (catalog: "${verbatim}")` : ""}` : "not stated",
  };
}

/**
 * Resolve a field name to what the catalog holds for this SKU.
 *
 * Returns `null` when the name is not a catalog spec at all — mounting pattern,
 * alignment tolerance, lead time. That is not a failure: those are exactly the
 * objections the model is here to raise, and having no fact to check them
 * against is why they reach the user on the model's authority rather than ours.
 */
function lookupFact(rawField: string, spec: NormalizedSpec, product: SickProduct): CatalogFact | null {
  const key = CANONICAL_FIELD[fold(rawField)];
  if (key === undefined) return null;

  switch (key) {
    case "outputType":
      return textFact(
        key,
        spec.outputType === "unknown" ? undefined : spec.outputType,
        product.switchingOutput,
      );
    case "outputCount":
      return numberFact(key, [spec.outputCount], "count", "", product.switchingOutput);
    case "outputCurrentMaxMa":
      return numberFact(key, [spec.outputCurrentMaxMa], "mA", " mA", product.switchingOutput);
    case "ioLink":
      return flagFact(key, spec.ioLink, product.switchingOutput);
    case "connector":
      return textFact(key, spec.connector === "unknown" ? undefined : spec.connector, product.connection);
    case "connectorPins":
      return numberFact(key, [spec.connectorPins], "count", "-pin", product.connection);
    case "ipRating":
      return numberFact(key, [spec.ipRating], "count", "", product.enclosureRating);
    case "ip69k":
      return flagFact(key, spec.ip69k, product.enclosureRating);
    case "operatingTempC":
      return numberFact(key, [spec.operatingTempMinC, spec.operatingTempMaxC], "C", " °C");
    case "sensingRangeMm":
      return numberFact(key, [spec.sensingRangeMinMm, spec.sensingRangeMaxMm], "mm", " mm");
    case "responseTimeMs":
      return numberFact(key, [spec.responseTimeMs], "ms", " ms");
    case "switchingFrequencyHz":
      return numberFact(key, [spec.switchingFrequencyHz], "Hz", " Hz");
    case "supplyVoltageV":
      return numberFact(key, [spec.supplyVoltageMinV, spec.supplyVoltageMaxV], "V", " V");
    case "principle":
      return textFact(
        key,
        spec.principle === "unknown" ? undefined : spec.principle,
        product.sensorPrinciple ?? product.detectionPrinciple,
      );
    case "housing":
      return textFact(key, spec.housing === "other" ? undefined : spec.housing, product.housingMaterial);
    case "light":
      return textFact(key, spec.light === "other" ? undefined : spec.light, product.lightType);
    case "lightSpot":
      return textFact(key, product.lightSpot);
    case "adjustment":
      return textFact(key, product.adjustment);
    case "interface":
      return textFact(key, product.interface);
    case "scopeOfDelivery":
      return textFact(key, product.scopeOfDelivery);
    case "family":
      return textFact(key, product.family);
    case "section":
      return textFact(key, product.section);
    case "rowType":
      return textFact(key, product.rowType);
    case "typeCode":
      return textFact(key, product.typeCode);
    default:
      return null;
  }
}

/** Multipliers onto the canonical unit, per unit family. */
const UNIT_SCALE: Readonly<Record<UnitKind, Readonly<Record<string, number>>>> = {
  mm: { "": 1, mm: 1, cm: 10, m: 1000, um: 0.001, "µm": 0.001, in: 25.4, inch: 25.4, ft: 304.8 },
  ms: { "": 1, ms: 1, s: 1000, sec: 1000, us: 0.001, "µs": 0.001, ns: 1e-6, min: 60_000 },
  Hz: { "": 1, hz: 1, khz: 1000, mhz: 1e6 },
  mA: { "": 1, ma: 1, a: 1000, ua: 0.001, "µa": 0.001 },
  V: { "": 1, v: 1, vdc: 1, vcc: 1, mv: 0.001, kv: 1000 },
  C: { "": 1, c: 1, "°c": 1 },
  count: { "": 1 },
};

/**
 * Read the number out of a model's asserted value, converted to the field's
 * canonical unit.
 *
 * Unit conversion is not politeness — it is what stops `"1.2 m"` from being
 * declared a contradiction of a catalog that prints `1200 mm`. A false
 * contradiction is the dangerous direction: it refutes a real objection and lets
 * a bad match through, which is precisely what this module exists to prevent.
 * When the unit token is unrecognized the value is assumed to already be
 * canonical, and `°F` is converted rather than mistaken for °C.
 */
function parseAsserted(text: string, unit: UnitKind): number | undefined {
  const match = /(-?\d+(?:[.,]\d+)?)\s*(°?[a-zµ]*)/i.exec(text);
  if (match === null) return undefined;
  const raw = Number.parseFloat((match[1] ?? "").replace(",", "."));
  if (!Number.isFinite(raw)) return undefined;
  const token = (match[2] ?? "").toLowerCase();
  if (unit === "C" && (token === "f" || token === "°f")) return ((raw - 32) * 5) / 9;
  const scale = UNIT_SCALE[unit][token];
  return raw * (scale ?? 1);
}

/** Tolerant equality: 5 % of the larger magnitude, so rounded catalog prints match. */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-6, 0.05 * Math.max(Math.abs(a), Math.abs(b)));
}

/** Words a model uses when it claims a feature is absent. */
const DENIAL = /\b(no|not|none|without|lacks?|lacking|missing|absent|unsupported|false|sin)\b/i;

/**
 * Does the model's asserted value contradict what the catalog prints?
 *
 * Only ever consulted for `stated` facts — a silent catalog contradicts nothing,
 * and treating silence as a refutation would be the "unknown rendered as pass"
 * bug wearing a different hat.
 *
 * Text comparison is containment in either direction rather than equality, so
 * `PNP` does not "contradict" a catalog that prints `PNP/NPN`, and the verbatim
 * Spanish (`Conector M12 de 4 polos`) is accepted alongside the normalized token
 * (`M12`). Containment is deliberately generous: refuting is the move that
 * *weakens* a challenge, so it needs the higher bar.
 */
function contradicts(fact: CatalogFact, asserted: string): boolean {
  if (!fact.stated) return false;
  if (fact.kind === "flag") return fact.flag && DENIAL.test(asserted);
  if (fact.kind === "number") {
    const value = parseAsserted(asserted, fact.unit);
    if (value === undefined) return false;
    return !fact.numbers.some((n) => close(n, value));
  }
  const a = fold(asserted);
  if (a === "") return false;
  return !fact.texts.some((t) => {
    const f = fold(t);
    return f !== "" && (f.includes(a) || a.includes(f));
  });
}

// ---------------------------------------------------------------------------
// Model response handling
// ---------------------------------------------------------------------------

interface ModelChallenge {
  readonly claim?: unknown;
  readonly severity?: unknown;
  readonly field?: unknown;
  readonly verdict?: unknown;
  readonly evidence?: unknown;
  readonly assertedValue?: unknown;
}

interface ModelOutput {
  readonly summary?: unknown;
  readonly challenges?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Coerce severity, defaulting to `major`. */
function asSeverity(value: unknown): ChallengeSeverity {
  return value === "fatal" || value === "major" || value === "minor" ? value : "major";
}

/**
 * Coerce a verdict, defaulting to `upheld`.
 *
 * The default is the skeptical one on purpose: a garbled verdict means we do not
 * know whether the objection lands, and this module's whole posture is that
 * not-knowing resolves against the candidate. The alternative default silently
 * converts model noise into approval.
 */
function asVerdict(value: unknown): Challenge["verdict"] {
  return value === "refuted" || value === "unverifiable" || value === "upheld" ? value : "upheld";
}

/**
 * Redact SICK order numbers that are not this candidate's.
 *
 * Rule 1: the LLM never picks the part. The Challenger has no selection channel,
 * so the only way a model-chosen order number could reach a user is smuggled
 * inside prose — "use 1041182 instead". Redacting rather than dropping the whole
 * challenge keeps the objection (which may be perfectly good) while removing the
 * recommendation it has no authority to make.
 */
function redactForeignOrderNumbers(text: string, ownOrderNumber: string): string {
  return text.replace(/\b\d{7}\b/g, (found) =>
    found === ownOrderNumber ? found : "[part number redacted — the Challenger may not propose parts]",
  );
}

/**
 * Turn one model challenge into a {@link Challenge}, fact-checked.
 *
 * Three outcomes, all of them recorded in `evidence` so the user sees the
 * machine correcting the model rather than a verdict that quietly changed:
 *
 * - The assertion contradicts a stated catalog value → `refuted`.
 * - The assertion names a value the catalog is silent on → an `upheld` challenge
 *   drops to `unverifiable`. The objection is not dismissed; it is stripped of
 *   the invented certainty and reported as the open risk it actually is.
 * - The assertion agrees with the catalog → the verdict stands and the
 *   candidate's citation is attached, because now the claim has a source.
 */
function verifyChallenge(raw: ModelChallenge, product: SickProduct, spec: NormalizedSpec): Challenge | null {
  const claim = asString(raw.claim);
  if (claim === undefined) return null;

  const field = asString(raw.field);
  const asserted = asString(raw.assertedValue);
  const severity = asSeverity(raw.severity);
  let verdict = asVerdict(raw.verdict);
  let evidence = asString(raw.evidence) ?? "The Challenger gave no evidence for this objection.";

  const fact = field !== undefined ? lookupFact(field, spec, product) : null;
  let cited = false;

  if (fact !== null && asserted !== undefined) {
    if (fact.stated && contradicts(fact, asserted)) {
      verdict = "refuted";
      evidence =
        `${evidence} — REFUTED against the catalog record: the Challenger asserted ${fact.label} of ` +
        `"${asserted}", but the catalog states ${fact.display} for this part. The objection rests on a value ` +
        `the source does not support.`;
      cited = true;
    } else if (!fact.stated) {
      if (verdict === "upheld") {
        verdict = "unverifiable";
        evidence =
          `${evidence} — DOWNGRADED to unverifiable: the Challenger asserted ${fact.label} of "${asserted}", ` +
          `but the catalog does not state ${fact.label} for this part, so nothing sources that value. The risk ` +
          `stands, unquantified, and must be confirmed on the full datasheet.`;
      } else {
        evidence = `${evidence} (The catalog does not state ${fact.label} for this part, so this cannot be checked either way.)`;
      }
    } else {
      evidence = `${evidence} — checked against the catalog record, which states ${fact.display}.`;
      cited = true;
    }
  }

  return {
    claim: redactForeignOrderNumbers(claim, product.orderNumber),
    severity,
    ...(field !== undefined ? { field } : {}),
    verdict,
    evidence: redactForeignOrderNumbers(evidence, product.orderNumber),
    ...(cited ? { citation: citationFor(product) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Render the brief the model attacks.
 *
 * Two things in here are load-bearing. First, fields the catalog does not state
 * are printed as `NOT STATED IN THE CATALOG` rather than omitted — a model shown
 * a spec table with holes in it invents plausible filler, and a model told
 * explicitly that the page is silent raises the silence as a risk instead.
 * Second, the seeded challenges are listed so the model spends its budget on
 * objections the spec table cannot reach rather than paraphrasing the solver.
 */
function renderBrief(
  candidate: ChallengeCandidate,
  context: ChallengeContext,
  seeds: readonly Challenge[],
): string {
  const { product, solve } = candidate;
  const lines: string[] = [];

  lines.push(`# The requirement`);
  const identified = context.identified;
  if (identified !== undefined) {
    const parts = [identified.vendor, identified.series, identified.model].filter(
      (p): p is string => p !== undefined && p !== "",
    );
    lines.push(`Part being replaced: ${parts.join(" ") || "(unnamed)"}`);
    if (identified.rawInput !== undefined) lines.push(`As the user wrote it: ${identified.rawInput}`);
    if (identified.description !== undefined) lines.push(`Description: ${identified.description}`);
    lines.push(
      `Spec source: ${identified.specSource}` +
        (identified.specSource === "inferred"
          ? " — these competitor specs were read off the input by a model, not looked up. Treat them as soft."
          : identified.specSource === "unknown"
            ? " — we hold no data on this part; the run is proceeding on constraints alone."
            : " — looked up in our extracted competitor dataset and citable."),
    );
  } else {
    lines.push("No competitor part was identified; the run is proceeding on constraints alone.");
  }
  lines.push("");
  lines.push(`Constraints the solver was given:`);
  lines.push(JSON.stringify(context.resolved.constraints));
  if (context.resolved.assumptions.length > 0) {
    lines.push(`Assumptions the Resolver made (each one is an attack surface):`);
    for (const a of context.resolved.assumptions) lines.push(`- ${a}`);
  }
  if (context.resolved.missing.length > 0) {
    lines.push(`Constraint fields the input never pinned down: ${context.resolved.missing.join(", ")}`);
  }

  lines.push("");
  lines.push(`# The candidate under attack`);
  lines.push(
    `SICK ${product.orderNumber}${product.typeCode !== undefined ? ` (${product.typeCode})` : ""} — ` +
      `${product.productName ?? product.shortDescription ?? product.category}`,
  );
  lines.push(
    `Family ${product.family ?? "(none)"} · section ${product.section} · catalog page ${product.sourcePage}`,
  );

  lines.push("");
  lines.push(`## Catalog record (this is the ONLY source of spec truth for this part)`);
  for (const row of describeSpecs(product, candidate.solve.spec)) {
    if (!row.stated) {
      lines.push(`- ${row.label}: NOT STATED IN THE CATALOG`);
      continue;
    }
    const verbatim = row.catalogText !== null ? ` — printed as "${truncate(row.catalogText, 160)}"` : "";
    const weak = row.lowConfidence ? " [low confidence: read from prose, not a spec cell]" : "";
    lines.push(`- ${row.label}: ${String(row.value)}${verbatim}${weak}`);
  }

  lines.push("");
  lines.push(`## Deterministic solver verdicts`);
  lines.push(`${solve.passed} verified pass · ${solve.failed} verified fail · ${solve.unknown} unverifiable`);
  for (const v of solve.verdicts) {
    lines.push(`- [${v.status.toUpperCase()}] ${v.field}: ${v.detail}`);
  }

  lines.push("");
  lines.push(`## Already-seeded challenges — do NOT restate these`);
  if (seeds.length === 0) {
    lines.push("(none)");
  } else {
    for (const s of seeds) lines.push(`- [${s.verdict}/${s.severity}] ${s.claim}`);
  }

  lines.push("");
  lines.push(
    `Now attack this candidate. Raise up to ${MAX_MODEL_CHALLENGES} application-level objections the spec table ` +
      `cannot express. If you genuinely cannot find one, return an empty list rather than padding — but look hard first.`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The Challenger
// ---------------------------------------------------------------------------

/** True when nothing fatal was upheld. See the module note: survival ≠ verified. */
function computeSurvives(challenges: readonly Challenge[]): boolean {
  return !challenges.some((c) => c.verdict === "upheld" && c.severity === "fatal");
}

/** The upheld fatal challenge that killed a candidate, for the promotion trace. */
function killerOf(report: ChallengeReport): Challenge | undefined {
  return report.challenges.find((c) => c.verdict === "upheld" && c.severity === "fatal");
}

function buildSummary(
  challenges: readonly Challenge[],
  survives: boolean,
  modelSummary: string | undefined,
  degradation: string | undefined,
): string {
  const fatal = challenges.filter((c) => c.verdict === "upheld" && c.severity === "fatal").length;
  const upheld = challenges.filter((c) => c.verdict === "upheld").length;
  const unverifiable = challenges.filter((c) => c.verdict === "unverifiable").length;
  const refuted = challenges.filter((c) => c.verdict === "refuted").length;

  const head = survives
    ? `Survives: no fatal objection upheld`
    : `Killed: ${fatal} fatal objection${fatal === 1 ? "" : "s"} upheld`;
  const counts =
    `${upheld} upheld, ${unverifiable} unverifiable (catalog silent — unverified risk, not a pass), ` +
    `${refuted} refuted.`;

  const tail = degradation !== undefined ? ` ${degradation}` : "";
  const note = modelSummary !== undefined && degradation === undefined ? ` Challenger: ${truncate(modelSummary, 160)}` : "";
  return `${head}. ${counts}${tail}${note}`;
}

/**
 * Attack one candidate and report what survived the attack.
 *
 * Runs the deterministic seeds first and emits them to the trace immediately, so
 * the panel has attacks landing while the model is still thinking — and so a
 * model that never answers still leaves a complete, honest record behind.
 *
 * **Never throws.** A refusal, a transport error, an abort or a malformed
 * response all produce the deterministic report with the degradation stated in
 * {@link ChallengeReport.summary}. Callers that need to distinguish "the model
 * ran and found nothing" from "the model never ran" read that summary; there is
 * deliberately no exception to catch, because the seeded findings are worth
 * delivering on their own and an exception would discard them.
 *
 * @example
 * ```ts
 * const report = await challenge({ product, solve }, { resolved }, { client, trace });
 * if (!report.survives) console.log(report.summary); // "Killed: 1 fatal objection upheld…"
 * ```
 */
export async function challenge(
  candidate: ChallengeCandidate,
  context: ChallengeContext,
  deps: ChallengeDeps,
): Promise<ChallengeReport> {
  const { product } = candidate;
  const orderNumber = product.orderNumber;
  const trace = deps.trace.child(product.typeCode ?? orderNumber);

  trace.emit({
    type: "challenger.start",
    label: `attacking ${product.typeCode ?? orderNumber}`,
    orderNumber,
  });

  const challenges: Challenge[] = [];
  const attack = (c: Challenge): void => {
    challenges.push(c);
    trace.emit({
      type: "challenger.attack",
      label: `${c.verdict} · ${c.severity} · ${truncate(c.claim, 90)}`,
      challenge: c,
    });
  };

  for (const seed of seedChallenges(candidate)) attack(seed);

  let degradation: string | undefined;
  let modelSummary: string | undefined;

  try {
    if (deps.signal?.aborted === true) {
      degradation = "The run was aborted before the adversarial pass; deterministic seeds only.";
    } else {
      const result = await deps.client.structured<ModelOutput>({
        system: CHALLENGER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: renderBrief(candidate, context, challenges) }],
        schema: CHALLENGER_SCHEMA,
        effort: CHALLENGER_EFFORT,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });

      if (isRefused(result)) {
        degradation = `The adversarial pass was declined by the model (${result.reason}); deterministic seeds only.`;
      } else {
        modelSummary = asString(result.value.summary);
        const raw: (ModelChallenge | undefined)[] = Array.isArray(result.value.challenges)
          ? (result.value.challenges as (ModelChallenge | undefined)[])
          : [];
        for (const item of raw.slice(0, MAX_MODEL_CHALLENGES)) {
          const verified = verifyChallenge(item ?? {}, product, candidate.solve.spec);
          if (verified !== null) attack(verified);
        }
      }
    }
  } catch (error) {
    // A dead model must not delete findings we already hold. See the module note.
    degradation = `The adversarial pass failed (${
      error instanceof Error ? error.message : String(error)
    }); deterministic seeds only.`;
  }

  if (degradation !== undefined) {
    trace.emit({
      type: "error",
      label: "adversarial pass degraded",
      message: degradation,
      recoverable: true,
    });
  }

  const survives = computeSurvives(challenges);
  const report: ChallengeReport = {
    orderNumber,
    challenges,
    survives,
    summary: buildSummary(challenges, survives, modelSummary, degradation),
  };

  trace.emit({
    type: "challenger.verdict",
    label: survives ? `survives (${challenges.length} attacks)` : `killed (${challenges.length} attacks)`,
    orderNumber,
    survives,
  });

  return report;
}

/**
 * Challenge candidates in rank order, stopping at the first survivor.
 *
 * The stop is the point. Challenging every candidate would cost a model call per
 * SKU to produce reports nobody reads — the run only ever recommends the first
 * survivor and whatever caveats it carries. Stopping also produces the moment the
 * product is actually selling: rank 1 dies on a fatal objection, rank 2 is
 * promoted, and `candidate.promoted` carries the reason across so the trace panel
 * can show *why* the answer changed rather than just showing a different part.
 *
 * Returns the reports produced so far — including the losers, which are the
 * evidence that the survivor was not simply the first thing retrieved. An empty
 * array means there were no candidates; an array whose last report has
 * `survives: false` means every candidate died, which the caller should surface
 * as `no_equivalent` rather than as an error.
 *
 * Never throws, for the same reason {@link challenge} does not.
 */
export async function challengeAll(
  candidates: readonly ChallengeCandidate[],
  context: ChallengeContext,
  deps: ChallengeDeps,
): Promise<ChallengeReport[]> {
  const reports: ChallengeReport[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    if (deps.signal?.aborted === true) break;

    const report = await challenge(candidate, context, deps);
    reports.push(report);
    if (!report.survives) continue;

    const previous = reports[reports.length - 2];
    if (previous !== undefined) {
      const killer = killerOf(previous);
      deps.trace.emit({
        type: "candidate.promoted",
        label: `${previous.orderNumber} → ${report.orderNumber}`,
        from: previous.orderNumber,
        to: report.orderNumber,
        because: killer !== undefined ? killer.claim : `${previous.orderNumber} did not survive the adversarial pass.`,
      });
    }
    break;
  }

  return reports;
}
