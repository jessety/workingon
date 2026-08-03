/**
 * Sanitization for anything user-derived.
 *
 * Everything that ends up in the activity buffer — and therefore, eventually, at the
 * Anthropic API — passes through `clean()`. Keep it that way: route new text through here
 * rather than storing it raw.
 */

/** Longest recorded prompt excerpt */
export const MAX_PROMPT = 300;
/** Longest recorded detail line (tool subjects, decisions, notification types) */
export const MAX_DETAIL = 200;
/** Longest recorded excerpt of the agent's closing message */
export const MAX_ASSISTANT = 300;

/**
 * Blunt redaction for values that look like credentials.
 *
 * Activity text is sent to the Anthropic API, and a shell command is the most
 * likely place for a token to show up. This is a safety net, not a guarantee.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Common vendor-prefixed key formats
  /\b(?:sk|pk|rk|sw|ghp|gho|ghs|ghu|github_pat|xox[abposr])[-_][A-Za-z0-9_-]{8,}/gi,
  // KEY=value / KEY: value assignments for secret-sounding names
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
];

export function redact(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, name: string | undefined) =>
      typeof name === 'string' ? `${name}=[redacted]` : '[redacted]',
    );
  }
  return output;
}

/** Collapse whitespace, redact secrets, and cap length */
export function clean(value: string, max: number): string {
  const collapsed = redact(value).replace(/\s+/g, ' ').trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max - 1)}…`;
}
