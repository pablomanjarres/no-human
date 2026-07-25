import type { Candidate, Citation, Constraint, CorpusStats, Part, SolveRun, SpecRow } from "@/lib/types";

/**
 * Scripted solve runs.
 *
 * These are fixtures, not mocks: every field is the exact shape the deterministic
 * solver emits, so `lib/engine.ts` can be repointed at the real solver without
 * touching a single component. Values carry honest confidence levels — where the
 * offline corpus is thin, the row says so rather than inventing a precise number.
 */

// --- citations -------------------------------------------------------------

const cite = (
  docId: string,
  docTitle: string,
  brand: string,
  page: number,
  snippet: string,
): Citation => ({ docId, docTitle, brand, page, href: `/console/doc/${docId}?page=${page}`, snippet });

const BANNER_QS18 = (page: number, snippet: string) =>
  cite("banner-qs18", "WORLD-BEAM QS18 — Datasheet 128140", "Banner", page, snippet);
const SICK_W4 = (page: number, snippet: string) =>
  cite("sick-w4", "W4 Photoelectric Sensors — Online Data Sheet", "SICK", page, snippet);
const SICK_W9 = (page: number, snippet: string) =>
  cite("sick-w9", "W9 Photoelectric Sensors — Online Data Sheet", "SICK", page, snippet);
const SICK_W12 = (page: number, snippet: string) =>
  cite("sick-w12", "W12-3 Photoelectric Sensors — Online Data Sheet", "SICK", page, snippet);
const PF_ML100 = (page: number, snippet: string) =>
  cite("pf-ml100", "ML100 Retroreflective — Datasheet 231456", "Pepperl+Fuchs", page, snippet);

const row = (
  key: string,
  label: string,
  value: string,
  unit: string,
  citation: Citation,
  extra: Partial<SpecRow> = {},
): SpecRow => ({ key, label, value, unit, confidence: "high", citation, ...extra });

// --- parts -----------------------------------------------------------------

const qs18: Part = {
  id: "banner-qs18vn6lv",
  brand: "Banner",
  partNumber: "QS18VN6LV",
  family: "WORLD-BEAM QS18",
  orderNumber: "42798",
  principle: "Diffuse, background suppression",
  blurb:
    "Compact rectangular diffuse sensor with a visible red emitter. The workhorse on packaging lines across the region — which is exactly why it turns up in every migration request.",
  dims: { l: 32, w: 12, h: 21 },
  form: "rect",
  specs: [
    row("sensing_mode", "Sensing mode", "Diffuse, background suppression", "—", BANNER_QS18(1, "Sensing mode: diffuse with fixed-field background suppression")),
    row("sensing_range_max_mm", "Sensing range", "400", "mm", BANNER_QS18(2, "Range: 400 mm (90% reflectance white test card)"), { numeric: 400 }),
    row("output_type", "Output type", "NPN", "—", BANNER_QS18(2, "Output: NPN (current sinking)")),
    row("output_config", "Output configuration", "Light/dark programmable", "—", BANNER_QS18(2, "Programmable light operate / dark operate")),
    row("response_time_ms", "Response time", "1.0", "ms", BANNER_QS18(2, "Output response time: 1 millisecond"), { numeric: 1.0 }),
    row("supply_voltage", "Supply voltage", "10 … 30", "V DC", BANNER_QS18(2, "Supply voltage: 10 to 30V dc")),
    row("light_source", "Light source", "Visible red 660 nm", "nm", BANNER_QS18(2, "Visible red LED, 660 nm")),
    row("connection", "Connection", "M12 4-pin, A-coded", "—", BANNER_QS18(3, "4-pin M12 quick-disconnect")),
    row("ip_rating", "Enclosure rating", "IP67", "—", BANNER_QS18(3, "IEC IP67"), { numeric: 67 }),
    row("housing_material", "Housing material", "ABS/polycarbonate", "—", BANNER_QS18(3, "Housing: ABS/polycarbonate blend"), {
      confidence: "medium",
      dispute: {
        extracted: "ABS/polycarbonate",
        verified: "Polycarbonate only",
        note: "Extractor read a family-level table on p.3. Verifier found the model-specific note on p.7 listing polycarbonate. Flagged, not averaged.",
      },
    }),
    row("ambient_temp_min", "Ambient temperature", "−20 … +70", "°C", BANNER_QS18(3, "Operating: −20°C to +70°C"), { numeric: -20 }),
    row("width_mm", "Housing width", "12", "mm", BANNER_QS18(4, "Dimensional drawing: 12 mm across the mounting face"), { numeric: 12 }),
  ],
};

