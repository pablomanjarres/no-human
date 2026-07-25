/**
 * Orchestration: problem in, recommendation out.
 *
 *   free text ──[LLM parse]──> Requirement ──[deterministic scoring]──> shortlist
 *                                                                          │
 *                                          recommendation <──[LLM adjudicate]
 *
 * The LLM is injected, so the whole path is testable with a fake, and so the
 * engine degrades to a deterministic ranker when no model is available.
 */
import { Catalog } from './catalog.js';
import {
  ADJUDICATION_SCHEMA,
  ADJUDICATION_SYSTEM_PROMPT,
  PARSE_SYSTEM_PROMPT,
  REQUIREMENT_SCHEMA,
  buildAdjudicationUserPrompt,
  buildParseUserPrompt,
  normalizeRequirement,
  validateAdjudication,
} from './prompts.js';
import { scoreCatalog } from './score.js';
import type { EnrichedProduct, Requirement, ScoredCandidate } from './types.js';

/** Minimal contract the engine needs from a model. Implemented by the API app. */
export interface LlmClient {
  structured(args: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    purpose: 'parse' | 'adjudicate';
  }): Promise<unknown>;
}

export interface ConsultInput {
  problem_description: string;
  industry?: string | null;
  application?: string | null;
  constraints?: Record<string, unknown> | null;
}

export interface ProductAnswer {
  order_number: string;
  type_code: string | null;
  family: string | null;
  product_name: string | null;
  product_url: string | null;
  source_page: string;
  solution_class: string | null;
  sensing_mode: string | null;
  fit: number;
  evidence: number;
  why: string[];
  matched: string[];
  unverified: string[];
  is_safety_product: boolean;
  tradeoff_vs_primary: string | null;
}

export interface ConsultResult {
  understood_problem: {
    restated: string;
    language: 'es' | 'en';
    industry: string | null;
    application: string | null;
    inferred_needs: string[];
  };
  summary: string;
  recommendation: ProductAnswer | null;
  alternatives: ProductAnswer[];
  complete_the_solution: {
    order_number: string;
    type_code: string | null;
    description: string | null;
  }[];
  unverified: string[];
  not_applied: string[];
  notices: string[];
  diagnostics: {
    candidates_considered: number;
    excluded_count: number;
    dropped_order_numbers: string[];
    llm_parse: boolean;
    llm_adjudication: boolean;
  };
}

const TEXT = {
  es: {
    budget: (b: string) =>
      `Presupuesto (${b}): no se pudo aplicar. El catálogo resumido de SICK no incluye precios, así que la clasificación se basa solo en la idoneidad técnica. Solicite oferta para las referencias propuestas.`,
    safety:
      'Producto de seguridad funcional. Esta herramienta no sustituye una evaluación de riesgos: el nivel de prestaciones (PL según EN ISO 13849-1) o el SIL (IEC 62061) requerido debe determinarse para la máquina concreta, y la selección final debe validarla un técnico competente.',
    noCandidates:
      'Ningún producto del catálogo satisface las restricciones indicadas. Revise las restricciones o consulte el catálogo completo de SICK.',
    fallbackSummary: 'Selección determinista por ajuste técnico (sin adjudicación por modelo).',
    undiagnosed:
      'Sin modelo configurado no se puede diagnosticar el principio de detección que exige esta aplicación. El orden siguiente es solo por coincidencia de texto y rango, y puede proponer una familia de producto equivocada. Defina ANTHROPIC_API_KEY, o indique las restricciones concretas, para obtener el análisis completo.',
  },
  en: {
    budget: (b: string) =>
      `Budget (${b}) could not be applied. The SICK summary catalog carries no pricing, so ranking used technical fit only. Request a quote for the SKUs below.`,
    safety:
      'Functional-safety product. This tool does not replace a risk assessment: the required performance level (PL per EN ISO 13849-1) or SIL (IEC 62061) must be determined for the specific machine, and the final selection validated by a competent engineer.',
    noCandidates:
      'No product in this catalog satisfies the stated constraints. Relax a constraint or consult the full SICK catalog.',
    fallbackSummary: 'Deterministic ranking by technical fit (no model adjudication).',
    undiagnosed:
      'With no model configured, the detection principle this application needs cannot be diagnosed. The ranking below is text and range matching only, and may propose the wrong product family. Set ANTHROPIC_API_KEY, or state the constraints explicitly, for the full analysis.',
  },
} as const;

function toAnswer(
  candidate: ScoredCandidate,
  why: string[],
  tradeoff: string | null,
): ProductAnswer {
  const p = candidate.product;
  return {
    order_number: p.order_number,
    type_code: p.type_code,
    family: p.family,
    product_name: p.product_name ?? p.short_description,
    product_url: p.product_url,
    source_page: p.source_page,
    solution_class: p.solution_class,
    sensing_mode: p.sensing_mode,
    fit: Number(candidate.fit.toFixed(3)),
    evidence: Number(candidate.evidence.toFixed(3)),
    why,
    matched: candidate.outcomes.filter((o) => o.status === 'satisfied' && o.score > 0).map((o) => o.detail),
    unverified: candidate.unverified,
    is_safety_product: p.is_safety_product,
    tradeoff_vs_primary: tradeoff,
  };
}

