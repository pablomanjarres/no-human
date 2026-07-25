export { Catalog, loadCatalog } from './catalog.js';
export { rangeFitScore, scoreCatalog, scoreProduct } from './score.js';
export type { ScoreOptions } from './score.js';
export {
  ADJUDICATION_SCHEMA,
  ADJUDICATION_SYSTEM_PROMPT,
  PARSE_SYSTEM_PROMPT,
  REQUIREMENT_SCHEMA,
  buildAdjudicationUserPrompt,
  buildParseUserPrompt,
  normalizeRequirement,
  validateAdjudication,
} from './prompts.js';
export type { Adjudication, AdjudicationValidation } from './prompts.js';
export { consult, consultWithRequirement, detectLanguage, fallbackRequirement } from './consult.js';
export type { ConsultInput, ConsultResult, LlmClient, ProductAnswer } from './consult.js';
export { SENSING_MODES, SOLUTION_CLASSES } from './types.js';
export type {
  ConstraintOutcome,
  ConstraintStatus,
  EnrichedProduct,
  ModeOpinion,
  Requirement,
  ScoredCandidate,
  ScoringResult,
  SensingMode,
  SolutionClass,
} from './types.js';