const wtb4: Part = {
  id: "sick-wtb4-3n2261",
  brand: "SICK",
  partNumber: "WTB4-3N2261",
  family: "W4 Photoelectric",
  orderNumber: "1041985",
  principle: "Diffuse, background suppression",
  blurb: "The smallest housing SICK ships with background suppression. First choice on footprint alone.",
  dims: { l: 32, w: 11, h: 20 },
  form: "rect",
  replaces: ["Banner QS18 series", "Keyence PZ-G series"],
  specs: [
    row("sensing_mode", "Sensing mode", "Diffuse, background suppression", "—", SICK_W4(1, "Sensing mode: energetic / background suppression")),
    row("sensing_range_max_mm", "Sensing range", "600", "mm", SICK_W4(2, "Sensing range max.: 600 mm, 90% reflectance"), { numeric: 600 }),
    row("output_type", "Output type", "NPN", "—", SICK_W4(2, "Output: NPN, 100 mA")),
    row("response_time_ms", "Response time", "1.0", "ms", SICK_W4(2, "Response time: ≤ 1 ms"), { numeric: 1.0 }),
    row("connection", "Connection", "M12 4-pin, A-coded", "—", SICK_W4(3, "Connection type: male connector M12, 4-pin")),
    row("ip_rating", "Enclosure rating", "IP67", "—", SICK_W4(3, "Enclosure rating: IP67"), { numeric: 67 }),
    row("width_mm", "Housing width", "11", "mm", SICK_W4(4, "Dimensional drawing: 11 mm"), { numeric: 11 }),
  ],
};

const wtb9: Part = {
  id: "sick-wtb9-3n2161",
  brand: "SICK",
  partNumber: "WTB9-3N2161",
  family: "W9 Photoelectric",
  orderNumber: "1052653",
  principle: "Diffuse, background suppression",
  blurb:
    "A step up in optical budget from the W4 in a housing only three millimetres wider. The part you reach for when the target is dark and the background is close.",
  dims: { l: 42, w: 15, h: 27 },
  form: "rect",
  replaces: ["Banner QS18 series", "Banner Q45 series", "Pepperl+Fuchs OBT series"],
  specs: [
    row("sensing_mode", "Sensing mode", "Diffuse, background suppression", "—", SICK_W9(1, "Sensing mode: background suppression")),
    row("sensing_range_max_mm", "Sensing range", "700", "mm", SICK_W9(2, "Sensing range max.: 700 mm, 90% reflectance"), { numeric: 700 }),
    row("sensing_range_black_mm", "Range, 6% black", "420", "mm", SICK_W9(2, "6% remission: 420 mm"), { numeric: 420 }),
    row("output_type", "Output type", "NPN", "—", SICK_W9(2, "Output: NPN, 100 mA")),
    row("output_config", "Output configuration", "Light/dark switchable", "—", SICK_W9(2, "Light/dark switching, teach-in")),
    row("response_time_ms", "Response time", "1.5", "ms", SICK_W9(2, "Response time: ≤ 1.5 ms"), { numeric: 1.5 }),
    row("supply_voltage", "Supply voltage", "10 … 30", "V DC", SICK_W9(2, "Supply voltage V_S: 10 V DC … 30 V DC")),
    row("light_source", "Light source", "Visible red 655 nm", "nm", SICK_W9(2, "Light source: PinPoint LED, red, 655 nm")),
    row("connection", "Connection", "M12 4-pin, A-coded", "—", SICK_W9(3, "Connection type: male connector M12, 4-pin")),
    row("ip_rating", "Enclosure rating", "IP67", "—", SICK_W9(3, "Enclosure rating: IP67"), { numeric: 67 }),
    row("housing_material", "Housing material", "ABS", "—", SICK_W9(3, "Housing material: ABS")),
    row("ambient_temp_min", "Ambient temperature", "−30 … +60", "°C", SICK_W9(3, "Ambient operating temperature: −30 °C … +60 °C"), { numeric: -30 }),
    row("width_mm", "Housing width", "15", "mm", SICK_W9(4, "Dimensional drawing: 15.0 mm"), { numeric: 15 }),
  ],
};

const wtb12: Part = {
  id: "sick-wtb12-3n2431",
  brand: "SICK",
  partNumber: "WTB12-3N2431",
  family: "W12-3 Photoelectric",
  orderNumber: "1041274",
  principle: "Diffuse, background suppression",
  blurb: "More range and more housing. Passes every constraint but costs 8 mm of panel width.",
  dims: { l: 50, w: 20, h: 32 },
  form: "rect",
  replaces: ["Banner Q45 series", "Pepperl+Fuchs ML100 series"],
  specs: [
    row("sensing_range_max_mm", "Sensing range", "1 100", "mm", SICK_W12(2, "Sensing range max.: 1,100 mm"), { numeric: 1100 }),
    row("response_time_ms", "Response time", "2.0", "ms", SICK_W12(2, "Response time: ≤ 2 ms"), { numeric: 2.0 }),
    row("output_type", "Output type", "NPN", "—", SICK_W12(2, "Output: NPN")),
    row("connection", "Connection", "M12 4-pin, A-coded", "—", SICK_W12(3, "M12, 4-pin")),
    row("ip_rating", "Enclosure rating", "IP67", "—", SICK_W12(3, "IP67"), { numeric: 67 }),
    row("width_mm", "Housing width", "20", "mm", SICK_W12(4, "20 mm"), { numeric: 20 }),
  ],
};

