/**
 * Verbatim-Spanish catalog text → {@link NormalizedSpec}.
 *
 * This module is the hinge the whole architecture turns on. Retrieval hands the
 * solver a candidate set; the solver may only compare *normalized structured
 * fields*, never prose. So every categorical cell the catalog prints in Spanish
 * (`"1 x / 2 x en contrafase: PNP/ NPN (100 mA), IO-Link 3)"`) has to become
 * machine-comparable here, or it is invisible to the deterministic match.
 *
 * ## The rule every function below obeys
 *
 * **A field we cannot confidently parse stays `undefined`.** `undefined` means
 * "the catalog does not state it", which the solver reports as `unknown` — a
 * visible, countable gap the agent must surface. A *guess* becomes a `pass` or
 * `fail` verdict indistinguishable from a verified one, i.e. a confident wrong
 * recommendation on a part someone is going to bolt onto a machine. Ignorance is
 * cheap; a wrong parse is not. There are no defaults anywhere in this file.
 *
 * Two consequences that surprise readers, so they are called out here:
 *
 * - `ioLink` and `ip69k` are only ever `true`, never `false`. This is the
 *   *resumido* (summary) catalog: silence about IO-Link is not a denial of
 *   IO-Link. Emitting `false` would let the solver hard-fail a SKU on evidence
 *   that does not exist.
 * - The `"unknown"` members of {@link OutputType} / {@link SensingPrinciple} are
 *   never emitted. A naive solver comparing `spec.outputType` against a
 *   constraint list would score `"unknown"` as a *fail*; omitting the property
 *   forces it down the honest `unknown` path instead.
 *
 * Pure and deterministic: no I/O, no clock, no env, no network.
 */

import type {
  ConnectorType,
  NormalizedSpec,
  OutputType,
  SensingPrinciple,
  SickProduct,
} from "../types.js";

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Lowercase and strip diacritics so one pattern matches every surface form the
 * 196 extraction agents produced. The same spec is printed as `Relé`/`relé`,
 * `Luz roja visible`/`luz roja visible`, `supresión`/`supresion` across pages;
 * matching on folded text keeps the rule tables small enough to audit by eye.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Catalog footnote markers (`" 3)"`, `" 8)"`) printed after a value.
 *
 * `"IO-Link 3)"` means "IO-Link, see footnote 3" — the `3` is typography, not a
 * quantity. Left in place it would be picked up as an output count or a current
 * rating, so it is removed before any number is read out of the field.
 */
const FOOTNOTE_MARKER = /\s*\d+\)/g;

/**
 * An analog signal *range* such as `4 mA ... 20 mA` or `0 V ... 10 V`.
 *
 * Must be distinguished from a single parenthesized `(100 mA)`, which is a
 * per-output *current rating*. Reading `20` out of `4 mA ... 20 mA` as
 * `outputCurrentMaxMa` would understate the load capability of a sensor by 5x.
 */
const ANALOG_RANGE = /\d+(?:[.,]\d+)?\s*(?:ma|v)\s*(?:\.{2,}|…)\s*\d+(?:[.,]\d+)?\s*(?:ma|v)/g;

/** Parse a Spanish-formatted decimal (`0,3`) or plain integer. */
function toNumber(raw: string): number | undefined {
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Collapse a field name to a comparison key: `switching_output`,
 * `switchingOutput` and `Switching Output` all fold to `switchingoutput`.
 *
 * `SickProduct.lowConfidence` carries *source* field names, and the catalog
 * loader owns whether it rewrites those strings to camelCase when it converts
 * the JSONL. Comparing on a case- and separator-insensitive key means this
 * module keeps working either way, instead of silently dropping every
 * low-confidence flag the day the loader changes its mind.
 */
function canonicalFieldName(name: string): string {
  return name.replace(/[_\s-]/g, "").toLowerCase();
}

/**
 * Distinct capture-group-1 values of a global pattern.
 *
 * The *distinct* part is what matters: every caller below treats "the field
 * states two different values" as unknown rather than picking one, so the set
 * size is the decision, not the first match.
 */
function collectGroups(text: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const group = match[1];
    if (group !== undefined) found.add(group);
  }
  return found;
}

