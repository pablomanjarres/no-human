/**
 * `@no-human/rag` — the public surface.
 *
 * Hybrid retrieval and deterministic constraint solving over the SICK 2015/2016
 * summary catalog. Importing this barrel is the supported way to consume the
 * package; deep imports into `src/**` are not part of the contract and will move.
 *
 * ## What a consumer actually needs to know
 *
 * The package deliberately exposes *two* narrowing mechanisms and they are not
 * interchangeable:
 *
 * - {@link createRetriever} / {@link createCatalogTools} produce **candidates**
 *   ranked by text relevance. That ranking is a heuristic for mapping messy
 *   human language onto a shortlist. It is never evidence of anything.
 * - {@link evaluate} / {@link solve} / {@link prefilter} produce **verdicts**
 *   over normalized structured specs. A verdict is re-derivable by hand from the
 *   spec table on the cited page, which is why it is the only thing allowed to
 *   decide whether a part meets a requirement.
 *
 * Mixing those up is the one way to make this package lie. See
 * `docs/rag-index.md`.
 *
 * ## Why the CLI is not here
 *
 * `src/cli.ts` is a binary entry point: it reads `process.argv`, touches the
 * filesystem and writes to stdout. Re-exporting it would drag that side-effecting
 * module into every library import, so it is reachable only via the `sick-rag`
 * bin. Library code stays importable without a process environment.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export type {
  Catalog,
  ChunkKind,
  Citation,
  ConnectorType,
  ConstraintVerdict,
  IndexProvenance,
  NormalizedSpec,
  NumericConstraint,
  OutputType,
  RagChunk,
  RetrievalResult,
  RetrievalSignals,
  RowType,
  SearchOptions,
  SensingPrinciple,
  SerializedIndex,
  SickFamily,
  SickProduct,
  SolveResult,
  SpecConstraints,
} from "./types.js";

export {
  DEFAULT_CONTEXT_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_RERANK_MODEL,
  DEFAULT_RRF_K,
} from "./types.js";

// ---------------------------------------------------------------------------
// Corpus — disk to chunks
// ---------------------------------------------------------------------------

export {
  FAMILIES_FILE,
  indexByOrderNumber,
  loadCatalog,
  loadCatalogSync,
  PRODUCTS_FILE,
} from "./corpus/loadCatalog.js";

export {
  buildChunks,
  documentIdFor,
  groupChunksByDocument,
  NO_FAMILY_KEY,
  renderFamilyCard,
  renderSkuCard,
} from "./corpus/chunker.js";

// ---------------------------------------------------------------------------
// The deterministic half — normalization and the solver
// ---------------------------------------------------------------------------

export { normalizeAll, normalizeSpec } from "./filter/normalize.js";

export { evaluate, prefilter, solve } from "./filter/constraints.js";

// ---------------------------------------------------------------------------
// Index artifact
// ---------------------------------------------------------------------------

export type { SerializeIndexInput } from "./index/store.js";

export {
  decodeVector,
  decodeVectors,
  encodeVector,
  readIndex,
  readIndexSync,
  serializeIndex,
  stringifyIndex,
  validateIndex,
  writeIndex,
} from "./index/store.js";

export type { BuildIndexOptions } from "./buildIndex.js";

export { buildIndex } from "./buildIndex.js";

// ---------------------------------------------------------------------------
// Voyage lanes — both fail open, so neither is a hard dependency
// ---------------------------------------------------------------------------

export type { VoyageContextEmbedOptions, VoyageFetch } from "./embed/voyageContextEmbed.js";

export {
  hasVoyageKey,
  voyageContextEmbed,
  voyageContextEmbedQuery,
} from "./embed/voyageContextEmbed.js";

export type { RerankResult, VoyageRerankOptions } from "./embed/voyageRerank.js";

export { voyageRerank } from "./embed/voyageRerank.js";

// ---------------------------------------------------------------------------
// Retrieval and the agent surface
// ---------------------------------------------------------------------------

export type { Retriever, RetrieverDeps, SolveOptions } from "./retrieve.js";

export { createRetriever } from "./retrieve.js";

export type {
  CatalogRetrieverLike,
  CatalogTool,
  JsonSchema,
  SpecFieldReport,
  ToolInputSchema,
} from "./tools.js";

export { CatalogToolInputError, citationFor, createCatalogTools, describeSpecs } from "./tools.js";