const ml100: Part = {
  id: "pf-ml100-8-1000-rt",
  brand: "Pepperl+Fuchs",
  partNumber: "ML100-8-1000-RT/95/103",
  family: "ML100",
  principle: "Retroreflective, polarised",
  blurb:
    "A base part with two option codes appended. The base maps cleanly. The option codes are the problem — and the reason this run ends in a refusal.",
  dims: { l: 42, w: 15, h: 30 },
  form: "rect",
  specs: [
    row("sensing_mode", "Sensing mode", "Retroreflective, polarised", "—", PF_ML100(1, "Polarised retroreflective sensor")),
    row("sensing_range_max_mm", "Sensing range", "1 000", "mm", PF_ML100(2, "Operating range: 0 … 1,000 mm"), { numeric: 1000 }),
    row("output_type", "Output type", "PNP", "—", PF_ML100(2, "Output type: PNP")),
    row("response_time_ms", "Response time", "0.3", "ms", PF_ML100(2, "Response time: 300 µs"), { numeric: 0.3 }),
    row("connection", "Connection", "M12 4-pin, A-coded", "—", PF_ML100(3, "Connection: M12 × 1, 4-pin")),
    row("ip_rating", "Enclosure rating", "IP67", "—", PF_ML100(3, "Degree of protection: IP67"), { numeric: 67 }),
    row("option_95", "Option code /95", "Not documented in corpus", "—", PF_ML100(1, "Model key: ML100-8-1000-RT/95/103"), {
      confidence: "low",
    }),
    row("option_103", "Option code /103", "Not documented in corpus", "—", PF_ML100(1, "Model key: ML100-8-1000-RT/95/103"), {
      confidence: "low",
    }),
  ],
};

// --- constraints -----------------------------------------------------------

const k = (
  key: string,
  label: string,
  display: string,
  criticality: Constraint["criticality"],
  origin: Constraint["origin"],
  rationale: string,
  extra: Partial<Constraint> = {},
): Constraint => ({
  key,
  label,
  display,
  criticality,
  origin,
  rationale,
  kind: "numeric-min",
  unit: "—",
  ...extra,
});

const qs18Constraints: Constraint[] = [
  k("sensing_mode", "Sensing mode", "background suppression", "hard", "extracted", "A diffuse sensor without background suppression will latch on the conveyor frame behind the target.", { kind: "enum", enumValue: "bgs" }),
  k("sensing_range_max_mm", "Sensing range", "≥ 400 mm", "hard", "extracted", "The replacement must reach at least as far as the part it replaces, or the mounting bracket has to move.", { kind: "numeric-min", unit: "mm", min: 400 }),
  k("output_type", "Output type", "NPN", "hard", "extracted", "The PLC input card is already wired. PNP into a sinking input does not switch.", { kind: "enum", enumValue: "NPN" }),
  k("response_time_ms", "Response time", "≤ 1.0 ms", "soft", "extracted", "Slower is tolerable if the line speed leaves margin — but it must be reported, not absorbed.", { kind: "numeric-max", unit: "ms", max: 1.0 }),
  k("supply_voltage", "Supply voltage", "10 … 30 V DC", "hard", "extracted", "Existing 24 V DC panel supply.", { kind: "numeric-window", unit: "V", min: 10, max: 30 }),
  k("connection", "Connection", "M12 4-pin A-coded", "hard", "extracted", "Cordsets are already run and terminated. A flying-lead variant means re-pulling cable.", { kind: "enum", enumValue: "M12-4" }),
  k("ip_rating", "Enclosure rating", "≥ IP67", "hard", "extracted", "Packaging hall, periodic washdown.", { kind: "numeric-min", min: 67 }),
  k("output_config", "Output configuration", "light/dark selectable", "soft", "extracted", "A fixed-polarity output can usually be inverted in the PLC, at the cost of a logic change.", { kind: "enum", enumValue: "selectable" }),
  k("ambient_temp_min", "Ambient temperature", "≤ −20 °C", "soft", "extracted", "Matches the original rating. Rionegro never sees this, but the spec travels with the part.", { kind: "numeric-max", unit: "°C", max: -20 }),
  k("width_mm", "Housing width", "≤ 16 mm", "soft", "assumed", "ASSUMED from the original 12 mm housing plus typical bracket slop. Confirm against the machine before ordering.", { kind: "numeric-max", unit: "mm", max: 16 }),
  k("target_remission", "Target remission", "6% (black)", "hard", "asked", "Answered by the operator: the target is a black rubber-lined crate, not a white carton.", { kind: "enum", enumValue: "6pct" }),
];

// --- evaluations -----------------------------------------------------------

const pass = (
  key: string,
  label: string,
  candidateValue: string,
  sourceValue: string,
  citation: Citation,
  extra: Partial<Candidate["evaluations"][number]> = {},
) => ({
  key,
  label,
  status: "pass" as const,
  criticality: "hard" as const,
  candidateValue,
  sourceValue,
  citation,
  ...extra,
});