// ---------------------------------------------------------------------------
// switching_output → outputType / outputCount / outputCurrentMaxMa / ioLink
// ---------------------------------------------------------------------------

interface ParsedOutput {
  outputType: OutputType | undefined;
  outputCount: number | undefined;
  outputCurrentMaxMa: number | undefined;
  ioLink: true | undefined;
}

/** Tokens that mark where the output *type* starts, i.e. where the count ends. */
const OUTPUT_TYPE_TOKENS = ["pnp", "npn", "contrafase", "rele", "relay", "conmutador"];

/**
 * Plausible number of switching outputs on one SKU in this catalog. A parse
 * outside this window means the prefix scan latched onto something that is not
 * an output count, and the honest answer is "not stated".
 */
const MAX_PLAUSIBLE_OUTPUT_COUNT = 8;

function parseSwitchingOutput(raw: string | undefined): ParsedOutput {
  const empty: ParsedOutput = {
    outputType: undefined,
    outputCount: undefined,
    outputCurrentMaxMa: undefined,
    ioLink: undefined,
  };
  if (raw === undefined) return empty;

  const text = fold(raw.replace(FOOTNOTE_MARKER, ""));
  if (text === "") return empty;

  const hasPnp = text.includes("pnp");
  const hasNpn = text.includes("npn");
  // `en contrafase` = antivalent / push-pull. It is printed alongside
  // "PNP/ NPN" because a push-pull stage sources *and* sinks; push-pull is the
  // more specific truth, so it wins over the PNP/NPN reading.
  const isPushPull = text.includes("contrafase");
  const isRelay = /\brele\b|\brelay\b/.test(text);
  const analogRanges = text.match(ANALOG_RANGE) ?? [];

  let outputType: OutputType | undefined;
  if (isPushPull) outputType = "push-pull";
  else if (isRelay) outputType = "relay";
  else if (hasPnp && hasNpn)
    outputType = "PNP/NPN"; // "PNP y NPN", "PNP/NPN, seleccionable"
  else if (hasPnp) outputType = "PNP";
  else if (hasNpn) outputType = "NPN";
  else if (analogRanges.length > 0) outputType = "analog";
  // else: e.g. "Conmutador sin contacto" — a solid-state switch whose polarity
  // the catalog never states. Left undefined rather than guessed.

  // Current rating: a single mA value that is NOT part of an analog range.
  let currentText = text;
  for (const range of analogRanges) currentText = currentText.replace(range, " ");
  const currentRaw = /(\d+(?:[.,]\d+)?)\s*ma\b/.exec(currentText)?.[1];
  const outputCurrentMaxMa = currentRaw !== undefined ? toNumber(currentRaw) : undefined;

  // Count: only the digits that appear BEFORE the output-type token. Anything
  // after it is a current, a voltage, or a footnote.
  let outputCount: number | undefined;
  const tokenIndexes = OUTPUT_TYPE_TOKENS.map((t) => text.indexOf(t)).filter((i) => i >= 0);
  if (tokenIndexes.length > 0) {
    const prefix = text.slice(0, Math.min(...tokenIndexes));
    const distinct = new Set(prefix.match(/\d+/g) ?? []);
    // "1 x / 2 x en contrafase" and "2 x / 1 PNP" state an alternative, not a
    // count — the SKU may be either. Two different numbers means unknown.
    if (distinct.size === 1) {
      const only = [...distinct][0];
      const n = only !== undefined ? toNumber(only) : undefined;
      if (n !== undefined && Number.isInteger(n) && n >= 1 && n <= MAX_PLAUSIBLE_OUTPUT_COUNT) {
        outputCount = n;
      }
    }
  }

  return {
    outputType,
    outputCount,
    outputCurrentMaxMa,
    ioLink: /io-?link/.test(text) ? true : undefined,
  };
}

