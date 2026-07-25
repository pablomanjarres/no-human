/**
 * Shared contract for the SICK catalog RAG layer.
 *
 * Every module in this package codes against these types. Nothing here does
 * I/O, network, or env access — it is a pure type + constant surface so the
 * corpus, index, embedding, filter, and retrieval layers can be built and
 * tested independently.
 *
 * ## The load-bearing architectural rule
 *
 * **Retrieval never picks the part.** This package returns *candidates* with
 * *citations*. Narrowing to a single recommendation is the job of the
 * deterministic constraint solver (`filter/constraints.ts`), which operates on
 * normalized structured fields — never on embedding similarity. Semantic search
 * exists to map messy human/competitor language onto a candidate set; the match
 * itself must be re-derivable by hand from the spec table.
 *
 * That split is what lets the agent answer "under 12 ms AND PNP AND IP69K"
 * correctly — a question pure vector search cannot answer.
 */

// ---------------------------------------------------------------------------
// Catalog source records (mirror of sick-catalog-dataset/products.jsonl)
// ---------------------------------------------------------------------------

/** Which kind of row this is in the printed catalog. */
export type RowType = "product" | "accessory";

/**
 * One orderable SKU exactly as extracted from the SICK 2015/2016 catalog.
 *
 * Field presence is faithful to the source: a field absent from the printed
 * page is `undefined` here, never defaulted or inferred. `provenance` records
 * the verbatim substring each populated field came from, and `lowConfidence`
 * lists fields read from prose/bullets rather than a labelled table cell.
 *
 * Property names are camelCase; the on-disk JSONL uses snake_case. The loader
 * (`corpus/loadCatalog.ts`) is the single place that translates between them.
 */
export interface SickProduct {
  /** SICK *Referencia* — exactly 7 digits. Primary key. */
  orderNumber: string;
  /** SICK *Tipo* — orderable type/order key, e.g. `GTB6-P4212`, `DT35-B15251`. */
  typeCode?: string;
  /** Product family heading, e.g. `G6`, `W4-3`, `DFS60`. */
  family?: string;
  /** Variant sub-series within a family, e.g. `GTE6` vs `GTB6`. */
  subfamily?: string;
  rowType: RowType;
  /** Catalog section name with English gloss, e.g. `Fotocelulas (Photoelectric sensors)`. */
  category: string;
  /** Section letter `B`–`N`. */
  section: string;
  /** Printed catalog page code, e.g. `B-16`. */
  sourcePage: string;
  /** 0-based page index in the source PDF. */
  pdfPage: number;
  /** How many catalog pages this SKU appears on. */
  occurrences: number;
  /** Other page codes this SKU appears on (shared accessories). */
  alsoOnPages: string[];
  /** Short description assembled from the family's descriptive bullets. */
  productName?: string;
  /** `www.mysick.com/...` link printed on the page, if any. */
  productUrl?: string;

  // -- Normalized numeric (units stripped, ranges split) --------------------
  sensingRangeMinMm?: number;
  sensingRangeMaxMm?: number;
  supplyVoltageMinV?: number;
  supplyVoltageMaxV?: number;
  outputCurrentMaxMa?: number;
  responseTimeMs?: number;
  switchingFrequencyHz?: number;
  operatingTempMinC?: number;
  operatingTempMaxC?: number;
  resolutionValue?: number;
  resolutionUnit?: string;

  // -- Categorical, verbatim Spanish ---------------------------------------
  switchingOutput?: string;
  outputFunction?: string;
  connection?: string;
  scopeOfDelivery?: string;
  sensorPrinciple?: string;
  detectionPrinciple?: string;
  lightType?: string;
  lightSpot?: string;
  adjustment?: string;
  enclosureRating?: string;
  housingMaterial?: string;
  interface?: string;
  shortDescription?: string;

  /** Any additional labelled spec not mapped to a named field. */
  otherSpecs?: Record<string, string>;
  /** Verbatim source substring for every populated field. */
  provenance?: Record<string, string>;
  /** Fields read from prose/bullets/footnotes rather than a labelled cell. */
  lowConfidence?: string[];
}

