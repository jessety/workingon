/** Minimal leveled logger. Structured enough to grep, small enough to not need a dependency. */

type Level = 'debug' | 'info' | 'warn' | 'error';

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

function emit(level: Level, message: string, detail?: unknown): void {
  if (level === 'debug' && verbose === false) {
    return;
  }

  const line = `${new Date().toISOString()} [${level}] ${message}`;
  const stream =
    level === 'error' || level === 'warn' ? console.error : console.log;

  if (detail === undefined) {
    stream(line);
  } else {
    stream(line, detail);
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => emit('debug', message, detail),
  info: (message: string, detail?: unknown) => emit('info', message, detail),
  warn: (message: string, detail?: unknown) => emit('warn', message, detail),
  error: (message: string, detail?: unknown) => emit('error', message, detail),
};

/** Render an unknown thrown value as a log-safe string */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Describe a value's structure without revealing its contents.
 *
 * For diagnosing hook payloads, whose field names have differed from the published
 * reference more than once — this logs `{ prompt: string(42) }`, never the prompt.
 */
export function describeShape(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return depth > 2
      ? 'array'
      : `array[${value.length}] of ${describeShape(value[0], depth + 1)}`;
  }
  if (typeof value === 'object') {
    if (depth > 2) {
      return 'object';
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, depth === 0 ? 32 : 8)
      .map(([key, nested]) => `${key}: ${describeShape(nested, depth + 1)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return typeof value === 'string' ? `string(${value.length})` : typeof value;
}