// ---------------------------------------------------------------------------
// connection → connector / connectorPins
// ---------------------------------------------------------------------------

interface ParsedConnection {
  connector: ConnectorType | undefined;
  connectorPins: number | undefined;
}

/**
 * Circular-connector thread sizes we canonicalize.
 *
 * Deliberately anchored to exactly M5/M8/M12: the same field also prints cable
 * glands and process threads (`racor M20`, `Entrada de cable, 3 x M20`,
 * `1 x M16`) which are *not* connectors. A permissive `M\d+` would report a
 * junction box with a cable gland as an "M20 connector" and mislead every
 * downstream compatibility check.
 */
const CONNECTOR_THREAD = /\bm(5|8|12)\b/g;

/**
 * Pin counts are read only from `polos` / `pines` — never from `hilos` (wires).
 * `Cable de 3 hilos` is a bare 3-wire pigtail with no connector to mate with, so
 * reporting `connectorPins: 3` would answer a question the catalog never asked.
 */
const PIN_COUNT = /(\d+)\s*(?:polos|polo|pines|pin)\b/g;

function parseConnection(raw: string | undefined): ParsedConnection {
  const none: ParsedConnection = { connector: undefined, connectorPins: undefined };
  if (raw === undefined) return none;
  const text = fold(raw);
  if (text === "") return none;

  const threads = collectGroups(text, CONNECTOR_THREAD);
  if (threads.size > 1) {
    // A two-headed cable with different threads at each end (Conexión A / B).
    // No single value is correct, so state nothing.
    return none;
  }

  const thread = threads.size === 1 ? [...threads][0] : undefined;
  if (thread !== undefined) {
    const pins = collectGroups(text, PIN_COUNT);
    const onlyPins = pins.size === 1 ? [...pins][0] : undefined;
    const pinCount = onlyPins !== undefined ? toNumber(onlyPins) : undefined;
    return {
      connector: `M${thread}` as ConnectorType,
      // A pigtail ("Cable con conector macho M12 de 4 polos, 300 mm") is keyed
      // by the connector, not the lead — that is what has to mate.
      connectorPins:
        pinCount !== undefined && Number.isInteger(pinCount) && pinCount >= 2 && pinCount <= 12
          ? pinCount
          : undefined,
    };
  }

  if (text.includes("borne") || text.includes("terminal")) {
    return { connector: "terminal", connectorPins: undefined };
  }
  if (text.includes("cable")) {
    return { connector: "cable", connectorPins: undefined };
  }
  // Positively stated, but outside our vocabulary: Ethernet, DIN 43650 valve
  // plugs, DIN EN 175301-803 hoods, proprietary system plugs. `other` is a real
  // answer here — the catalog told us, we just don't model it.
  return { connector: "other", connectorPins: undefined };
}

// ---------------------------------------------------------------------------
// enclosure_rating → ipRating / ip69k
// ---------------------------------------------------------------------------

interface ParsedEnclosure {
  ipRating: number | undefined;
  ip69k: true | undefined;
}

/** `IP 67`, `IP 69K`, `IP 68/IP 69K`, `IP 67: EN 60529`. */
const IP_RATING = /ip\s*(\d{2})\s*(k)?/g;

function parseEnclosureRating(raw: string | undefined): ParsedEnclosure {
  const none: ParsedEnclosure = { ipRating: undefined, ip69k: undefined };
  if (raw === undefined) return none;
  const text = fold(raw);

  let lowest: number | undefined;
  let has69k = false;
  for (const match of text.matchAll(IP_RATING)) {
    const digits = match[1];
    if (digits === undefined) continue;
    const value = toNumber(digits);
    if (value === undefined) continue;
    if (value === 69 && match[2] !== undefined) has69k = true;
    // Worst case is the honest reading. `IP 67 (carcasa), IP 65 (eje)` protects
    // to IP65 as an assembly; claiming 67 would sell a shaft seal that isn't
    // there. Same logic for `IP 67 e IP 69K`: 67 is what is guaranteed in the
    // general case, with the 69K capability recorded separately.
    if (lowest === undefined || value < lowest) lowest = value;
  }

  return { ipRating: lowest, ip69k: has69k ? true : undefined };
}