const wtb9Evaluations: Candidate["evaluations"] = [
  pass("sensing_mode", "Sensing mode", "Background suppression", "Background suppression", SICK_W9(1, "Sensing mode: background suppression")),
  pass("sensing_range_max_mm", "Sensing range", "700 mm", "400 mm", SICK_W9(2, "Sensing range max.: 700 mm, 90% reflectance"), {
    delta: "+300 mm",
    rail: { scaleMin: 0, scaleMax: 1200, bandStart: 400, bandEnd: 1200, candidate: 700, source: 400 },
  }),
  pass("sensing_range_black_mm", "Range at 6% black", "420 mm", "400 mm", SICK_W9(2, "6% remission: 420 mm"), {
    delta: "+20 mm",
    note: "The constraint that killed rank 1. Margin here is thin — 20 mm. Mount with the bracket at its near limit.",
    rail: { scaleMin: 0, scaleMax: 1200, bandStart: 400, bandEnd: 1200, candidate: 420, source: 400 },
  }),
  pass("output_type", "Output type", "NPN", "NPN", SICK_W9(2, "Output: NPN, 100 mA")),
  {
    key: "response_time_ms",
    label: "Response time",
    status: "loss",
    criticality: "soft",
    candidateValue: "1.5 ms",
    sourceValue: "1.0 ms",
    delta: "+0.5 ms",
    note: "At 1.2 m/s belt speed this shifts the switch point 0.6 mm downstream. Below the 5 mm gap between crates, so it does not merge targets.",
    citation: SICK_W9(2, "Response time: ≤ 1.5 ms"),
    rail: { scaleMin: 0, scaleMax: 3, bandStart: 0, bandEnd: 1.0, candidate: 1.5, source: 1.0 },
  },
  pass("supply_voltage", "Supply voltage", "10 … 30 V DC", "10 … 30 V DC", SICK_W9(2, "Supply voltage V_S: 10 V DC … 30 V DC")),
  pass("connection", "Connection", "M12 4-pin A-coded", "M12 4-pin A-coded", SICK_W9(3, "Connection type: male connector M12, 4-pin"), {
    note: "Pin 4 carries the switching output on both parts. The existing cordset drops straight on.",
  }),
  pass("ip_rating", "Enclosure rating", "IP67", "IP67", SICK_W9(3, "Enclosure rating: IP67")),
  pass("output_config", "Output configuration", "Light/dark switchable", "Light/dark programmable", SICK_W9(2, "Light/dark switching, teach-in"), {
    criticality: "soft",
  }),
  pass("ambient_temp_min", "Ambient temperature", "−30 °C", "−20 °C", SICK_W9(3, "Ambient operating temperature: −30 °C … +60 °C"), {
    criticality: "soft",
    delta: "−10 °C colder",
    rail: { scaleMin: -40, scaleMax: 20, bandStart: -40, bandEnd: -20, candidate: -30, source: -20 },
  }),
  {
    key: "width_mm",
    label: "Housing width",
    status: "loss",
    criticality: "soft",
    candidateValue: "15 mm",
    sourceValue: "12 mm",
    delta: "+3 mm",
    note: "Assumed constraint was ≤ 16 mm. It fits, but the assumption was ours — measure the bracket.",
    citation: SICK_W9(4, "Dimensional drawing: 15.0 mm"),
    rail: { scaleMin: 0, scaleMax: 30, bandStart: 0, bandEnd: 16, candidate: 15, source: 12 },
  },
];

const wtb4Evaluations: Candidate["evaluations"] = [
  pass("sensing_mode", "Sensing mode", "Background suppression", "Background suppression", SICK_W4(1, "Sensing mode: energetic / background suppression")),
  {
    key: "sensing_range_max_mm",
    label: "Sensing range",
    status: "fail",
    criticality: "hard",
    candidateValue: "250 mm at 6% black",
    sourceValue: "400 mm required",
    delta: "−150 mm",
    note: "The 600 mm figure in the spec row is quoted against a 90% white card. The challenger re-read the source and found the derating table.",
    citation: SICK_W4(2, "Sensing range max.: 600 mm, 90% reflectance"),
    rail: { scaleMin: 0, scaleMax: 1200, bandStart: 400, bandEnd: 1200, candidate: 250, source: 400 },
  },
  pass("output_type", "Output type", "NPN", "NPN", SICK_W4(2, "Output: NPN, 100 mA")),
  pass("response_time_ms", "Response time", "1.0 ms", "1.0 ms", SICK_W4(2, "Response time: ≤ 1 ms"), { criticality: "soft" }),
  pass("connection", "Connection", "M12 4-pin A-coded", "M12 4-pin A-coded", SICK_W4(3, "Connection type: male connector M12, 4-pin")),
  pass("ip_rating", "Enclosure rating", "IP67", "IP67", SICK_W4(3, "Enclosure rating: IP67")),
  pass("width_mm", "Housing width", "11 mm", "12 mm", SICK_W4(4, "Dimensional drawing: 11 mm"), { criticality: "soft", delta: "−1 mm" }),
];

