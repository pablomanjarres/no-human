/**
 * The LLM boundary: prompt builders, response schemas, and the validators that
 * make the model's output safe to trust.
 *
 * Prompts and schemas live in the engine (they are domain logic, and they are
 * unit-tested here). Only the HTTP transport lives in the API app, so the
 * intelligence can be tested without a network.
 */
import { SENSING_MODES, SOLUTION_CLASSES } from './types.js';
import type { ModeOpinion, Requirement, ScoredCandidate, SensingMode, SolutionClass } from './types.js';

// ---------------------------------------------------------------------------
// Step 1 — free-text problem → structured Requirement
// ---------------------------------------------------------------------------

const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] });

const MODE_OPINION_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: [...SENSING_MODES] },
      reason: { type: 'string' },
    },
    required: ['mode', 'reason'],
    additionalProperties: false,
  },
};

export const REQUIREMENT_SCHEMA = {
  type: 'object',
  properties: {
    restated_problem: { type: 'string' },
    language: { type: 'string', enum: ['es', 'en'] },
    industry: nullable('string'),
    application: nullable('string'),
    inferred_needs: { type: 'array', items: { type: 'string' } },
    solution_classes: { type: 'array', items: { type: 'string', enum: [...SOLUTION_CLASSES] } },
    preferred_sensing_modes: MODE_OPINION_SCHEMA,
    discouraged_sensing_modes: MODE_OPINION_SCHEMA,
    target_distance_mm: nullable('number'),
    required_protective_field_height_mm: nullable('number'),
    required_safety_resolution_mm: nullable('number'),
    min_ip_ingress: nullable('integer'),
    min_ip_water: nullable('integer'),
    washdown_required: { type: 'boolean' },
    min_ambient_temp_c: nullable('number'),
    max_ambient_temp_c: nullable('number'),
    required_protocols: { type: 'array', items: { type: 'string' } },
    required_switching_output: { anyOf: [{ type: 'string', enum: ['PNP', 'NPN'] }, { type: 'null' }] },
    max_response_time_ms: nullable('number'),
    keywords: { type: 'array', items: { type: 'string' } },
    budget: {
      anyOf: [
        {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            currency: { type: 'string' },
            per: { type: 'string' },
          },
          required: ['amount', 'currency', 'per'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    safety_related: { type: 'boolean' },
  },
  required: [
    'restated_problem',
    'language',
    'industry',
    'application',
    'inferred_needs',
    'solution_classes',
    'preferred_sensing_modes',
    'discouraged_sensing_modes',
    'target_distance_mm',
    'required_protective_field_height_mm',
    'required_safety_resolution_mm',
    'min_ip_ingress',
    'min_ip_water',
    'washdown_required',
    'min_ambient_temp_c',
    'max_ambient_temp_c',
    'required_protocols',
    'required_switching_output',
    'max_response_time_ms',
    'keywords',
    'budget',
    'safety_related',
  ],
  additionalProperties: false,
} as const;

export const PARSE_SYSTEM_PROMPT = `You are a SICK industrial sensing application engineer. You translate a customer's
description of a problem into a structured sensing requirement.

Your job is diagnosis, not transcription. The customer describes a situation; you decide what
physics will actually work. Apply real application knowledge:

DETECTION PRINCIPLE
- Transparent targets (PET bottles, glass, film, clear packaging) defeat diffuse sensors — the
  beam passes through. Use retroreflective with a polarising filter, or ultrasonic.
- Shiny or specular targets (bright metal, foil) can bounce a retroreflective beam back from the
  object itself and mask it. Prefer polarised retroreflective, or diffuse with background suppression.
- Dark, matte, or low-reflectance targets at range: opposed (through-beam) has the highest excess
  gain and is the most reliable.
- Dust, steam, spray, or heavy contamination: opposed for optical excess gain, or ultrasonic,
  which is largely indifferent to optical clarity and surface colour.
- Metal presence at short range (a few mm to ~40 mm): inductive.
- Level or presence of non-metals through a container wall: capacitive.
- Small parts, thread, wire, or precise edge position: fork sensors (horquilla) — the emitter and
  receiver are pre-aligned in one housing.
- Distance or displacement as an analogue value: laser time-of-flight for long range, laser
  triangulation for short-range precision, ultrasonic where optics would foul.
- Print marks, register marks, colour steps on a web: contrast sensor.
- Reading a barcode or 2D code: barcode laser scanner, or camera-based reader for damaged /
  omnidirectional codes.
- Shaft speed, angle, or position feedback: incremental encoder for speed and relative motion,
  absolute encoder where position must survive a power cycle.
- Pressure, level, flow, or temperature in a pipe or tank: fluid sensors.
- Guarding access to a hazardous machine: safety light curtain (14 mm resolution detects fingers,
  30 mm detects hands), multibeam for perimeter guarding, single-beam for a simple access point.
  For a light curtain, two numbers decide the part: set required_protective_field_height_mm to the
  height of the opening being guarded, and required_safety_resolution_mm to the smallest body part
  that must be detected (14 for fingers, 30 for hands, 40+ for a body). A curtain shorter than the
  opening leaves an unguarded gap, and a coarser resolution cannot see the intrusion at all.

ENVIRONMENT
- Food, beverage, pharma washdown implies IP69K and stainless steel. Set washdown_required.
- Outdoor or high-pressure hosing implies at least IP67, often IP68.
- Set min_ip_ingress (the dust digit, 0-6) and min_ip_water (the water digit, 0-9) only when the
  problem genuinely implies them.

RULES
- Infer only what the problem supports. If the customer never mentions a communication protocol,
  leave required_protocols empty. Do not invent constraints — an invented constraint silently
  filters out good products.
- Convert every distance to millimetres.
- keywords: 3-8 lowercase, unaccented Spanish or English terms likely to appear in a SICK catalog
  entry for this application (e.g. "botella", "higienic", "horquilla", "codigo de barras").
  These are matched against catalog text, so prefer catalog vocabulary over the customer's words.
- inferred_needs: the things the customer did not say but that follow from the application — this
  is the consultancy value. State them plainly.
- safety_related: true if this protects a person from a machine hazard. Guarding, emergency stop,
  interlocks, presence sensing in a danger zone.
- Answer in the customer's own language for restated_problem and all free text.`;

export function buildParseUserPrompt(input: {
  problem_description: string;
  industry?: string | null;
  application?: string | null;
  constraints?: Record<string, unknown> | null;
}): string {
  const lines = [`PROBLEM:\n${input.problem_description}`];
  if (input.industry) lines.push(`INDUSTRY: ${input.industry}`);
  if (input.application) lines.push(`APPLICATION: ${input.application}`);
  if (input.constraints && Object.keys(input.constraints).length > 0) {
    lines.push(`STATED CONSTRAINTS:\n${JSON.stringify(input.constraints, null, 2)}`);
  }
  return lines.join('\n\n');
}

const isSolutionClass = (v: unknown): v is SolutionClass =>
  typeof v === 'string' && (SOLUTION_CLASSES as readonly string[]).includes(v);
const isSensingMode = (v: unknown): v is SensingMode =>
  typeof v === 'string' && (SENSING_MODES as readonly string[]).includes(v);

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function asModeOpinions(value: unknown): ModeOpinion[] {
  return asArray(value).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { mode, reason } = entry as Record<string, unknown>;
    if (!isSensingMode(mode)) return [];
    return [{ mode, reason: asString(reason) ?? 'preferred principle' }];
  });
}

/**
 * Coerce a model response into a Requirement, dropping anything invalid.
 * Structured outputs make malformed responses unlikely; this makes them harmless.
 */
export function normalizeRequirement(raw: unknown): Requirement {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const budgetRaw = r['budget'];
  let budget: Requirement['budget'] = null;
  if (typeof budgetRaw === 'object' && budgetRaw !== null) {
    const b = budgetRaw as Record<string, unknown>;
    const amount = asNumber(b['amount']);
    if (amount !== null) {
      budget = { amount, currency: asString(b['currency']) ?? 'EUR', per: asString(b['per']) ?? 'unit' };
    }
  }
  const output = r['required_switching_output'];

  return {
    restated_problem: asString(r['restated_problem']) ?? '',
    language: r['language'] === 'en' ? 'en' : 'es',
    industry: asString(r['industry']),
    application: asString(r['application']),
    inferred_needs: asArray(r['inferred_needs']).filter((x): x is string => typeof x === 'string'),
    solution_classes: asArray(r['solution_classes']).filter(isSolutionClass),
    preferred_sensing_modes: asModeOpinions(r['preferred_sensing_modes']),
    discouraged_sensing_modes: asModeOpinions(r['discouraged_sensing_modes']),
    target_distance_mm: asNumber(r['target_distance_mm']),
    required_protective_field_height_mm: asNumber(r['required_protective_field_height_mm']),
    required_safety_resolution_mm: asNumber(r['required_safety_resolution_mm']),
    min_ip_ingress: asNumber(r['min_ip_ingress']),
    min_ip_water: asNumber(r['min_ip_water']),
    washdown_required: r['washdown_required'] === true,
    min_ambient_temp_c: asNumber(r['min_ambient_temp_c']),
    max_ambient_temp_c: asNumber(r['max_ambient_temp_c']),
    required_protocols: asArray(r['required_protocols']).filter((x): x is string => typeof x === 'string'),
    required_switching_output: output === 'PNP' || output === 'NPN' ? output : null,
    max_response_time_ms: asNumber(r['max_response_time_ms']),
    keywords: asArray(r['keywords'])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.toLowerCase()),
    budget,
    safety_related: r['safety_related'] === true,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — shortlist → recommendation, comparison, justification
// ---------------------------------------------------------------------------

export const ADJUDICATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    recommendation: {
      type: 'object',
      properties: {
        order_number: { type: 'string' },
        why: { type: 'array', items: { type: 'string' } },
        caveats: { type: 'array', items: { type: 'string' } },
      },
      required: ['order_number', 'why', 'caveats'],
      additionalProperties: false,
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          order_number: { type: 'string' },
          tradeoff_vs_primary: { type: 'string' },
        },
        required: ['order_number', 'tradeoff_vs_primary'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'recommendation', 'alternatives'],
  additionalProperties: false,
} as const;

export const ADJUDICATION_SYSTEM_PROMPT = `You are a SICK application engineer choosing between products that a deterministic
matcher has already shortlisted from the SICK catalog.

HARD RULES
- You may ONLY reference order numbers that appear in the CANDIDATES list. You cannot propose a
  product that is not in that list, and you must not invent an order number or a type code.
  Every order number you output is checked against the candidate list and dropped if absent.
- Do not state a specification that is not shown in the candidate data. If a spec matters and is
  marked unverified, say it must be confirmed on the datasheet — do not guess the value.

HOW TO CHOOSE
- Weigh the constraint outcomes, not just the score. A high fit backed by thin evidence is weaker
  than a slightly lower fit that the catalog fully supports.
- Prefer a sensor with sensible installation margin over one that only just reaches.
- Pick 2-3 alternatives that are genuinely different choices — a different detection principle, a
  different range class, a different connection type — not near-identical variants of the winner.
  For each, say plainly what you trade away versus the primary.
- 'why' should be 2-4 short, concrete points tied to this application. No marketing language.
- 'caveats' is where unverified specs and installation risks go. Be specific about what to check.

Write in the language of the restated problem.`;

/** Compact the shortlist into the evidence the adjudicator is allowed to reason over. */
export function buildAdjudicationUserPrompt(req: Requirement, candidates: ScoredCandidate[]): string {
  const rows = candidates.map((c, i) => {
    const p = c.product;
    const specs = [
      p.sensing_mode && `mode=${p.sensing_mode}`,
      p.sensing_range_max_mm !== null && `range<=${p.sensing_range_max_mm}mm`,
      p.switching_output && `out=${p.switching_output}`,
      p.enclosure_rating && `ip=${p.enclosure_rating}`,
      p.connection && `conn=${p.connection}`,
      p.protocols.length > 0 && `protocols=${p.protocols.join('/')}`,
      p.operating_temp_min_c !== null && `temp=${p.operating_temp_min_c}..${p.operating_temp_max_c}C`,
      p.protective_field_height_mm !== null && `field_height=${p.protective_field_height_mm}mm`,
      p.safety_resolution_mm !== null && `safety_res=${p.safety_resolution_mm}mm`,
    ].filter(Boolean);

    const checks = c.outcomes
      .filter((o) => o.status !== 'not_applicable')
      .map((o) => `      - ${o.constraint} [${o.status}]: ${o.detail}`)
      .join('\n');

    return [
      `${i + 1}. order_number=${p.order_number} type=${p.type_code ?? '?'} family=${p.family ?? '?'}`,
      `      name: ${p.product_name ?? p.short_description ?? '(no description in catalog)'}`,
      `      class: ${p.solution_class ?? '?'} | page ${p.source_page}`,
      specs.length > 0 ? `      specs: ${specs.join(', ')}` : '      specs: (none stated in catalog)',
      `      fit=${c.fit.toFixed(2)} evidence=${c.evidence.toFixed(2)}`,
      checks,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    `RESTATED PROBLEM:\n${req.restated_problem}`,
    req.inferred_needs.length > 0 ? `INFERRED NEEDS:\n- ${req.inferred_needs.join('\n- ')}` : '',
    `CANDIDATES (choose only from these):\n${rows.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface Adjudication {
  summary: string;
  recommendation: { order_number: string; why: string[]; caveats: string[] };
  alternatives: { order_number: string; tradeoff_vs_primary: string }[];
}

export interface AdjudicationValidation {
  adjudication: Adjudication | null;
  /** Order numbers the model produced that were not in the candidate set. */
  dropped: string[];
}

/**
 * Enforce the anti-hallucination invariant in code, not in the prompt: any order
 * number the model returns that was not in the candidate set is dropped and reported.
 */
export function validateAdjudication(raw: unknown, allowed: ReadonlySet<string>): AdjudicationValidation {
  const dropped: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { adjudication: null, dropped };
  const r = raw as Record<string, unknown>;

  const recRaw = r['recommendation'];
  if (typeof recRaw !== 'object' || recRaw === null) return { adjudication: null, dropped };
  const rec = recRaw as Record<string, unknown>;
  const recOrder = asString(rec['order_number']);
  if (recOrder === null) return { adjudication: null, dropped };
  if (!allowed.has(recOrder)) {
    dropped.push(recOrder);
    return { adjudication: null, dropped };
  }

  const alternatives = asArray(r['alternatives']).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const alt = entry as Record<string, unknown>;
    const order = asString(alt['order_number']);
    if (order === null) return [];
    if (!allowed.has(order) || order === recOrder) {
      if (!allowed.has(order)) dropped.push(order);
      return [];
    }
    return [{ order_number: order, tradeoff_vs_primary: asString(alt['tradeoff_vs_primary']) ?? '' }];
  });

  return {
    adjudication: {
      summary: asString(r['summary']) ?? '',
      recommendation: {
        order_number: recOrder,
        why: asArray(rec['why']).filter((x): x is string => typeof x === 'string'),
        caveats: asArray(rec['caveats']).filter((x): x is string => typeof x === 'string'),
      },
      alternatives,
    },
    dropped,
  };
}
