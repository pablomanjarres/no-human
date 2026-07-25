import { describe, expect, it } from 'vitest';

import { rangeFitScore, scoreCatalog, scoreProduct } from './score.js';
import { makeProduct, makeRequirement } from './testing/fixtures.js';

/**
 * The central invariant. The SICK summary catalog states a communication
 * interface for 19% of products and an ambient temperature range for 7%.
 * If an unstated field disqualified a product, realistic queries would return
 * nothing — so absence must never exclude.
 */
describe('absence never disqualifies', () => {
  it('keeps a product whose IP rating the catalog does not state', () => {
    const product = makeProduct({ enclosure_rating: null, ip_ingress: null, ip_water: null });
    const req = makeRequirement({ min_ip_ingress: 6, min_ip_water: 9, washdown_required: true });

    const scored = scoreProduct(product, req);

    expect(scored.excluded_by).toBeNull();
    expect(scored.outcomes.find((o) => o.constraint === 'ingress_protection')?.status).toBe('unverified');
    expect(scored.unverified.join(' ')).toContain('enclosure rating');
  });

  it('keeps a product whose protocol the catalog does not state', () => {
    const scored = scoreProduct(
      makeProduct({ protocols: [] }),
      makeRequirement({ required_protocols: ['IO-Link'] }),
    );
    expect(scored.excluded_by).toBeNull();
    expect(scored.outcomes.find((o) => o.constraint === 'communication_protocol')?.status).toBe('unverified');
  });

  it('lowers the evidence score instead of the fit score when data is missing', () => {
    const req = makeRequirement({ target_distance_mm: 300, min_ip_ingress: 6 });
    const stated = scoreProduct(
      makeProduct({ sensing_range_max_mm: 500, enclosure_rating: 'IP 67', ip_ingress: 6, ip_water: 7 }),
      req,
    );
    const silent = scoreProduct(makeProduct({ sensing_range_max_mm: 500 }), req);

    // Same technical fit on what could be checked...
    expect(silent.fit).toBeCloseTo(stated.fit, 5);
    // ...but the honest signal is that less of it was verifiable.
    expect(silent.evidence).toBeLessThan(stated.evidence);
    expect(silent.rank_score).toBeLessThan(stated.rank_score);
  });
});

describe('a stated, violating value does disqualify', () => {
  it('excludes a sensor that cannot reach the target', () => {
    const scored = scoreProduct(
      makeProduct({ sensing_range_max_mm: 200 }),
      makeRequirement({ target_distance_mm: 300 }),
    );
    expect(scored.excluded_by).toBe('sensing_range');
  });

  it('excludes a target inside the stated blind zone', () => {
    const scored = scoreProduct(
      makeProduct({ sensing_range_min_mm: 200, sensing_range_max_mm: 2000 }),
      makeRequirement({ target_distance_mm: 100 }),
    );
    expect(scored.excluded_by).toBe('sensing_range');
  });

  it('excludes an IP65 sensor from a washdown application', () => {
    const scored = scoreProduct(
      makeProduct({ enclosure_rating: 'IP 65', ip_ingress: 6, ip_water: 5, washdown_capable: false }),
      makeRequirement({ washdown_required: true }),
    );
    expect(scored.excluded_by).toBe('ingress_protection');
  });

  it('excludes a detection principle the application rules out', () => {
    const scored = scoreProduct(
      makeProduct({ sensing_mode: 'diffuse' }),
      makeRequirement({
        discouraged_sensing_modes: [{ mode: 'diffuse', reason: 'clear PET passes the beam through' }],
      }),
    );
    expect(scored.excluded_by).toBe('sensing_mode');
  });

  it('excludes the wrong kind of device entirely', () => {
    const scored = scoreProduct(
      makeProduct({ solution_class: 'encoder' }),
      makeRequirement({ solution_classes: ['photoelectric'] }),
    );
    expect(scored.excluded_by).toBe('solution_class');
  });
});

/**
 * Light-curtain selection turns on two numbers. Getting either wrong leaves a
 * machine guard that does not actually guard.
 */