/** Family-level rollup (mirror of `families.csv`). */
export interface SickFamily {
  section: string;
  category: string;
  family: string;
  productVariants: number;
  accessoryRows: number;
  nPages: number;
  /** Printed page codes this family spans. */
  pages: string[];
  productUrl?: string;
}

/** Everything loaded from the dataset directory. */
export interface Catalog {
  products: SickProduct[];
  families: SickFamily[];
  /** Absolute path the catalog was loaded from — carried into citations. */
  sourceDir: string;
}

// ---------------------------------------------------------------------------
// Normalized specs — the deterministic solver's view of a SKU
// ---------------------------------------------------------------------------

/** Canonical transistor output type parsed out of the free-text Spanish field. */
export type OutputType = "PNP" | "NPN" | "PNP/NPN" | "push-pull" | "analog" | "relay" | "unknown";

/** Canonical electrical connection form. */
export type ConnectorType = "M8" | "M12" | "M5" | "cable" | "terminal" | "other" | "unknown";

/** Canonical sensing principle, normalized across Spanish surface forms. */
export type SensingPrinciple =
  | "diffuse" // fotocélula de detección sobre objeto / energética
  | "background-suppression" // supresión del fondo
  | "foreground-suppression" // supresión del primer plano
  | "retroreflective" // reflexión sobre espejo / autocolimación
  | "through-beam" // barrera de luz unidireccional
  | "inductive"
  | "capacitive"
  | "magnetic"
  | "ultrasonic"
  | "laser-distance"
  | "contrast"
  | "luminescence"
  | "color"
  | "fork"
  | "light-grid"
  | "safety-light-curtain"
  | "encoder"
  | "vision"
  | "identification"
  | "fluid"
  | "safety-switch"
  | "safety-controller"
  | "unknown";

/**
 * The machine-comparable projection of a {@link SickProduct}.
 *
 * Derived purely and deterministically by `filter/normalize.ts`. Every field is
 * optional: absent means "the catalog does not state it", which the solver must
 * treat as *unknown*, never as *fails the constraint*. Silently dropping a SKU
 * for an unstated spec is the single most dangerous failure mode here — it
 * produces a confident wrong answer instead of an honest "cannot verify".
 */
export interface NormalizedSpec {
  orderNumber: string;
  outputType?: OutputType;
  /** True when the switching-output text mentions IO-Link. */
  ioLink?: boolean;
  /** Number of switching outputs, when stated (e.g. `2 PNP` → 2). */
  outputCount?: number;
  outputCurrentMaxMa?: number;
  connector?: ConnectorType;
  /** Pin count on the connector, when stated (e.g. `M12 de 4 polos` → 4). */
  connectorPins?: number;
  /** IP rating as an integer, e.g. `IP 67` → 67, `IP 69K` → 69. */
  ipRating?: number;
  /** True when the enclosure rating is specifically IP69K. */
  ip69k?: boolean;
  sensingRangeMinMm?: number;
  sensingRangeMaxMm?: number;
  responseTimeMs?: number;
  switchingFrequencyHz?: number;
  supplyVoltageMinV?: number;
  supplyVoltageMaxV?: number;
  operatingTempMinC?: number;
  operatingTempMaxC?: number;
  principle?: SensingPrinciple;
  /**
   * Which catalog field `principle` was actually derived from.
   *
   * `"category"` means it was **inferred from the section heading**, not printed
   * on the page. That is materially weaker evidence than a printed
   * `Principio del sensor:` line, and the solver treats it as such: an inferred
   * principle may corroborate a constraint but must never *disqualify* a SKU.
   *
   * The catalog's sections are not all one-principle-per-section — the
   * optoelectronic-protection section holds light curtains, single-beam
   * barriers, *and* laser scanners — so a section-derived principle that
   * contradicts a constraint is far more likely to be our inference being wrong
   * than the part being unsuitable. Failing on it deletes correct parts.
   */
  principleSource?: "sensorPrinciple" | "detectionPrinciple" | "category";
  /** Housing material, lowercased canonical token: `plastic`, `metal`, `stainless-steel`. */
  housing?: "plastic" | "metal" | "stainless-steel" | "other";
  /** Light source, canonical: `red`, `infrared`, `laser`, `white`, `rgb`, `green`. */
  light?: "red" | "infrared" | "laser" | "white" | "rgb" | "green" | "other";
  /**
   * Field names whose normalization came from a `lowConfidence` source field.
   * Carried through so the agent can flag a spec it should double-check.
   */
  lowConfidence: string[];
}

