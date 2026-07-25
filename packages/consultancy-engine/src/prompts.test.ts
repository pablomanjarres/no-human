import { describe, expect, it } from 'vitest';

import { buildAdjudicationUserPrompt, normalizeRequirement, validateAdjudication } from './prompts.js';
import { scoreProduct } from './score.js';
import { makeProduct, makeRequirement } from './testing/fixtures.js';

describe('normalizeRequirement', () => {
  it('keeps valid values', () => {
    const req = normalizeRequirement({
      restated_problem: 'detect bottles',
      language: 'es',
      solution_classes: ['photoelectric'],
      preferred_sensing_modes: [{ mode: 'retroreflective', reason: 'clear PET' }],
      target_distance_mm: 400,
      washdown_required: true,
      keywords: ['BOTELLA'],
      safety_related: false,
    });

    expect(req.language).toBe('es');
    expect(req.solution_classes).toEqual(['photoelectric']);
    expect(req.preferred_sensing_modes).toEqual([{ mode: 'retroreflective', reason: 'clear PET' }]);
    expect(req.target_distance_mm).toBe(400);
    expect(req.washdown_required).toBe(true);
    expect(req.keywords).toEqual(['botella']);
  });

  it('drops values outside the known taxonomies', () => {
    const req = normalizeRequirement({
      solution_classes: ['photoelectric', 'teleportation'],
      preferred_sensing_modes: [{ mode: 'not_a_mode', reason: 'x' }, { mode: 'diffuse', reason: 'y' }],
      required_switching_output: 'MAYBE',
    });

    expect(req.solution_classes).toEqual(['photoelectric']);
    expect(req.preferred_sensing_modes).toEqual([{ mode: 'diffuse', reason: 'y' }]);
    expect(req.required_switching_output).toBeNull();
  });

  it('survives an empty or malformed response', () => {
    const req = normalizeRequirement(null);
    expect(req.solution_classes).toEqual([]);
    expect(req.target_distance_mm).toBeNull();
    expect(req.washdown_required).toBe(false);
    expect(req.budget).toBeNull();
  });

  it('reads a budget when one is stated', () => {
    const req = normalizeRequirement({ budget: { amount: 200, currency: 'EUR', per: 'unit' } });
    expect(req.budget).toEqual({ amount: 200, currency: 'EUR', per: 'unit' });
  });
});

/**
 * The anti-hallucination invariant, enforced in code rather than requested in
 * the prompt: the adjudicator can only return SKUs it was actually handed.
 */
describe('validateAdjudication', () => {
  const allowed = new Set(['1051781', '1052723']);

  it('accepts a recommendation drawn from the candidate set', () => {
    const { adjudication, dropped } = validateAdjudication(
      {
        summary: 'ok',
        recommendation: { order_number: '1051781', why: ['reaches 300 mm'], caveats: [] },
        alternatives: [{ order_number: '1052723', tradeoff_vs_primary: 'shorter range' }],
      },
      allowed,
    );

    expect(adjudication?.recommendation.order_number).toBe('1051781');
    expect(adjudication?.alternatives).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it('rejects a fabricated primary recommendation', () => {
    const { adjudication, dropped } = validateAdjudication(
      { summary: 'x', recommendation: { order_number: '9999999', why: [], caveats: [] }, alternatives: [] },
      allowed,
    );

    expect(adjudication).toBeNull();
    expect(dropped).toEqual(['9999999']);
  });

  it('drops fabricated alternatives but keeps a valid primary', () => {
    const { adjudication, dropped } = validateAdjudication(
      {
        summary: 'x',
        recommendation: { order_number: '1051781', why: [], caveats: [] },
        alternatives: [
          { order_number: '0000000', tradeoff_vs_primary: 'invented' },
          { order_number: '1052723', tradeoff_vs_primary: 'real' },
        ],
      },
      allowed,
    );

    expect(adjudication?.recommendation.order_number).toBe('1051781');
    expect(adjudication?.alternatives.map((a) => a.order_number)).toEqual(['1052723']);
    expect(dropped).toEqual(['0000000']);
  });

  it('does not repeat the primary as its own alternative', () => {
    const { adjudication } = validateAdjudication(
      {
        summary: 'x',
        recommendation: { order_number: '1051781', why: [], caveats: [] },
        alternatives: [{ order_number: '1051781', tradeoff_vs_primary: 'same thing' }],
      },
      allowed,
    );
    expect(adjudication?.alternatives).toEqual([]);
  });

  it('rejects a malformed response', () => {
    expect(validateAdjudication('nonsense', allowed).adjudication).toBeNull();
    expect(validateAdjudication({}, allowed).adjudication).toBeNull();
  });
});

describe('buildAdjudicationUserPrompt', () => {
  it('shows the model the constraint trace, not just a score', () => {
    const req = makeRequirement({ restated_problem: 'detect bottles', target_distance_mm: 300 });
    const candidate = scoreProduct(
      makeProduct({ order_number: '1051781', sensing_range_max_mm: 400 }),
      req,
    );

    const prompt = buildAdjudicationUserPrompt(req, [candidate]);

    expect(prompt).toContain('order_number=1051781');
    expect(prompt).toContain('sensing_range [satisfied]');
    expect(prompt).toContain('choose only from these');
  });
});
