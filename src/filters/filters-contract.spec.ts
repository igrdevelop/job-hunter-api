import { readFileSync } from 'fs';
import { join } from 'path';
import { mergeFilters, validateOverrides } from './filters-validator';

interface ContractFixture {
  v: number;
  valid: { name: string; overrides: Record<string, unknown> }[];
  invalid: {
    name: string;
    overrides: Record<string, unknown>;
    error_keys: string[];
  }[];
  merge: {
    name: string;
    defaults_subset: Record<string, unknown>;
    overrides: Record<string, unknown>;
    expected_effective: Record<string, unknown>;
  }[];
}

const fixturePath = join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'filters_contract_v1.json',
);

const fixture = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as ContractFixture;

describe('filters_contract_v1', () => {
  it('has version 1', () => {
    expect(fixture.v).toBe(1);
  });

  describe('valid', () => {
    it.each(fixture.valid.map((c) => [c.name, c] as const))(
      '%s',
      (_name, c) => {
        const result = validateOverrides(c.overrides);
        expect(result.ok).toBe(true);
      },
    );
  });

  describe('invalid', () => {
    it.each(fixture.invalid.map((c) => [c.name, c] as const))(
      '%s',
      (_name, c) => {
        const result = validateOverrides(c.overrides);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          for (const key of c.error_keys) {
            // Bracket keys like exclude_patterns[1] are not Jest path segments.
            expect(result.errors[key]).toBeDefined();
          }
        }
      },
    );
  });

  describe('merge', () => {
    it.each(fixture.merge.map((c) => [c.name, c] as const))(
      '%s',
      (_name, c) => {
        const effective = mergeFilters(
          c.defaults_subset as Parameters<typeof mergeFilters>[0],
          c.overrides as Parameters<typeof mergeFilters>[1],
        );
        expect(effective).toEqual(c.expected_effective);
      },
    );
  });
});