// ---------------------------------------------------------------------------
// Constraint solving
// ---------------------------------------------------------------------------

/** A numeric constraint. All bounds inclusive. */
export interface NumericConstraint {
  min?: number;
  max?: number;
}

/**
 * The constraint set a replacement part must satisfy — the "spec vector" all
 * four input modalities (part number, description, label photo, BOM row)
 * collapse into.
 *
 * Every field is optional. An omitted field is *unconstrained*, not
 * "don't care about correctness" — the solver reports which constraints it
 * could actually verify per candidate.
 */
export interface SpecConstraints {
  outputType?: OutputType[];
  ioLink?: boolean;
  connector?: ConnectorType[];
  connectorPins?: number;
  /** Minimum acceptable IP rating (e.g. `67` accepts IP67 and IP69K). */
  minIpRating?: number;
  ip69k?: boolean;
  /** The sensor must be able to detect at this distance, in mm. */
  sensingRangeMm?: NumericConstraint;
  responseTimeMs?: NumericConstraint;
  switchingFrequencyHz?: NumericConstraint;
  supplyVoltageV?: NumericConstraint;
  /** The sensor must operate across this whole temperature window, in °C. */
  operatingTempC?: NumericConstraint;
  principle?: SensingPrinciple[];
  housing?: NormalizedSpec["housing"][];
  light?: NormalizedSpec["light"][];
  /** Restrict to a catalog section letter, e.g. `B` for photoelectric. */
  section?: string[];
  /** Restrict to `product` rows, `accessory` rows, or both. */
  rowType?: RowType[];
  /** Restrict to specific product families. */
  family?: string[];
}

/** Why a single constraint passed, failed, or could not be checked. */
export interface ConstraintVerdict {
  /** The constraint field, e.g. `outputType`, `sensingRangeMm`. */
  field: string;
  /** `pass` — verified from the catalog. `fail` — verified to violate.
   *  `unknown` — the catalog does not state this spec for this SKU. */
  status: "pass" | "fail" | "unknown";
  /** Human-readable statement of what was required and what was found. */
  detail: string;
  /** True when the underlying catalog field was flagged low-confidence. */
  lowConfidence?: boolean;
}

/** A candidate scored against a constraint set. */
export interface SolveResult {
  product: SickProduct;
  spec: NormalizedSpec;
  verdicts: ConstraintVerdict[];
  /** Count of constraints verified to pass. */
  passed: number;
  /** Count of constraints verified to violate. Any `failed > 0` disqualifies. */
  failed: number;
  /** Count of constraints the catalog cannot answer for this SKU. */
  unknown: number;
  /** True when `failed === 0`. Does NOT mean every constraint was verified. */
  viable: boolean;
}

// ---------------------------------------------------------------------------
// Chunking + indexing
// ---------------------------------------------------------------------------

/** What a chunk represents. Drives how it is rendered and cited. */
export type ChunkKind = "sku" | "family";

/**
 * One retrievable unit.
 *
 * Chunks are grouped into *documents* (one per product family) before being
 * sent to Voyage's contextualized-embedding endpoint, so each SKU's vector is
 * aware of its family's header card and sibling variants. That is the whole
 * reason for the contextualized model: a bare variant row like
 * `GTE6-P4212 · PNP · M8` carries almost no standalone semantics, but embedded
 * in the context of "G6 family — diffuse photoelectric sensor, visible red
 * light" it becomes searchable by an engineer's actual words.
 */