/**
 * Explanation from the scoring trace, used when no adjudicator ran.
 *
 * When the requirement was too thin for any constraint to score — a bare
 * problem description with no model to interpret it — fall back to stating what
 * the catalog does say about the product. A recommendation with no grounds at
 * all is worse than a plain description of what is being recommended.
 */
function deterministicWhy(candidate: ScoredCandidate): string[] {
  const scored = candidate.outcomes
    .filter((o) => o.status === 'satisfied' && o.score > 0)
    .sort((a, b) => b.weight * b.score - a.weight * a.score)
    .slice(0, 4)
    .map((o) => o.detail);
  if (scored.length > 0) return scored;

  const p = candidate.product;
  const facts = [
    p.sensing_mode && `detection principle: ${p.sensing_mode}`,
    p.sensing_range_max_mm !== null && `sensing range up to ${p.sensing_range_max_mm} mm`,
    p.enclosure_rating && `enclosure rating ${p.enclosure_rating}`,
    p.switching_output && `${p.switching_output} switching output`,
    p.connection && `connection: ${p.connection}`,
  ].filter((x): x is string => typeof x === 'string');

  return facts.length > 0
    ? facts.slice(0, 4)
    : [`Listed in the catalog as ${p.product_name ?? p.type_code ?? p.order_number} (page ${p.source_page}).`];
}

function accessoriesFor(catalog: Catalog, product: EnrichedProduct) {
  return catalog.accessoriesFor(product).map((a) => ({
    order_number: a.order_number,
    type_code: a.type_code,
    description: a.short_description ?? a.product_name,
  }));
}

/**
 * Rank and explain without calling a model. This is both the no-API-key
 * fallback and the path used when the caller submits a structured requirement.
 */
export function consultWithRequirement(
  catalog: Catalog,
  requirement: Requirement,
  options: { limit?: number } = {},
): ConsultResult {
  const lang = requirement.language;
  const t = TEXT[lang];
  const scoring = scoreCatalog(catalog.products, requirement, { limit: options.limit ?? 8 });

  const notices: string[] = [];
  if (scoring.relaxed) notices.push(scoring.relaxed.note);
  // No product family and no detection principle means nothing diagnosed the
  // application — say so rather than presenting a confident guess.
  if (
    requirement.solution_classes.length === 0 &&
    requirement.preferred_sensing_modes.length === 0 &&
    requirement.keywords.length > 0
  ) {
    notices.push(t.undiagnosed);
  }

  const [top, ...rest] = scoring.candidates;
  const recommendation = top ? toAnswer(top, deterministicWhy(top), null) : null;
  const alternatives = rest.slice(0, 3).map((c) => toAnswer(c, deterministicWhy(c), null));

  if (recommendation === null) notices.push(t.noCandidates);
  if (requirement.safety_related || [recommendation, ...alternatives].some((a) => a?.is_safety_product)) {
    notices.push(t.safety);
  }

  const notApplied: string[] = [];
  if (requirement.budget) {
    notApplied.push(t.budget(`${requirement.budget.amount} ${requirement.budget.currency}/${requirement.budget.per}`));
  }

  return {
    understood_problem: {
      restated: requirement.restated_problem,
      language: lang,
      industry: requirement.industry,
      application: requirement.application,
      inferred_needs: requirement.inferred_needs,
    },
    summary: t.fallbackSummary,
    recommendation,
    alternatives,
    complete_the_solution: top ? accessoriesFor(catalog, top.product) : [],
    unverified: top ? top.unverified : [],
    not_applied: notApplied,
    notices,
    diagnostics: {
      candidates_considered: scoring.candidates.length,
      excluded_count: scoring.excluded.length,
      dropped_order_numbers: [],
      llm_parse: false,
      llm_adjudication: false,
    },
  };
}

/**
 * Full path: parse the problem with a model, rank deterministically, then let a
 * model adjudicate — but only among the SKUs the ranker actually produced.
 *
 * Each model step degrades independently: a failed parse falls back to a
 * keyword-only requirement, a failed adjudication falls back to the scoring trace.
 */