// ---------------------------------------------------------------------------
// sensor_principle + detection_principle + category → principle
// ---------------------------------------------------------------------------

/** Which catalog field a parsed `principle` actually came from. */
type PrincipleSource = "sensorPrinciple" | "detectionPrinciple" | "category" | undefined;

interface ParsedPrinciple {
  principle: SensingPrinciple | undefined;
  source: PrincipleSource;
}

function principleFromSensor(text: string): SensingPrinciple | undefined {
  if (text.includes("ultrasonid")) return "ultrasonic";
  if (text.includes("inductiv")) return "inductive";
  if (text.includes("capacitiv")) return "capacitive";
  if (text.includes("emisor-receptor") || text.includes("emisor receptor")) return "through-beam";
  if (text.includes("reflexion")) return "retroreflective";
  if (text.includes("deteccion sobre objeto")) return "diffuse";
  return undefined;
}

function principleFromDetection(text: string): SensingPrinciple | undefined {
  if (text.includes("supresion del fondo")) return "background-suppression";
  if (text.includes("supresion del primer plano")) return "foreground-suppression";
  // Autocollimation and double-lens optics are both retroreflective builds:
  // emitter and receiver sit in one housing aimed at a reflector.
  if (text.includes("autocolimacion")) return "retroreflective";
  if (text.includes("lente doble") || text.includes("doble lente")) return "retroreflective";
  if (text.includes("energetica")) return "diffuse";
  if (text.includes("inductiv")) return "inductive";
  return undefined;
}

/**
 * Catalog section → principle, used ONLY when neither principle field is
 * printed, and ONLY for sections whose name names exactly one principle.
 *
 * A value from here is an **inference from a section heading, not a printed
 * spec**. Callers get `source: "category"` so the solver can refuse to
 * disqualify a SKU on it, and it is always flagged low-confidence.
 *
 * Deliberately absent: *Fotocélulas*, *Sensores de proximidad*, *Sensores de
 * distancia*. Each mixes several principles (a proximity section holds
 * inductive *and* capacitive parts; a distance section holds laser *and*
 * ultrasonic). Picking the most common one would be a coin flip presented as a
 * fact.
 *
 * Also deliberately absent: *Dispositivos de protección optoelectrónicos*. That
 * section is the trap — it holds safety light curtains, single-beam barriers
 * (L21/L41) **and** laser scanners (S3000/S300). Mapping it to
 * `safety-light-curtain` made 161 SKUs claim a principle the page never states:
 * a laser scanner would then *pass* a light-curtain constraint and be *failed*
 * out of a laser-distance one. Both directions are fabricated evidence, which
 * is exactly the failure this module exists to prevent.
 *
 * Deliberately absent for the same reason: *Sensores de registro
 * (Registration/contrast sensors)*. The English gloss reads like a single
 * principle, but the section is mixed: alongside the contrast parts (KT5,
 * "Sensores de contraste") it files colour sensors ("Sensor de color con fuente
 * de luz RGB", and KTM Inox whose light type is "LED rojo, verde, azul"),
 * luminescence sensors ("Sensor de luminiscencia en carcasa miniatura") and ~29
 * fork sensors (WFM, "Sensores de horquilla") that are through-beam parts for
 * label detection. Mapping the section to `contrast` would hand every one of
 * those a principle its page never prints.
 */
function principleFromCategory(text: string): SensingPrinciple | undefined {
  if (text.includes("encoder")) return "encoder";
  if (text.includes("vision")) return "vision";
  if (text.includes("identificacion")) return "identification";
  if (text.includes("fluidos")) return "fluid";
  if (text.includes("interruptores de seguridad")) return "safety-switch";
  if (text.includes("control de seguridad")) return "safety-controller";
  if (text.includes("rejillas fotoelectricas")) return "light-grid";
  if (text.includes("magneticos para cilindros")) return "magnetic";
  return undefined;
}

