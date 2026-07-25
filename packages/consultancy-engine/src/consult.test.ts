import { describe, expect, it } from 'vitest';

import { Catalog } from './catalog.js';
import {
  consult,
  consultWithRequirement,
  detectLanguage,
  fallbackRequirement,
  type LlmClient,
} from './consult.js';
import { makeProduct, makeRequirement } from './testing/fixtures.js';

const catalog = new Catalog([
  makeProduct({
    order_number: '1051781',
    type_code: 'WL12-2',
    family: 'W12-2',
    sensing_mode: 'retroreflective',
    sensing_range_max_mm: 4000,
    enclosure_rating: 'IP 67',
    ip_ingress: 6,
    ip_water: 7,
    accessory_order_numbers: ['5308805'],
    search_blob: 'barrera fotoelectrica de reflexion botella',
  }),
  makeProduct({
    order_number: '1052723',
    type_code: 'WT12-2',
    family: 'W12-2',
    sensing_mode: 'diffuse',
    sensing_range_max_mm: 800,
  }),
  makeProduct({
    order_number: '5308805',
    type_code: 'BEF-WN-W12',
    row_type: 'accessory',
    short_description: 'Escuadra de fijación',
  }),
  makeProduct({
    order_number: '1219615',
    type_code: 'deTec4 Core',
    solution_class: 'safety_optoelectronic',
    sensing_mode: 'safety_light_curtain',
    is_safety_product: true,
    protective_field_height_mm: 900,
    sensing_range_max_mm: 6000,
  }),
]);

/** An LLM stand-in, so the whole orchestration is testable without a network. */
function fakeLlm(responses: { parse?: unknown; adjudicate?: unknown; throwOn?: 'parse' | 'adjudicate' }): LlmClient {
  return {
    async structured({ purpose }) {
      if (responses.throwOn === purpose) throw new Error(`${purpose} failed`);
      return purpose === 'parse' ? responses.parse : responses.adjudicate;
    },
  };
}

describe('consult', () => {
  const parsed = {
    restated_problem: 'Detectar botellas PET transparentes en cinta',
    language: 'es',
    inferred_needs: ['El PET transparente no se detecta por reflexión difusa'],
    solution_classes: ['photoelectric'],
    preferred_sensing_modes: [{ mode: 'retroreflective', reason: 'atraviesa el PET transparente' }],
    discouraged_sensing_modes: [{ mode: 'diffuse', reason: 'el haz atraviesa el objeto' }],
    target_distance_mm: 2000,
    keywords: ['botella'],
    washdown_required: false,
    safety_related: false,
  };

  it('runs parse, scoring and adjudication end to end', async () => {
    const llm = fakeLlm({
      parse: parsed,
      adjudicate: {
        summary: 'La barrera de reflexión es la opción correcta.',
        recommendation: {
          order_number: '1051781',
          why: ['Detecta PET transparente por reflexión'],
          caveats: ['Confirmar el reflector'],
        },
        alternatives: [],
      },
    });

    const result = await consult(catalog, { problem_description: 'botellas PET' }, llm);

    expect(result.recommendation?.order_number).toBe('1051781');
    expect(result.summary).toContain('reflexión');
    expect(result.diagnostics.llm_parse).toBe(true);
    expect(result.diagnostics.llm_adjudication).toBe(true);
    expect(result.understood_problem.inferred_needs).toHaveLength(1);
    // The diffuse sensor was ruled out by the application, not by a missing spec.
    expect(result.alternatives.map((a) => a.order_number)).not.toContain('1052723');
  });

  it('offers accessories that complete the installation', async () => {
    const llm = fakeLlm({
      parse: parsed,
      adjudicate: {
        summary: 'ok',
        recommendation: { order_number: '1051781', why: [], caveats: [] },
        alternatives: [],
      },
    });

    const result = await consult(catalog, { problem_description: 'botellas' }, llm);
    expect(result.complete_the_solution.map((a) => a.order_number)).toContain('5308805');
  });

  it('ignores a hallucinated SKU and keeps the deterministic answer', async () => {
    const llm = fakeLlm({
      parse: parsed,
      adjudicate: {
        summary: 'invented',
        recommendation: { order_number: '9999999', why: ['does not exist'], caveats: [] },
        alternatives: [],
      },
    });

    const result = await consult(catalog, { problem_description: 'botellas' }, llm);

    expect(result.diagnostics.dropped_order_numbers).toContain('9999999');
    expect(result.diagnostics.llm_adjudication).toBe(false);
    expect(result.recommendation?.order_number).toBe('1051781');
    expect(catalog.has(result.recommendation?.order_number ?? '')).toBe(true);
  });

  it('degrades to deterministic ranking when the model is unavailable', async () => {
    const result = await consult(catalog, { problem_description: 'detect a bottle at 2000 mm' }, null);

    expect(result.recommendation).not.toBeNull();
    expect(result.diagnostics.llm_parse).toBe(false);
    expect(result.diagnostics.llm_adjudication).toBe(false);
    expect(result.recommendation?.why.length).toBeGreaterThan(0);
  });

  it('still answers when the parse step fails', async () => {
    const llm = fakeLlm({ throwOn: 'parse' });
    const result = await consult(catalog, { problem_description: 'something' }, llm);
    expect(result.diagnostics.llm_parse).toBe(false);
    expect(result.recommendation).not.toBeNull();
  });

  it('still answers when the adjudication step fails', async () => {
    const llm = fakeLlm({ parse: parsed, throwOn: 'adjudicate' });
    const result = await consult(catalog, { problem_description: 'botellas' }, llm);
    expect(result.diagnostics.llm_parse).toBe(true);
    expect(result.diagnostics.llm_adjudication).toBe(false);
    expect(result.recommendation?.order_number).toBe('1051781');
  });
});