const wtb12Evaluations: Candidate["evaluations"] = [
  pass("sensing_range_max_mm", "Sensing range", "1 100 mm", "400 mm", SICK_W12(2, "Sensing range max.: 1,100 mm"), {
    delta: "+700 mm",
    rail: { scaleMin: 0, scaleMax: 1200, bandStart: 400, bandEnd: 1200, candidate: 1100, source: 400 },
  }),
  pass("output_type", "Output type", "NPN", "NPN", SICK_W12(2, "Output: NPN")),
  {
    key: "response_time_ms",
    label: "Response time",
    status: "loss",
    criticality: "soft",
    candidateValue: "2.0 ms",
    sourceValue: "1.0 ms",
    delta: "+1.0 ms",
    citation: SICK_W12(2, "Response time: ≤ 2 ms"),
    rail: { scaleMin: 0, scaleMax: 3, bandStart: 0, bandEnd: 1.0, candidate: 2.0, source: 1.0 },
  },
  pass("connection", "Connection", "M12 4-pin A-coded", "M12 4-pin A-coded", SICK_W12(3, "M12, 4-pin")),
  pass("ip_rating", "Enclosure rating", "IP67", "IP67", SICK_W12(3, "IP67")),
  {
    key: "width_mm",
    label: "Housing width",
    status: "loss",
    criticality: "soft",
    candidateValue: "20 mm",
    sourceValue: "12 mm",
    delta: "+8 mm",
    note: "Exceeds the assumed 16 mm bracket window. Would need a new bracket.",
    citation: SICK_W12(4, "20 mm"),
    rail: { scaleMin: 0, scaleMax: 30, bandStart: 0, bandEnd: 16, candidate: 20, source: 12 },
  },
];

// --- run 1: the flagship. Rank 1 dies, rank 2 promotes. --------------------