function parsePrinciple(p: SickProduct): ParsedPrinciple {
  const fromSensor =
    p.sensorPrinciple !== undefined ? principleFromSensor(fold(p.sensorPrinciple)) : undefined;
  const fromDetection =
    p.detectionPrinciple !== undefined
      ? principleFromDetection(fold(p.detectionPrinciple))
      : undefined;

  if (fromSensor === undefined && fromDetection !== undefined) {
    return { principle: fromDetection, source: "detectionPrinciple" };
  }
  if (fromSensor !== undefined) {
    // The detection field only ever *refines* a diffuse sensor (into background
    // or foreground suppression). It must not override `through-beam` or
    // `retroreflective`, where an optics note like "lente doble" describes the
    // build, not a different sensing principle.
    if (
      fromSensor === "diffuse" &&
      (fromDetection === "background-suppression" || fromDetection === "foreground-suppression")
    ) {
      return { principle: fromDetection, source: "detectionPrinciple" };
    }
    return { principle: fromSensor, source: "sensorPrinciple" };
  }

  // Accessories inherit their section from the product they bolt onto — a USB
  // programmer filed under `Encoders` is not an encoder, and a reflector filed
  // under `Fotocélulas` senses nothing. Category fallback is for products only.
  if (p.rowType !== "product") return { principle: undefined, source: undefined };

  const fromCategory = principleFromCategory(fold(p.category));
  return fromCategory !== undefined
    ? { principle: fromCategory, source: "category" }
    : { principle: undefined, source: undefined };
}

// ---------------------------------------------------------------------------
// housing_material → housing
// ---------------------------------------------------------------------------

/** EN steel numbers (`1.4301`, `1.4404`, `1.4571`, `1.4305`) — all stainless. */
const EN_STAINLESS_NUMBER = /1\.4\d{3}/;
/** AISI grades printed alongside the EN number (`1.4301/304`, `316L/1.4404`). */
const AISI_STAINLESS_GRADE = /\b3(?:04|16)l?\b/;

/**
 * Housing material → one of three buckets.
 *
 * Order matters and encodes the *housing*, not the trim: `Carcasa de aluminio
 * con lente PPSU` is a metal-bodied sensor with a plastic window, and
 * `acero inoxidable 1.4404, PEI` is stainless with a plastic insert. Reading the
 * plastic first would classify a washdown stainless sensor as plastic and let it
 * lose a hygienic-design comparison it should win.
 *
 * Anything we cannot place stays `undefined`. `"other"` is reserved for a
 * material we positively recognize as none of the three — nothing in the 2015/16
 * catalog qualifies, so it is currently never emitted.
 */