export interface RagChunk {
  /** Stable chunk id: `sku:<orderNumber>` or `family:<section>:<family>`. */
  id: string;
  kind: ChunkKind;
  /** The document this chunk belongs to — its family. Chunks sharing a
   *  `documentId` are embedded together in one contextualized call. */
  documentId: string;
  /** Position of this chunk within its document. */
  chunkIndex: number;
  /** The text that gets embedded and BM25-indexed. */
  text: string;
  /** SKU this chunk resolves to, for `kind: "sku"`. */
  orderNumber?: string;
  family?: string;
  section: string;
  category: string;
  rowType?: RowType;
  /** Printed catalog page code, for citation. */
  sourcePage: string;
  pdfPage: number;
}

/** Where a retrieved claim can be verified in the source document. */
export interface Citation {
  orderNumber?: string;
  typeCode?: string;
  family?: string;
  /** Printed catalog page code, e.g. `B-16`. */
  sourcePage: string;
  /** 0-based page index in `CATALOGO-PRODUCTOS-SICK.pdf`. */
  pdfPage: number;
  productUrl?: string;
}

/** Which retrieval lanes contributed to a hit, and how strongly. */
export interface RetrievalSignals {
  /** 0-based BM25 rank, or `null` when the lexical lane did not return it. */
  bm25Rank: number | null;
  bm25Score: number | null;
  /** 0-based dense rank, or `null` when the dense lane was unavailable. */
  denseRank: number | null;
  denseScore: number | null;
  /** 0-based rerank position, or `null` when reranking was unavailable. */
  rerankRank: number | null;
  rerankScore: number | null;
  /** Fused RRF score across whichever lanes were available. */
  rrfScore: number;
}

/** One retrieval hit. */
export interface RetrievalResult {
  chunk: RagChunk;
  /** The SKU this hit resolves to, when `chunk.kind === "sku"`. */
  product?: SickProduct;
  signals: RetrievalSignals;
  citation: Citation;
}

/** How an index was built — surfaced so the agent can state its own limits. */
export interface IndexProvenance {
  builtAt: string;
  /** Dataset directory the chunks were built from. */
  sourceDir: string;
  chunkCount: number;
  documentCount: number;
  productCount: number;
  /** Voyage contextualized model used, or `null` when built lexical-only. */
  embeddingModel: string | null;
  embeddingDimension: number | null;
  /** Chunks that actually carry a dense vector. */
  embeddedChunkCount: number;
}

/** The serialized index artifact written by `sick-rag index`. */
export interface SerializedIndex {
  /** Artifact schema version. Bump on any breaking shape change. */
  version: 1;
  provenance: IndexProvenance;
  chunks: RagChunk[];
  /** Base64 little-endian Float32 vectors, positionally aligned to `chunks`.
   *  `null` for chunks with no embedding (or when built lexical-only). */
  vectors: (string | null)[];
  /** Normalized specs, positionally aligned to `provenance.productCount`. */
  specs: NormalizedSpec[];
  products: SickProduct[];
  families: SickFamily[];
}

// ---------------------------------------------------------------------------
// Search options
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** How many results to return. Default 10. */
  topK?: number;
  /** How many candidates each lane contributes before fusion. Default 60. */
  candidateK?: number;
  /** Structured prefilter applied BEFORE ranking. This is what makes
   *  "PNP and IP69K and under 12 ms" answerable — the lanes only ever rank
   *  SKUs that already satisfy the hard constraints. */
  constraints?: SpecConstraints;
  /** Disable the Voyage cross-encoder rerank pass. Default false. */
  noRerank?: boolean;
  /** Disable the dense lane even when vectors are present. Default false. */
  noDense?: boolean;
  /** RRF smoothing constant. Default 60. */
  rrfK?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default contextualized-embedding model. Override with `VOYAGE_CONTEXT_MODEL`. */
export const DEFAULT_CONTEXT_MODEL = "voyage-context-3";
/** Default cross-encoder reranker. Override with `VOYAGE_RERANK_MODEL`. */
export const DEFAULT_RERANK_MODEL = "rerank-2.5";
/** Default embedding dimension. Voyage supports 256 / 512 / 1024 / 2048. */
export const DEFAULT_EMBEDDING_DIMENSION = 1024;
/** Canonical RRF smoothing constant (Cormack et al., 2009). */
export const DEFAULT_RRF_K = 60;
