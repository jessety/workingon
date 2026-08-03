import { clean, redact } from '../src/activity/sanitize.js';

describe('redact', () => {
  test('redacts vendor-prefixed keys', () => {
    expect(
      redact('curl -H "x-api-key: sk-ant-abcdef1234567890"'),
    ).not.toContain('abcdef1234567890');
    expect(redact('export GH=ghp_aaaaaaaaaaaaaaaaaaaa')).toContain(
      '[redacted]',
    );
  });

  test('redacts secret-sounding assignments but keeps the variable name', () => {
    const output = redact('SOWORK_API_KEY=supersecretvalue npm start');
    expect(output).toContain('SOWORK_API_KEY=[redacted]');
    expect(output).not.toContain('supersecretvalue');
  });

  test('leaves ordinary commands alone', () => {
    expect(redact('npm run build && git status')).toBe(
      'npm run build && git status',
    );
  });
});

describe('clean', () => {
  test('collapses whitespace', () => {
    expect(clean('a  \n  b\tc', 100)).toBe('a b c');
  });

  test('truncates with an ellipsis at the limit', () => {
    const result = clean('x'.repeat(50), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith('…')).toBe(true);
  });
});