function parseHousing(raw: string | undefined): NormalizedSpec["housing"] | undefined {
  if (raw === undefined) return undefined;
  const text = fold(raw);

  if (
    text.includes("inoxidable") ||
    EN_STAINLESS_NUMBER.test(text) ||
    AISI_STAINLESS_GRADE.test(text)
  ) {
    return "stainless-steel";
  }
  if (
    text.includes("aluminio") ||
    text.includes("metal") ||
    text.includes("laton") ||
    text.includes("acero") ||
    text.includes("cinc") ||
    text.includes("zinc")
  ) {
    return "metal";
  }
  if (
    text.includes("plastico") ||
    text.includes("abs") ||
    text.includes("pbt") ||
    text.includes("pvdf") ||
    text.includes("pmma") ||
    text.includes("ppsu") ||
    text.includes("pei") ||
    text.includes("pom") ||
    text.includes("tpu")
  ) {
    return "plastic";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// light_type → light
// ---------------------------------------------------------------------------

/**
 * Light source → canonical token.
 *
 * `laser` is checked first because it is a property of the *emitter*, and
 * `Láser rojo, clase 1` / `Láser infrarrojo, clase 1` differ from an LED of the
 * same colour in spot size, alignment tolerance and eye-safety class — the
 * things an engineer actually cross-references.
 *
 * Two honest-unknown cases worth knowing about:
 * - a bare `LED` states the emitter but no colour → `undefined`;
 * - a bicolour `LED rojo, verde` is neither `red` nor `green` nor `rgb`, and
 *   collapsing it to either would answer a colour question wrongly →
 *   `undefined`. The three-colour `LED rojo, verde, azul` *is* exactly `rgb`.
 */
function parseLight(raw: string | undefined): NormalizedSpec["light"] | undefined {
  if (raw === undefined) return undefined;
  const text = fold(raw);

  if (text.includes("laser")) return "laser";
  if (text.includes("infrarroj")) return "infrared";

  const red = text.includes("roj");
  const green = text.includes("verde");
  const blue = text.includes("azul");
  const white = text.includes("blanc");

  if (red && green && blue) return "rgb";
  if ([red, green, blue, white].filter(Boolean).length > 1) return undefined;
  if (red) return "red";
  if (green) return "green";
  if (white) return "white";
  if (/\buv\b/.test(text)) return "other";
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Project one catalog SKU onto the solver's machine-comparable view.
 *
 * Numeric fields are copied from the dataset's already-normalized columns;
 * categorical fields are parsed out of the verbatim Spanish. A property is
 * present only when the catalog states it and this module could read it with
 * confidence — see the module header for why that is stricter than it looks.
 *
 * `lowConfidence` carries the flag forward under the *normalized* field name:
 * the dataset flags `enclosure_rating` as read from prose, and the result flags
 * `ipRating` and `ip69k`, so the agent can tell the user which line of its
 * comparison table to double-check against the PDF page.
 */
export function normalizeSpec(p: SickProduct): NormalizedSpec {
  const flagged = new Set((p.lowConfidence ?? []).map(canonicalFieldName));
  const lowConfidence: string[] = [];
  /** Record `field` as low-confidence if any source cell it derived from was. */
  const flag = (field: string, ...sources: string[]): void => {
    if (!sources.some((s) => flagged.has(canonicalFieldName(s)))) return;
    if (!lowConfidence.includes(field)) lowConfidence.push(field);
  };

  const out = parseSwitchingOutput(p.switchingOutput);
  const conn = parseConnection(p.connection);
  const ip = parseEnclosureRating(p.enclosureRating);
  const { principle, source: principleSource } = parsePrinciple(p);
  const housing = parseHousing(p.housingMaterial);
  const light = parseLight(p.lightType);

  // The labelled numeric column wins over a value scraped out of the switching
  // text; they agree everywhere in this dataset, but the column came from a
  // table cell and the text did not.
  const outputCurrentMaxMa = p.outputCurrentMaxMa ?? out.outputCurrentMaxMa;
  const currentSources =
    p.outputCurrentMaxMa !== undefined ? ["outputCurrentMaxMa"] : ["switchingOutput"];

  // Flags are pushed in NormalizedSpec field order so the array is stable and
  // diffable across runs.
  if (out.outputType !== undefined) flag("outputType", "switchingOutput");
  if (out.ioLink !== undefined) flag("ioLink", "switchingOutput");
  if (out.outputCount !== undefined) flag("outputCount", "switchingOutput");
  if (outputCurrentMaxMa !== undefined) flag("outputCurrentMaxMa", ...currentSources);
  if (conn.connector !== undefined) flag("connector", "connection");
  if (conn.connectorPins !== undefined) flag("connectorPins", "connection");
  if (ip.ipRating !== undefined) flag("ipRating", "enclosureRating");
  if (ip.ip69k !== undefined) flag("ip69k", "enclosureRating");
  if (p.sensingRangeMinMm !== undefined) flag("sensingRangeMinMm", "sensingRangeMinMm");
  if (p.sensingRangeMaxMm !== undefined) flag("sensingRangeMaxMm", "sensingRangeMaxMm");
  if (p.responseTimeMs !== undefined) flag("responseTimeMs", "responseTimeMs");
  if (p.switchingFrequencyHz !== undefined) flag("switchingFrequencyHz", "switchingFrequencyHz");
  if (p.supplyVoltageMinV !== undefined) flag("supplyVoltageMinV", "supplyVoltageMinV");
  if (p.supplyVoltageMaxV !== undefined) flag("supplyVoltageMaxV", "supplyVoltageMaxV");
  if (p.operatingTempMinC !== undefined) flag("operatingTempMinC", "operatingTempMinC");
  if (p.operatingTempMaxC !== undefined) flag("operatingTempMaxC", "operatingTempMaxC");
  // A principle read off a printed field is flagged only if that source field
  // was itself low-confidence. A principle *inferred from the section heading*
  // is always low-confidence: nothing on the page states it, so `flag()`'s
  // source-field lookup would never fire and the inference would masquerade as
  // a printed spec.
  if (principle !== undefined && principleSource === "category") {
    lowConfidence.push("principle");
  } else if (principle !== undefined && principleSource !== undefined) {
    flag("principle", principleSource);
  }
  if (housing !== undefined) flag("housing", "housingMaterial");
  if (light !== undefined) flag("light", "lightType");

  return {
    orderNumber: p.orderNumber,
    ...(out.outputType !== undefined ? { outputType: out.outputType } : {}),
    ...(out.ioLink !== undefined ? { ioLink: out.ioLink } : {}),
    ...(out.outputCount !== undefined ? { outputCount: out.outputCount } : {}),
    ...(outputCurrentMaxMa !== undefined ? { outputCurrentMaxMa } : {}),
    ...(conn.connector !== undefined ? { connector: conn.connector } : {}),
    ...(conn.connectorPins !== undefined ? { connectorPins: conn.connectorPins } : {}),
    ...(ip.ipRating !== undefined ? { ipRating: ip.ipRating } : {}),
    ...(ip.ip69k !== undefined ? { ip69k: ip.ip69k } : {}),
    ...(p.sensingRangeMinMm !== undefined ? { sensingRangeMinMm: p.sensingRangeMinMm } : {}),
    ...(p.sensingRangeMaxMm !== undefined ? { sensingRangeMaxMm: p.sensingRangeMaxMm } : {}),
    ...(p.responseTimeMs !== undefined ? { responseTimeMs: p.responseTimeMs } : {}),
    ...(p.switchingFrequencyHz !== undefined
      ? { switchingFrequencyHz: p.switchingFrequencyHz }
      : {}),
    ...(p.supplyVoltageMinV !== undefined ? { supplyVoltageMinV: p.supplyVoltageMinV } : {}),
    ...(p.supplyVoltageMaxV !== undefined ? { supplyVoltageMaxV: p.supplyVoltageMaxV } : {}),
    ...(p.operatingTempMinC !== undefined ? { operatingTempMinC: p.operatingTempMinC } : {}),
    ...(p.operatingTempMaxC !== undefined ? { operatingTempMaxC: p.operatingTempMaxC } : {}),
    ...(principle !== undefined ? { principle } : {}),
    ...(principle !== undefined && principleSource !== undefined
      ? { principleSource }
      : {}),
    ...(housing !== undefined ? { housing } : {}),
    ...(light !== undefined ? { light } : {}),
    lowConfidence,
  };
}

/**
 * Normalize a whole catalog, preserving input order.
 *
 * Positional alignment with the `products` array is a load-bearing contract:
 * `SerializedIndex.specs` is aligned to `SerializedIndex.products`, so the index
 * writer must be able to hand this function its product list and store the
 * result without re-sorting it.
 */
export function normalizeAll(products: readonly SickProduct[]): NormalizedSpec[] {
  return products.map((p) => normalizeSpec(p));
}