describe('safety light curtain selection', () => {
  it('excludes a curtain shorter than the opening', () => {
    const scored = scoreProduct(
      makeProduct({ protective_field_height_mm: 300, is_safety_product: true }),
      makeRequirement({ required_protective_field_height_mm: 900 }),
    );
    expect(scored.excluded_by).toBe('protective_field_height');
  });

  it('prefers the curtain that covers the opening with least excess', () => {
    const req = makeRequirement({ required_protective_field_height_mm: 900 });
    const exact = scoreProduct(makeProduct({ protective_field_height_mm: 900 }), req);
    const oversized = scoreProduct(makeProduct({ protective_field_height_mm: 2100 }), req);

    expect(exact.excluded_by).toBeNull();
    expect(oversized.excluded_by).toBeNull();
    expect(exact.fit).toBeGreaterThan(oversized.fit);
  });

  it('excludes a resolution too coarse to detect the body part at risk', () => {
    const scored = scoreProduct(
      makeProduct({ safety_resolution_mm: 30 }),
      makeRequirement({ required_safety_resolution_mm: 14 }),
    );
    expect(scored.excluded_by).toBe('safety_resolution');
    expect(scored.outcomes.find((o) => o.constraint === 'safety_resolution')?.detail).toContain('too coarse');
  });

  it('accepts a finer resolution than required', () => {
    const scored = scoreProduct(
      makeProduct({ safety_resolution_mm: 14 }),
      makeRequirement({ required_safety_resolution_mm: 30 }),
    );
    expect(scored.excluded_by).toBeNull();
  });

  it('does not exclude a curtain whose field height the catalog omits', () => {
    const scored = scoreProduct(
      makeProduct({ protective_field_height_mm: null }),
      makeRequirement({ required_protective_field_height_mm: 900 }),
    );
    expect(scored.excluded_by).toBeNull();
    expect(scored.unverified.join(' ')).toContain('protective field height');
  });
});

describe('protocol is a soft signal, never a hard filter', () => {
  it('does not exclude a product that states other protocols', () => {
    const scored = scoreProduct(
      makeProduct({ protocols: ['4-20mA'] }),
      makeRequirement({ required_protocols: ['IO-Link'] }),
    );
    // The catalog's interface list is not exhaustive, so a mismatch is not a violation.
    expect(scored.excluded_by).toBeNull();
    const outcome = scored.outcomes.find((o) => o.constraint === 'communication_protocol');
    expect(outcome?.status).toBe('satisfied');
    expect(outcome?.score).toBe(0);
  });

  it('boosts a product that states the requested protocol', () => {
    const scored = scoreProduct(
      makeProduct({ protocols: ['IO-Link'] }),
      makeRequirement({ required_protocols: ['IO-Link'] }),
    );
    expect(scored.outcomes.find((o) => o.constraint === 'communication_protocol')?.score).toBe(1);
  });
});

describe('rangeFitScore', () => {
  it('rejects a sensor that falls short', () => {
    expect(rangeFitScore(300, 200)).toBe(0);
  });

  it('prefers installation margin over a bare pass', () => {
    expect(rangeFitScore(300, 400)).toBeGreaterThan(rangeFitScore(300, 310));
  });

  it('scores the ideal band at full marks', () => {
    expect(rangeFitScore(300, 450)).toBe(1);
    expect(rangeFitScore(300, 600)).toBe(1);
  });

  it('penalises gross over-specification without disqualifying it', () => {
    const over = rangeFitScore(300, 6000);
    expect(over).toBeLessThan(1);
    expect(over).toBeGreaterThan(0);
  });
});

describe('scoreCatalog', () => {
  const catalogue = [
    makeProduct({ order_number: '1', sensing_range_max_mm: 400, sensing_mode: 'retroreflective' }),
    makeProduct({ order_number: '2', sensing_range_max_mm: 100, sensing_mode: 'retroreflective' }),
    makeProduct({ order_number: '3', row_type: 'accessory', sensing_range_max_mm: 400 }),
  ];

  it('ranks survivors and reports exclusions', () => {
    const result = scoreCatalog(catalogue, makeRequirement({ target_distance_mm: 300 }));
    expect(result.candidates.map((c) => c.product.order_number)).toEqual(['1']);
    expect(result.excluded.map((c) => c.product.order_number)).toEqual(['2']);
    expect(result.relaxed).toBeNull();
  });

  it('excludes accessories from the ranking by default', () => {
    const result = scoreCatalog(catalogue, makeRequirement());
    expect(result.candidates.map((c) => c.product.order_number)).not.toContain('3');
  });

  it('relaxes a constraint rather than returning nothing', () => {
    const result = scoreCatalog(catalogue, makeRequirement({ target_distance_mm: 99_999 }));
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.relaxed).not.toBeNull();
    expect(result.relaxed?.note).toContain('relax');
  });
});