export const runQs18: SolveRun = {
  id: "run-qs18",
  label: "Banner QS18VN6LV",
  input: { mode: "part", raw: "QS18VN6LV" },
  source: qs18,
  constraints: qs18Constraints,
  candidates: [
    {
      rank: 1,
      part: wtb4,
      score: 0.94,
      evaluations: wtb4Evaluations,
      verdict: "rejected",
      killedBy: "atk-1",
      losses: [],
    },
    {
      rank: 2,
      part: wtb9,
      score: 0.89,
      evaluations: wtb9Evaluations,
      verdict: "equivalent-with-losses",
      losses: [
        "0.5 ms slower to switch — 1.5 ms against 1.0 ms.",
        "3 mm wider across the mounting face.",
        "20 mm of range margin at 6% remission. Thin, but positive.",
      ],
    },
    {
      rank: 3,
      part: wtb12,
      score: 0.81,
      evaluations: wtb12Evaluations,
      verdict: "equivalent-with-losses",
      losses: ["1.0 ms slower.", "8 mm wider — needs a new bracket."],
    },
  ],
  attacks: [
    {
      id: "atk-1",
      targetRank: 1,
      targetPart: "WTB4-3N2261",
      claim: "The 600 mm sensing range is quoted against a 90% white test card. This application is a black rubber-lined crate.",
      evidence:
        "Datasheet p.2 derating table: at 6% remission the W4 background-suppression range falls to 250 mm. The hard constraint is 400 mm. This part cannot see the target.",
      citation: SICK_W4(2, "Remission 6%: sensing range 250 mm"),
      severity: "hard",
      outcome: "kill",
    },
    {
      id: "atk-2",
      targetRank: 2,
      targetPart: "WTB9-3N2161",
      claim: "Response time is 50% slower than the part being replaced. On a moving belt that displaces the switch point.",
      evidence:
        "1.5 ms against 1.0 ms at 1.2 m/s displaces the switch point by 0.6 mm. Crate spacing is 5 mm. Targets do not merge. Reported as a loss, not a kill.",
      citation: SICK_W9(2, "Response time: ≤ 1.5 ms"),
      severity: "soft",
      outcome: "survived",
    },
    {
      id: "atk-3",
      targetRank: 2,
      targetPart: "WTB9-3N2161",
      claim: "M12 connectors are not automatically interchangeable — pin-out differs between manufacturers.",
      evidence:
        "Both parts are 4-pin A-coded with the switching output on pin 4 and 0 V on pin 3. The installed cordset transfers without rework.",
      citation: SICK_W9(3, "Pin 1: L+, Pin 3: M, Pin 4: Q"),
      severity: "hard",
      outcome: "survived",
    },
    {
      id: "atk-4",
      targetRank: 2,
      targetPart: "WTB9-3N2161",
      claim: "The housing material row on the source part is disputed between the extractor and the verifier.",
      evidence:
        "Banner p.3 says ABS/polycarbonate, p.7 says polycarbonate. The constraint set does not include housing material, so the dispute does not affect this match. Surfaced anyway.",
      citation: BANNER_QS18(7, "Housing: polycarbonate"),
      severity: "informational",
      outcome: "survived",
    },
  ],
  trace: [
    { id: "t1", at: 0, agent: "resolver", title: "Input classified", detail: "Matched Banner part-number grammar QS18[V|IR][N|P]6[suffix].", status: "ok", chips: ["mode: part number", "brand: Banner"] },
    { id: "t2", at: 120, agent: "resolver", title: "Corpus lookup", tool: { name: "corpus.lookup", args: '{"partNumber":"QS18VN6LV"}', result: "1 exact hit · banner-qs18 · 12 spec rows" }, status: "ok" },
    { id: "t3", at: 260, agent: "resolver", title: "Underspecified: target remission", detail: "Background-suppression range is remission-dependent. The datasheet cannot tell us what the sensor is pointed at. Asked the operator rather than assuming white.", status: "warn" },
    { id: "t4", at: 340, agent: "resolver", title: "Constraint set emitted", detail: "11 constraints — 9 extracted, 1 answered, 1 assumed. The assumed one is flagged on screen.", status: "ok", chips: ["7 hard", "4 soft"] },
    { id: "t5", at: 410, agent: "solver", title: "Hard filter", tool: { name: "solver.filter", args: '{"constraints":7,"catalogue":1204}', result: "1204 → 6 survivors" }, status: "ok" },
    { id: "t6", at: 520, agent: "solver", title: "Ranked by soft-constraint distance", detail: "Weighted L1 distance over the 4 soft constraints. No model involved.", status: "ok", chips: ["WTB4 0.94", "WTB9 0.89", "WTB12 0.81"] },
    { id: "t7", at: 610, agent: "challenger", title: "Attacking rank 1 — WTB4-3N2261", detail: "Re-reading the source datasheet for anything the spec row flattened.", status: "warn" },
    { id: "t8", at: 980, agent: "challenger", title: "Killed rank 1", detail: "600 mm is a 90%-white figure. At 6% remission the W4 reaches 250 mm. Hard constraint is 400 mm.", status: "halt" },
    { id: "t9", at: 1180, agent: "solver", title: "Rank 2 promoted", detail: "WTB9-3N2161 becomes the proposed equivalent.", status: "ok" },
    { id: "t10", at: 1320, agent: "challenger", title: "3 further attacks — all survived", detail: "Response time, M12 pin-out, and the open housing-material dispute.", status: "ok" },
    { id: "t11", at: 1490, agent: "solver", title: "Verdict: equivalent with 3 named losses", status: "ok", chips: ["every row cited"] },
  ],
  thread: [
    { id: "m1", role: "user", at: 0, text: "QS18VN6LV" },
    {
      id: "m2",
      role: "agent",
      at: 340,
      agent: "resolver",
      text: "That is a Banner WORLD-BEAM QS18 — diffuse with background suppression, NPN output, 400 mm, M12. I read 11 constraints out of the datasheet. One of them I had to assume, and one I cannot get from any datasheet.",
      did: ["corpus.lookup → 1 exact hit, 12 spec rows", "11 constraints emitted — 7 hard, 4 soft", "1 constraint marked assumed: housing width ≤ 16 mm"],
      chips: ["background suppression", "≥ 400 mm", "NPN", "M12 4-pin", "≥ IP67", "10 … 30 V DC", "≤ 1.0 ms"],
    },
    {
      id: "m3",
      role: "question",
      at: 380,
      agent: "resolver",
      text: "What is the sensor pointed at?",
      why: "Background-suppression range is quoted against a 90% white card. On a dark target the same sensor reaches roughly a third as far. If I guess white here and you are running black crates, I will hand you a part that cannot see them.",
      options: [
        { label: "Black rubber-lined crate", value: "6pct", effect: "Range constraint recomputed at 6% remission" },
        { label: "Brown corrugated carton", value: "20pct", effect: "Range constraint recomputed at 20% remission" },
        { label: "White carton or bright plastic", value: "90pct", effect: "Range constraint stays at the datasheet figure" },
        { label: "Mixed — worst case", value: "6pct", effect: "Solver takes the darkest target as the binding constraint" },
      ],
    },
    { id: "m4", role: "user", at: 520, text: "Black rubber-lined crate." },
    {
      id: "m5",
      role: "agent",
      at: 980,
      agent: "challenger",
      tone: "halt",
      text: "That answer just killed my first candidate. The WTB4-3N2261 is the obvious pick on footprint and it scored highest — but its 600 mm range is a white-card figure. At 6% remission it reaches 250 mm and your constraint is 400 mm. It would have failed on the machine, not on paper.",
      did: ["Re-read sick-w4 p.2 derating table", "250 mm < 400 mm → hard constraint violated", "Rank 1 rejected, rank 2 promoted"],
      citations: [SICK_W4(2, "Remission 6%: sensing range 250 mm")],
    },
    {
      id: "m6",
      role: "agent",
      at: 1490,
      agent: "solver",
      tone: "caution",
      text: "WTB9-3N2161, SICK order number 1052653. It clears all seven hard constraints and costs you three things: 0.5 ms of response time, 3 mm of width, and it leaves only 20 mm of range margin on the black crate. Every row on the left is clickable — both datasheets, page and line.",
      did: ["7/7 hard constraints satisfied", "3 soft constraints degraded — all quantified", "3 challenger attacks survived"],
      citations: [SICK_W9(2, "Sensing range max.: 700 mm, 90% reflectance"), SICK_W9(3, "Connection type: male connector M12, 4-pin")],
    },
  ],
  outcome: "match-with-losses",
  promotion: { at: 980, fromRank: 1, toRank: 2 },
  stats: { catalogue: 1204, afterConstraints: 6, survived: 2, durationMs: 1490 },
};

// --- run 2: the deliberate refusal ----------------------------------------

