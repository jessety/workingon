import { clamp } from '../src/summarize.js';

describe('clamp', () => {
  test('leaves a short status untouched', () => {
    expect(clamp('Refactoring the auth middleware', 100)).toBe(
      'Refactoring the auth middleware',
    );
  });

  test('collapses whitespace', () => {
    expect(clamp('  Fixing\n  the   build  ', 100)).toBe('Fixing the build');
  });

  test('never exceeds the limit', () => {
    const long =
      'Upgrading the TypeScript toolchain across every package in the monorepo today';
    const result = clamp(long, 40);

    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith('…')).toBe(true);
  });

  test('cuts at a word boundary when one is close to the limit', () => {
    const result = clamp('Refactoring the authentication middleware layer', 30);
    expect(result).not.toMatch(/\s…$/);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  test('handles a single long word without a boundary', () => {
    const result = clamp('a'.repeat(200), 20);
    expect(result).toHaveLength(20);
  });
});
