/**
 * Deterministic scoring over the enriched SICK catalog.
 *
 * The design problem this solves: the source is the *catálogo resumido*, which
 * lists ordering options but omits most datasheet specs. Communication interface
 * is stated for 19% of products, resolution for 13%, ambient temperature for 7%.
 * Hard-filtering on those fields returns nothing for realistic queries, so the
 * engine sorts every constraint into one of three tiers:
 *
 *   1. HARD   — a *stated* value that violates the requirement disqualifies.
 *   2. SOFT   — a stated match boosts; a stated mismatch does not disqualify,
 *               because the catalog's list is not exhaustive (protocols).
 *   3. ABSENT — an unstated value NEVER disqualifies. It is recorded as
 *               `unverified` and lowers the evidence score instead.
 *
 * That last rule is the whole point: absence of evidence is not evidence of
 * absence, and treating it as failure is what would make this tool useless.
 *
 * Two scores come out, deliberately not collapsed into one:
 *   fit      — weighted match across constraints the catalog could verify
 *   evidence — how much of the requirement the catalog could verify at all
 *
 * A product can be a great fit on thin evidence. The UI shows both.
 *
 * `status` semantics: `satisfied` means "the catalog said enough to evaluate
 * this, and it does not disqualify" — the numeric `score` carries the degree,
 * so a satisfied outcome may still score 0 on a soft constraint.
 */
import type {
  ConstraintOutcome,
  EnrichedProduct,
  Requirement,
  ScoredCandidate,
  ScoringResult,
} from './types.js';

interface ConstraintSpec {
  name: string;
  weight: number;
  /** When true, a `violated` outcome removes the product from the results. */
  hard: boolean;
  evaluate(product: EnrichedProduct, req: Requirement): Omit<ConstraintOutcome, 'constraint' | 'weight'> | null;
}

const NA = { status: 'not_applicable' as const, detail: 'not requested', score: 0 };

function unverified(detail: string) {
  return { status: 'unverified' as const, detail, score: 0 };
}
function ok(detail: string, score = 1) {
  return { status: 'satisfied' as const, detail, score };
}
function bad(detail: string) {
  return { status: 'violated' as const, detail, score: 0 };
}

/**
 * Score a sensing range by margin rather than pass/fail. For a 300 mm target a
 * 400 mm sensor beats a 310 mm one (installation margin) and beats a 6 m one
 * (over-specced, and long-range optics are usually harder to align).
 */
export function rangeFitScore(requiredMm: number, statedMaxMm: number): number {
  if (statedMaxMm < requiredMm) return 0;
  const ratio = statedMaxMm / requiredMm;
  if (ratio < 1.3) return 0.7 + (0.3 * (ratio - 1)) / 0.3;
  if (ratio <= 2) return 1;
  // Decay for over-specification, floored so a long-range sensor stays viable.
  return Math.max(0.35, 1 - (ratio - 2) * 0.075);
}