export const runMl100: SolveRun = {
  id: "run-ml100",
  label: "Pepperl+Fuchs ML100-8-1000-RT/95/103",
  input: { mode: "part", raw: "ML100-8-1000-RT/95/103" },
  source: ml100,
  constraints: [
    k("sensing_mode", "Sensing mode", "polarised retroreflective", "hard", "extracted", "Clear-object detection depends on the polarising filter.", { kind: "enum", enumValue: "retro-pol" }),
    k("sensing_range_max_mm", "Sensing range", "≥ 1 000 mm", "hard", "extracted", "Reflector is already mounted at 1 m.", { kind: "numeric-min", unit: "mm", min: 1000 }),
    k("output_type", "Output type", "PNP", "hard", "extracted", "Sourcing input card.", { kind: "enum", enumValue: "PNP" }),
    k("response_time_ms", "Response time", "≤ 0.3 ms", "soft", "extracted", "300 µs on the original. Fast for a retroreflective.", { kind: "numeric-max", unit: "ms", max: 0.3 }),
    k("connection", "Connection", "M12 4-pin A-coded", "hard", "extracted", "Cordset already terminated.", { kind: "enum", enumValue: "M12-4" }),
    k("option_95", "Option code /95", "unknown", "hard", "extracted", "Present in the model key. Not documented in the datasheet we hold. We do not know what it changes.", { kind: "text" }),
    k("option_103", "Option code /103", "unknown", "hard", "extracted", "Same. Two undocumented modifications to a part we are being asked to replace.", { kind: "text" }),
  ],
  candidates: [],
  attacks: [
    {
      id: "atk-r1",
      targetRank: 1,
      targetPart: "WL12-3P2431",
      claim: "The closest SICK part is 1.2 ms slower and the in-stock variant is not M12.",
      evidence:
        "W12-3 retroreflective response time is 1.5 ms against 300 µs. The M12 variant exists but is not in the offline corpus, so we cannot cite it.",
      citation: SICK_W12(2, "Response time: ≤ 1.5 ms"),
      severity: "soft",
      outcome: "kill",
    },
    {
      id: "atk-r2",
      targetRank: 1,
      targetPart: "WL12-3P2431",
      claim: "Two option codes on the source part are undocumented. Any equivalence claim is unsourced.",
      evidence:
        "/95 and /103 appear in the model key but in no page of the datasheet we hold. They could be a cable length, a different optic, or a factory-set threshold. We refuse rather than guess.",
      citation: PF_ML100(1, "Model key: ML100-8-1000-RT/95/103"),
      severity: "hard",
      outcome: "kill",
    },
  ],
  trace: [
    { id: "r1", at: 0, agent: "resolver", title: "Input classified", detail: "Pepperl+Fuchs model key with two appended option codes.", status: "ok", chips: ["mode: part number", "brand: Pepperl+Fuchs"] },
    { id: "r2", at: 140, agent: "resolver", title: "Corpus lookup", tool: { name: "corpus.lookup", args: '{"partNumber":"ML100-8-1000-RT/95/103"}', result: "base part matched · 2 option codes unresolved" }, status: "warn" },
    { id: "r3", at: 300, agent: "resolver", title: "Two constraints cannot be valued", detail: "/95 and /103 are in the model key and in no datasheet page we hold.", status: "warn" },
    { id: "r4", at: 420, agent: "solver", title: "Hard filter", tool: { name: "solver.filter", args: '{"constraints":5,"catalogue":1204}', result: "1204 → 3 survivors on the base spec" }, status: "ok" },
    { id: "r5", at: 560, agent: "challenger", title: "Attacking rank 1 — WL12-3P2431", status: "warn" },
    { id: "r6", at: 890, agent: "challenger", title: "Response time 5× slower", detail: "1.5 ms against 300 µs. On clear-object detection at speed that is a real miss risk.", status: "halt" },
    { id: "r7", at: 1120, agent: "challenger", title: "Undocumented option codes", detail: "No page in the corpus describes /95 or /103. An equivalence claim here would be unsourced.", status: "halt" },
    { id: "r8", at: 1340, agent: "solver", title: "Refusing", detail: "No candidate can be claimed equivalent from the sources we hold.", status: "halt" },
  ],
  thread: [
    { id: "rm1", role: "user", at: 0, text: "ML100-8-1000-RT/95/103" },
    {
      id: "rm2",
      role: "agent",
      at: 300,
      agent: "resolver",
      tone: "caution",
      text: "I have the base part — ML100, polarised retroreflective, 1 m, PNP, 300 µs. What I do not have is /95 or /103. Those two codes are in the model key and on no page of the datasheet in our corpus.",
      did: ["Base part matched — 6 spec rows", "2 option codes unresolved", "5 of 7 constraints valued"],
      chips: ["polarised retro", "≥ 1 000 mm", "PNP", "≤ 0.3 ms", "M12 4-pin", "/95 unknown", "/103 unknown"],
    },
    {
      id: "rm3",
      role: "agent",
      at: 1340,
      agent: "challenger",
      tone: "halt",
      text: "No equivalent I can defend. The closest is WL12-3P2431, and it costs you two things I can source and one I cannot. It is 1.2 ms slower — 1.5 ms against your 300 µs, which on clear-object detection at line speed is a real miss risk. The in-stock variant ships on a 2 m cable, not M12, so the cordset has to be re-pulled. And the two option codes could be a different optic or a factory-set threshold; I will not call it equivalent when I cannot read what it changes. Send me the P+F configuration sheet for /95 and /103 and I will run it again.",
      did: ["3 candidates passed the base-spec filter", "All 3 killed by the challenger", "Refusing rather than guessing"],
      citations: [SICK_W12(2, "Response time: ≤ 1.5 ms"), PF_ML100(1, "Model key: ML100-8-1000-RT/95/103")],
    },
  ],
  outcome: "refusal",
  refusal: {
    headline: "No equivalent we can source.",
    closest: "WL12-3P2431",
    losses: [
      "1.2 ms slower — 1.5 ms against 300 µs. On clear-object detection at line speed that is a real miss risk.",
      "The in-stock variant ships on a 2 m cable, not M12. The cordset has to be re-pulled.",
      "Option codes /95 and /103 are undocumented in our corpus. We do not know what they change, so we will not claim equivalence.",
    ],
  },
  stats: { catalogue: 1204, afterConstraints: 3, survived: 0, durationMs: 1340 },
};

