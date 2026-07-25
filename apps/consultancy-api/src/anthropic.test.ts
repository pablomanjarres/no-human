import { describe, expect, it } from 'vitest';

import { extractJson } from './anthropic.js';

describe('extractJson', () => {
  it('parses a structured-output response', () => {
    expect(extractJson([{ type: 'text', text: '{"restated_problem":"x"}' }])).toEqual({
      restated_problem: 'x',
    });
  });

  it('joins text split across blocks', () => {
    expect(extractJson([{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }])).toEqual({ a: 1 });
  });

  it('ignores non-text blocks', () => {
    expect(extractJson([{ type: 'thinking' }, { type: 'text', text: '{"a":1}' }])).toEqual({ a: 1 });
  });

  it('throws rather than returning a silent empty result', () => {
    expect(() => extractJson([])).toThrow('no text content');
    expect(() => extractJson([{ type: 'thinking' }])).toThrow('no text content');
  });
});