const CONSTRAINTS: ConstraintSpec[] = [
  {
    name: 'solution_class',
    weight: 3,
    hard: true,
    evaluate(p, r) {
      if (r.solution_classes.length === 0) return NA;
      if (p.solution_class === null) return unverified('product family not classified');
      return r.solution_classes.includes(p.solution_class)
        ? ok(`is a ${p.solution_class} device`)
        : bad(`is a ${p.solution_class} device, not one of: ${r.solution_classes.join(', ')}`);
    },
  },
  {
    name: 'sensing_mode',
    weight: 3,
    hard: true,
    evaluate(p, r) {
      const discouraged = r.discouraged_sensing_modes.find((m) => m.mode === p.sensing_mode);
      if (discouraged) return bad(`${p.sensing_mode} is unsuitable here: ${discouraged.reason}`);
      if (r.preferred_sensing_modes.length === 0) return NA;
      if (p.sensing_mode === null)
        return unverified('catalog does not state a detection principle for this SKU');
      const idx = r.preferred_sensing_modes.findIndex((m) => m.mode === p.sensing_mode);
      if (idx === -1) return ok(`${p.sensing_mode} — workable but not the preferred principle`, 0.25);
      const pref = r.preferred_sensing_modes[idx];
      return ok(`${p.sensing_mode} — ${pref?.reason ?? 'preferred principle'}`, Math.max(0.5, 1 - idx * 0.15));
    },
  },
  {
    name: 'sensing_range',
    weight: 2.5,
    hard: true,
    evaluate(p, r) {
      if (r.target_distance_mm === null) return NA;
      const target = r.target_distance_mm;
      if (p.sensing_range_min_mm !== null && target < p.sensing_range_min_mm)
        return bad(`target at ${target} mm is inside the ${p.sensing_range_min_mm} mm blind zone`);
      if (p.sensing_range_max_mm === null)
        return unverified('catalog does not state a sensing range for this SKU');
      if (p.sensing_range_max_mm < target)
        return bad(`reaches ${p.sensing_range_max_mm} mm, short of the ${target} mm required`);
      return ok(
        `reaches ${p.sensing_range_max_mm} mm for a ${target} mm target`,
        rangeFitScore(target, p.sensing_range_max_mm),
      );
    },
  },
  {
    // For a light curtain this is the defining selection parameter: a curtain
    // shorter than the opening leaves an unguarded gap.
    name: 'protective_field_height',
    weight: 2.5,
    hard: true,
    evaluate(p, r) {
      if (r.required_protective_field_height_mm === null) return NA;
      const needed = r.required_protective_field_height_mm;
      if (p.protective_field_height_mm === null)
        return unverified('catalog does not state a protective field height for this SKU');
      if (p.protective_field_height_mm < needed)
        return bad(
          `${p.protective_field_height_mm} mm protective field leaves the ${needed} mm opening partly unguarded`,
        );
      const overshoot = p.protective_field_height_mm / needed;
      return ok(
        `${p.protective_field_height_mm} mm protective field covers the ${needed} mm opening`,
        Math.max(0.5, 1 - (overshoot - 1) * 0.4),
      );
    },
  },
  {
    // Lower is finer: 14 mm detects a finger, 30 mm a hand. A coarser curtain
    // than the risk assessment calls for cannot detect the intrusion at all.
    name: 'safety_resolution',
    weight: 2.5,
    hard: true,
    evaluate(p, r) {
      if (r.required_safety_resolution_mm === null) return NA;
      const needed = r.required_safety_resolution_mm;
      if (p.safety_resolution_mm === null)
        return unverified('catalog does not state a detection resolution for this SKU');
      if (p.safety_resolution_mm > needed)
        return bad(
          `${p.safety_resolution_mm} mm resolution is too coarse to detect a ${needed} mm object`,
        );
      return ok(`${p.safety_resolution_mm} mm resolution detects a ${needed} mm object`);
    },
  },
  {
    name: 'ingress_protection',
    weight: 2,
    hard: true,
    evaluate(p, r) {
      const wantsIp = r.min_ip_ingress !== null || r.min_ip_water !== null || r.washdown_required;
      if (!wantsIp) return NA;
      if (p.ip_ingress === null && p.ip_water === null)
        return unverified('catalog does not state an enclosure rating for this SKU');
      if (r.washdown_required && p.washdown_capable !== true)
        return bad(`rated ${p.enclosure_rating ?? 'unknown'} — not IP69K washdown rated`);
      if (r.min_ip_ingress !== null && (p.ip_ingress ?? 0) < r.min_ip_ingress)
        return bad(`dust rating IP${p.ip_ingress}x below the required IP${r.min_ip_ingress}x`);
      if (r.min_ip_water !== null && (p.ip_water ?? 0) < r.min_ip_water)
        return bad(`water rating IPx${p.ip_water} below the required IPx${r.min_ip_water}`);
      return ok(`rated ${p.enclosure_rating}`);
    },
  },
  {
    name: 'ambient_temperature',
    weight: 1.5,
    hard: true,
    evaluate(p, r) {
      if (r.min_ambient_temp_c === null && r.max_ambient_temp_c === null) return NA;
      if (p.operating_temp_min_c === null && p.operating_temp_max_c === null)
        return unverified('catalog does not state an operating temperature range for this SKU');
      if (r.min_ambient_temp_c !== null && (p.operating_temp_min_c ?? Infinity) > r.min_ambient_temp_c)
        return bad(`rated from ${p.operating_temp_min_c} °C, above the required ${r.min_ambient_temp_c} °C`);
      if (r.max_ambient_temp_c !== null && (p.operating_temp_max_c ?? -Infinity) < r.max_ambient_temp_c)
        return bad(`rated to ${p.operating_temp_max_c} °C, below the required ${r.max_ambient_temp_c} °C`);
      return ok(`rated ${p.operating_temp_min_c} … ${p.operating_temp_max_c} °C`);
    },
  },
  {
    name: 'switching_output',
    weight: 1,
    hard: true,
    evaluate(p, r) {
      if (r.required_switching_output === null) return NA;
      if (p.switching_output === null)
        return unverified('catalog does not state a switching output for this SKU');
      return p.switching_output.toUpperCase().includes(r.required_switching_output)
        ? ok(`${p.switching_output} output`)
        : bad(`${p.switching_output} output, not ${r.required_switching_output}`);
    },
  },
  {
    name: 'response_time',
    weight: 1,
    hard: true,
    evaluate(p, r) {
      if (r.max_response_time_ms === null) return NA;
      if (p.response_time_ms === null)
        return unverified('catalog does not state a response time for this SKU');
      return p.response_time_ms <= r.max_response_time_ms
        ? ok(`${p.response_time_ms} ms response`)
        : bad(`${p.response_time_ms} ms response, slower than the ${r.max_response_time_ms} ms required`);
    },
  },
  {
    // SOFT by design. The catalog's interface field is not an exhaustive
    // statement of what a SKU supports, so a non-match must not disqualify.
    name: 'communication_protocol',
    weight: 1.5,
    hard: false,
    evaluate(p, r) {
      if (r.required_protocols.length === 0) return NA;
      if (p.protocols.length === 0)
        return unverified('catalog does not state a communication interface for this SKU');
      const want = r.required_protocols.map((x) => x.toLowerCase());
      const hits = p.protocols.filter((x) => want.includes(x.toLowerCase()));
      if (hits.length === 0)
        return ok(`states ${p.protocols.join(', ')} — requested protocol not listed`, 0);
      return ok(`supports ${hits.join(', ')}`, hits.length / want.length);
    },
  },
  {
    name: 'application_keywords',
    weight: 1,
    hard: false,
    evaluate(p, r) {
      if (r.keywords.length === 0) return NA;
      const hits = r.keywords.filter((k) => p.search_blob.includes(k.toLowerCase()));
      if (hits.length === 0) return ok('no application keywords matched the catalog text', 0);
      return ok(`catalog text matches: ${hits.join(', ')}`, hits.length / r.keywords.length);
    },
  },
];