// --- run 3: the consultant path — a description, and a question back ------

export const runDescribe: SolveRun = {
  id: "run-describe",
  label: "Plain description",
  input: { mode: "describe", raw: "Necesito detectar cajas negras sobre una banda transportadora" },
  source: qs18,
  constraints: [
    k("sensing_mode", "Sensing mode", "background suppression", "hard", "default", "A dark target on a conveyor is the textbook case for background suppression.", { kind: "enum", enumValue: "bgs" }),
    k("target_remission", "Target remission", "6% (black)", "hard", "extracted", "Stated: black boxes.", { kind: "enum", enumValue: "6pct" }),
    k("sensing_range_max_mm", "Sensing range", "unknown", "hard", "asked", "Nothing in the description says how far the sensor sits from the belt. This is the binding constraint and I will not assume it.", { kind: "numeric-min", unit: "mm" }),
  ],
  candidates: [],
  attacks: [],
  trace: [
    { id: "d1", at: 0, agent: "resolver", title: "Input classified", detail: "Free-text description, Spanish. No part number present.", status: "ok", chips: ["mode: describe", "lang: es"] },
    { id: "d2", at: 180, agent: "resolver", title: "2 constraints extracted", detail: "Dark target, conveyor context. Both hard.", status: "ok" },
    { id: "d3", at: 260, agent: "resolver", title: "Binding constraint missing", detail: "Mounting distance is unknown and drives the whole solve. Refusing to guess.", status: "warn" },
    { id: "d4", at: 300, agent: "resolver", title: "Question emitted", detail: "Solver not invoked. A guess here produces a part that cannot see the target.", status: "warn" },
  ],
  thread: [
    { id: "dm1", role: "user", at: 0, text: "Necesito detectar cajas negras sobre una banda transportadora" },
    {
      id: "dm2",
      role: "agent",
      at: 260,
      agent: "resolver",
      text: "Black boxes on a conveyor. That gives me two constraints straight away — background suppression, and a 6% remission target. Both are hard. But the one that decides the answer is missing.",
      did: ["2 constraints extracted, both hard", "Solver not invoked — insufficient input"],
      chips: ["background suppression", "6% remission", "range: unknown"],
    },
    {
      id: "dm3",
      role: "question",
      at: 300,
      agent: "resolver",
      text: "How far is the sensor from the boxes?",
      why: "On a 6% black target a background-suppression sensor reaches roughly a third of its headline range. The gap between 200 mm and 600 mm is the gap between a W4 and a W12 — different housing, different bracket, different price. Guessing here is how you end up with a sensor that works on the bench and misses on the line.",
      options: [
        { label: "Under 200 mm", value: "200", effect: "Opens the W4 family — smallest housing" },
        { label: "200 – 400 mm", value: "400", effect: "W9 family — the usual answer" },
        { label: "400 – 800 mm", value: "800", effect: "W12 or W16 — wider bracket needed" },
        { label: "I don't know yet", value: "unknown", effect: "I'll ask for a photo of the mounting instead" },
      ],
    },
  ],
  outcome: "needs-input",
  stats: { catalogue: 1204, afterConstraints: 0, survived: 0, durationMs: 300 },
};

export const runs: SolveRun[] = [runQs18, runMl100, runDescribe];

// --- corpus telemetry ------------------------------------------------------

export const corpusStats: CorpusStats = {
  datasheets: 187,
  brands: [
    { name: "SICK", datasheets: 74, specRows: 1204 },
    { name: "Banner", datasheets: 58, specRows: 903 },
    { name: "Pepperl+Fuchs", datasheets: 55, specRows: 847 },
  ],
  specRows: 2954,
  disputes: 31,
  lowConfidence: 64,
  extractedAt: "08:20",
  runtimeMs: 2_280_000,
};

export const sickCatalogue: Part[] = [wtb9, wtb4, wtb12];

export function findPart(sku: string): Part | undefined {
  return sickCatalogue.find((p) => p.partNumber.toLowerCase() === sku.toLowerCase());
}