export async function consult(
  catalog: Catalog,
  input: ConsultInput,
  llm: LlmClient | null,
  options: { limit?: number } = {},
): Promise<ConsultResult> {
  let requirement: Requirement;
  let parsedByLlm = false;

  if (llm) {
    try {
      const raw = await llm.structured({
        system: PARSE_SYSTEM_PROMPT,
        user: buildParseUserPrompt(input),
        schema: REQUIREMENT_SCHEMA as unknown as Record<string, unknown>,
        purpose: 'parse',
      });
      requirement = normalizeRequirement(raw);
      parsedByLlm = true;
    } catch {
      requirement = fallbackRequirement(input);
    }
  } else {
    requirement = fallbackRequirement(input);
  }

  const base = consultWithRequirement(catalog, requirement, options);
  base.diagnostics.llm_parse = parsedByLlm;

  const scoring = scoreCatalog(catalog.products, requirement, { limit: options.limit ?? 8 });
  if (!llm || scoring.candidates.length === 0) return base;

  const byOrder = new Map(scoring.candidates.map((c) => [c.product.order_number, c]));
  const allowed = new Set(byOrder.keys());

  try {
    const raw = await llm.structured({
      system: ADJUDICATION_SYSTEM_PROMPT,
      user: buildAdjudicationUserPrompt(requirement, scoring.candidates),
      schema: ADJUDICATION_SCHEMA as unknown as Record<string, unknown>,
      purpose: 'adjudicate',
    });
    const { adjudication, dropped } = validateAdjudication(raw, allowed);
    base.diagnostics.dropped_order_numbers = dropped;
    if (!adjudication) return base;

    const chosen = byOrder.get(adjudication.recommendation.order_number);
    if (!chosen) return base;

    base.summary = adjudication.summary;
    base.recommendation = toAnswer(chosen, adjudication.recommendation.why, null);
    base.alternatives = adjudication.alternatives
      .slice(0, 3)
      .flatMap((alt) => {
        const c = byOrder.get(alt.order_number);
        return c ? [toAnswer(c, deterministicWhy(c), alt.tradeoff_vs_primary)] : [];
      });
    base.complete_the_solution = accessoriesFor(catalog, chosen.product);
    base.unverified = [...chosen.unverified, ...adjudication.recommendation.caveats];
    base.diagnostics.llm_adjudication = true;

    // Re-evaluate the safety notice: the adjudicator may have picked a different SKU.
    const t = TEXT[requirement.language];
    const touchesSafety =
      requirement.safety_related ||
      chosen.product.is_safety_product ||
      base.alternatives.some((a) => a.is_safety_product);
    base.notices = base.notices.filter((n) => n !== t.safety);
    if (touchesSafety) base.notices.push(t.safety);
  } catch {
    // Adjudication is best-effort; the deterministic answer already stands.
  }

  return base;
}

/**
 * Answer in the language the question was asked in. Accents alone are not
 * enough — Spanish is routinely typed without them on industrial keyboards.
 */
export function detectLanguage(text: string): 'es' | 'en' {
  if (/[áéíóúñ¿¡]/i.test(text)) return 'es';
  const spanish = /\b(el|la|los|las|un|una|de|del|que|con|por|para|en|es|son|necesito|detectar|cinta|sobre|desde|hasta)\b/gi;
  const english = /\b(the|a|an|of|that|with|for|in|is|are|need|detect|belt|from|to|on)\b/gi;
  return (text.match(spanish)?.length ?? 0) >= (text.match(english)?.length ?? 0) ? 'es' : 'en';
}

/**
 * Words that carry no product signal. Without these filtered out, "necesito
 * detectar botellas ... lavado a presion" matches a pressure/level sensor on the
 * word "presion" and buries the photoelectric answer.
 */
const STOPWORDS = new Set([
  'necesito', 'necesita', 'detectar', 'deteccion', 'quiero', 'tengo', 'tiene', 'sobre', 'entre',
  'donde', 'porque', 'cuando', 'hasta', 'desde', 'para', 'como', 'esta', 'este', 'esto', 'unas',
  'unos', 'muy', 'mas', 'pero', 'aplicacion', 'problema', 'sensor', 'sensores', 'solucion',
  'need', 'needs', 'detect', 'detection', 'would', 'there', 'which', 'about', 'should', 'could',
  'have', 'with', 'that', 'this', 'they', 'them', 'application', 'problem', 'sensor', 'sensors',
  'solution', 'want', 'wants', 'looking',
]);

/** Requirement used when no model is available: keywords only, no inference. */
export function fallbackRequirement(input: ConsultInput): Requirement {
  const constraints = input.constraints ?? {};
  const readNumber = (key: string): number | null => {
    const v = constraints[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    restated_problem: input.problem_description,
    language: detectLanguage(input.problem_description),
    industry: input.industry ?? null,
    application: input.application ?? null,
    inferred_needs: [],
    solution_classes: [],
    preferred_sensing_modes: [],
    discouraged_sensing_modes: [],
    target_distance_mm: readNumber('sensing_distance_mm'),
    required_protective_field_height_mm: readNumber('protective_field_height_mm'),
    required_safety_resolution_mm: readNumber('safety_resolution_mm'),
    min_ip_ingress: null,
    min_ip_water: null,
    washdown_required: false,
    min_ambient_temp_c: null,
    max_ambient_temp_c: null,
    required_protocols:
      typeof constraints['communication_protocol'] === 'string'
        ? [constraints['communication_protocol']]
        : [],
    required_switching_output: null,
    max_response_time_ms: null,
    keywords: input.problem_description
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 4 && !STOPWORDS.has(w))
      .slice(0, 8),
    budget: null,
    safety_related: false,
  };
}