const HARD_CONSTRAINTS = CONSTRAINTS.filter((c) => c.hard).map((c) => c.name);

/** Score one product. `ignoreHard` lets the caller relax a constraint when nothing survives. */
export function scoreProduct(
  product: EnrichedProduct,
  req: Requirement,
  ignoreHard: ReadonlySet<string> = new Set(),
): ScoredCandidate {
  const outcomes: ConstraintOutcome[] = [];
  let excludedBy: string | null = null;

  for (const spec of CONSTRAINTS) {
    const result = spec.evaluate(product, req);
    if (result === null) continue;
    outcomes.push({ constraint: spec.name, weight: spec.weight, ...result });
    if (result.status === 'violated' && spec.hard && !ignoreHard.has(spec.name) && excludedBy === null) {
      excludedBy = spec.name;
    }
  }

  const verified = outcomes.filter((o) => o.status === 'satisfied' || o.status === 'violated');
  const applicable = outcomes.filter((o) => o.status !== 'not_applicable');

  const verifiedWeight = verified.reduce((sum, o) => sum + o.weight, 0);
  const applicableWeight = applicable.reduce((sum, o) => sum + o.weight, 0);

  const fit = verifiedWeight === 0 ? 0 : verified.reduce((s, o) => s + o.score * o.weight, 0) / verifiedWeight;
  const evidence = applicableWeight === 0 ? 1 : verifiedWeight / applicableWeight;

  return {
    product,
    fit,
    evidence,
    // Evidence tempers the ranking without dominating it: a perfect fit with no
    // supporting data ranks at 0.55, a perfect fit fully backed by the catalog at 1.0.
    rank_score: fit * (0.55 + 0.45 * evidence),
    outcomes,
    unverified: outcomes.filter((o) => o.status === 'unverified').map((o) => o.detail),
    excluded_by: excludedBy,
  };
}

export interface ScoreOptions {
  limit?: number;
  /** Include accessories in the ranking. Off by default — they are offered separately. */
  includeAccessories?: boolean;
}

/**
 * Rank the catalog against a requirement.
 *
 * If nothing survives the hard filters, the weakest one is relaxed and the pass
 * repeats — returning a near-miss with an explicit note beats returning nothing.
 */
export function scoreCatalog(
  products: readonly EnrichedProduct[],
  req: Requirement,
  options: ScoreOptions = {},
): ScoringResult {
  const limit = options.limit ?? 12;
  const pool = options.includeAccessories
    ? products
    : products.filter((p) => p.row_type === 'product');

  const run = (ignoreHard: ReadonlySet<string>) => {
    const scored = pool.map((p) => scoreProduct(p, req, ignoreHard));
    return {
      candidates: scored
        .filter((c) => c.excluded_by === null)
        .sort((a, b) => b.rank_score - a.rank_score),
      excluded: scored.filter((c) => c.excluded_by !== null),
    };
  };

  let { candidates, excluded } = run(new Set());
  let relaxed: ScoringResult['relaxed'] = null;

  if (candidates.length === 0) {
    // Relax hard constraints cheapest-first until something survives.
    const order = [...HARD_CONSTRAINTS].sort((a, b) => {
      const wa = CONSTRAINTS.find((c) => c.name === a)?.weight ?? 0;
      const wb = CONSTRAINTS.find((c) => c.name === b)?.weight ?? 0;
      return wa - wb;
    });
    const ignore = new Set<string>();
    for (const name of order) {
      ignore.add(name);
      const attempt = run(ignore);
      if (attempt.candidates.length > 0) {
        candidates = attempt.candidates;
        excluded = attempt.excluded;
        relaxed = {
          constraint: [...ignore].join(', '),
          note: `No product in this catalog satisfies every stated constraint. Results below relax: ${[...ignore].join(', ')}. Check the flagged constraint on the datasheet before ordering.`,
        };
        break;
      }
    }
  }

  return {
    candidates: candidates.slice(0, limit),
    excluded: excluded.slice(0, limit),
    relaxed,
  };
}
