/**
 * Domain types for the SICK consultancy engine.
 *
 * Everything is `| null` rather than optional: the enriched catalog encodes
 * "not stated in the catalog" as null, and that distinction is load-bearing —
 * an absent value must never be confused with a failing one.
 */

export const SOLUTION_CLASSES = [
  'photoelectric',
  'fluid',
  'safety_optoelectronic',
  'proximity',
  'distance',
  'identification',
  'registration',
  'safety_switch',
  'encoder',
  'magnetic_cylinder',
  'safety_controller',
  'light_grid',
  'vision',
] as const;

export type SolutionClass = (typeof SOLUTION_CLASSES)[number];

export const SENSING_MODES = [
  'opposed',
  'retroreflective',
  'diffuse',
  'ultrasonic',
  'inductive',
  'capacitive',
  'magnetic',
  'fork',
  'contrast',
  'luminescence',
  'color',
  'laser_tof',
  'laser_triangulation',
  'barcode_laser',
  'camera',
  'rfid',
  'encoder_incremental',
  'encoder_absolute',
  'encoder_wire_draw',
  'safety_light_curtain',
  'safety_multibeam',
  'safety_single_beam',
  'safety_laser_scanner',
] as const;

export type SensingMode = (typeof SENSING_MODES)[number];

/** One product row from `catalog.enriched.json`. */
export interface EnrichedProduct {
  order_number: string;
  type_code: string | null;
  family: string | null;
  subfamily: string | null;
  row_type: 'product' | 'accessory';
  category: string;
  section: string;
  source_page: string;
  product_url: string | null;
  product_name: string | null;
  short_description: string | null;

  solution_class: SolutionClass | null;
  is_safety_product: boolean;
  sensing_mode: SensingMode | null;
  measurand: 'pressure' | 'level' | 'flow' | 'temperature' | null;

  sensing_range_min_mm: number | null;
  sensing_range_max_mm: number | null;
  switching_output: string | null;
  output_function: string | null;
  connection: string | null;
  enclosure_rating: string | null;
  housing_material: string | null;
  operating_temp_min_c: number | null;
  operating_temp_max_c: number | null;
  process_temp_min_c: number | null;
  process_temp_max_c: number | null;
  resolution_value: string | null;
  resolution_unit: string | null;
  interface: string | null;
  response_time_ms: number | null;
  supply_voltage_min_v: number | null;
  supply_voltage_max_v: number | null;
  sensor_principle: string | null;
  detection_principle: string | null;
  light_type: string | null;
  scope_of_delivery: string | null;

  ip_ingress: number | null;
  ip_water: number | null;
  washdown_capable: boolean | null;

  mounting_type: string | null;
  housing_form: string | null;
  process_connection: string | null;
  probe_length_mm: number | null;
  process_pressure_raw: string | null;
  measuring_range_raw: string | null;
  protective_field_height_mm: number | null;
  safety_resolution_mm: number | null;
  beam_count: number | null;
  output_signal: string | null;
  fork_width_mm: number | null;
  fork_depth_mm: number | null;
  reading_window_raw: string | null;
  focus: string | null;
  shaft_diameter_raw: string | null;
  seal_material: string | null;

  protocols: string[];
  search_blob: string;
  other_specs: Record<string, string>;
  derived_from: Record<string, string>;
  low_confidence: string[];
  accessory_order_numbers: string[];
}

/** A sensing mode the problem argues for or against, with the engineering reason. */
export interface ModeOpinion {
  mode: SensingMode;
  reason: string;
}

/** Budget as stated by the user. Recorded, never scored — the catalog has no prices. */
export interface Budget {
  amount: number;
  currency: string;
  per: string;
}

/**
 * The structured form of the user's problem. Produced by the LLM parse step,
 * consumed by the deterministic scorer.
 */
export interface Requirement {
  restated_problem: string;
  language: 'es' | 'en';
  industry: string | null;
  application: string | null;
  inferred_needs: string[];

  solution_classes: SolutionClass[];
  preferred_sensing_modes: ModeOpinion[];
  discouraged_sensing_modes: ModeOpinion[];

  target_distance_mm: number | null;
  /** Height of the opening a light curtain must cover, in mm. */
  required_protective_field_height_mm: number | null;
  /** Smallest object a light curtain must detect, in mm (14 = finger, 30 = hand). Lower is finer. */
  required_safety_resolution_mm: number | null;
  min_ip_ingress: number | null;
  min_ip_water: number | null;
  washdown_required: boolean;
  min_ambient_temp_c: number | null;
  max_ambient_temp_c: number | null;
  required_protocols: string[];
  required_switching_output: 'PNP' | 'NPN' | null;
  max_response_time_ms: number | null;
  keywords: string[];

  budget: Budget | null;
  safety_related: boolean;
}

export type ConstraintStatus = 'satisfied' | 'violated' | 'unverified' | 'not_applicable';

/** Why a product scored the way it did on one constraint. */
export interface ConstraintOutcome {
  constraint: string;
  status: ConstraintStatus;
  detail: string;
  weight: number;
  /** 0..1 — only meaningful when status is `satisfied` or `violated`. */
  score: number;
}

export interface ScoredCandidate {
  product: EnrichedProduct;
  /** Weighted match across constraints the catalog could actually verify. 0..1 */
  fit: number;
  /** Share of applicable constraints the catalog could verify at all. 0..1 */
  evidence: number;
  /** Ranking key: fit tempered by evidence. */
  rank_score: number;
  outcomes: ConstraintOutcome[];
  /** Constraints that could not be checked — surfaced to the user verbatim. */
  unverified: string[];
  excluded_by: string | null;
}

export interface ScoringResult {
  candidates: ScoredCandidate[];
  /** Products removed by a stated, violating value — kept for explainability. */
  excluded: ScoredCandidate[];
  /** Set when nothing survived and a constraint had to be relaxed to return anything. */
  relaxed: { constraint: string; note: string } | null;
}