describe('honesty about what the catalog cannot answer', () => {
  it('reports budget as not applied instead of silently ignoring it', () => {
    const result = consultWithRequirement(
      catalog,
      makeRequirement({ budget: { amount: 200, currency: 'EUR', per: 'unit' }, language: 'en' }),
    );

    expect(result.not_applied).toHaveLength(1);
    expect(result.not_applied[0]).toContain('no pricing');
    expect(result.not_applied[0]).toContain('200 EUR/unit');
  });

  it('attaches a functional-safety notice to safety products', () => {
    const result = consultWithRequirement(
      catalog,
      makeRequirement({ solution_classes: ['safety_optoelectronic'], language: 'en' }),
    );

    expect(result.recommendation?.is_safety_product).toBe(true);
    expect(result.notices.join(' ')).toContain('EN ISO 13849');
  });

  it('does not attach a safety notice to an ordinary photoelectric answer', () => {
    const result = consultWithRequirement(
      catalog,
      makeRequirement({ solution_classes: ['photoelectric'], language: 'en' }),
    );
    expect(result.notices.join(' ')).not.toContain('EN ISO 13849');
  });

  it('surfaces unverified specs rather than asserting them', () => {
    const result = consultWithRequirement(
      catalog,
      makeRequirement({ solution_classes: ['photoelectric'], required_protocols: ['IO-Link'], language: 'en' }),
    );
    expect(result.unverified.join(' ')).toContain('communication interface');
  });

  it('says so plainly when nothing matches', () => {
    const empty = new Catalog([]);
    const result = consultWithRequirement(empty, makeRequirement({ language: 'en' }));
    expect(result.recommendation).toBeNull();
    expect(result.notices.join(' ')).toContain('No product');
  });
});

describe('no-model fallback quality', () => {
  it('answers in Spanish even when accents are omitted', () => {
    expect(detectLanguage('Necesito detectar botellas en una cinta a 2 metros')).toBe('es');
    expect(detectLanguage('I need to detect bottles on a conveyor belt')).toBe('en');
  });

  it('drops filler words that would hijack the keyword match', () => {
    const req = fallbackRequirement({
      problem_description: 'Necesito detectar botellas transparentes con lavado a presion',
    });
    expect(req.keywords).not.toContain('necesito');
    expect(req.keywords).not.toContain('detectar');
    expect(req.keywords).toContain('botellas');
  });
});
