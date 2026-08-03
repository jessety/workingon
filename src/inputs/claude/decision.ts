import { MAX_DETAIL, clean } from '../../activity/sanitize.js';

/**
 * Parsing for `AskUserQuestion` — the one tool whose result this service reads.
 *
 * Its result is the person's own answer to a question their agent asked, not machine
 * output, which is why it is exempt from the drop-all-tool-results rule. Only the
 * question topics and the chosen option labels are kept.
 */

/** Older/looser shape: `"question"="chosen label", "question"="chosen label"` as prose */
const ANSWER = /"=\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * The structured answers Claude Code returns: `answers` maps each question's full text to
 * the option the person picked.
 */
function answerMap(result: unknown): Map<string, string> | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }

  const answers = (result as Record<string, unknown>).answers;
  if (typeof answers !== 'object' || answers === null) {
    return undefined;
  }

  const map = new Map<string, string>();
  for (const [question, choice] of Object.entries(
    answers as Record<string, unknown>,
  )) {
    if (typeof choice === 'string' && choice.trim() !== '') {
      map.set(question, choice.trim());
    }
  }

  return map.size === 0 ? undefined : map;
}

/**
 * Read the text out of a tool result.
 *
 * Deliberately tolerant: a result may be a bare string, an object wrapping one, or the
 * array-of-content-blocks shape tool results often take. Guessing wrong here fails quietly,
 * so it tries the plausible shapes rather than assuming one.
 */
export function resultText(result: unknown, depth = 0): string | undefined {
  if (typeof result === 'string') {
    return result;
  }
  if (depth > 3) {
    return undefined;
  }
  if (Array.isArray(result)) {
    const parts = result
      .map((entry) => resultText(entry, depth + 1))
      .filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(' ');
  }
  if (typeof result === 'object' && result !== null) {
    for (const key of [
      'content',
      'text',
      'output',
      'result',
      'response',
      'answers',
    ]) {
      const nested = resultText(
        (result as Record<string, unknown>)[key],
        depth + 1,
      );
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * Describe an `AskUserQuestion` call as the decisions the person made.
 *
 * The topics come from the tool's input (`header` is a short label the agent wrote per
 * question); the choices come from the result's structured `answers` map, keyed by each
 * question's full text. If the result is shaped differently — the prose fallback covers a
 * format that could be reworded by any Claude Code release — this degrades to reporting
 * the topics alone rather than breaking.
 */
export function describeDecision(
  toolInput: Record<string, unknown> | undefined,
  toolResult: unknown,
): string {
  const asked = (
    Array.isArray(toolInput?.questions) ? toolInput.questions : []
  ).map((entry) => {
    const question = entry as Record<string, unknown> | null;
    return {
      header:
        typeof question?.header === 'string' ? question.header : undefined,
      text:
        typeof question?.question === 'string' ? question.question : undefined,
    };
  });

  if (asked.length === 0) {
    return '';
  }

  // Preferred: the structured `answers` map, keyed by each question's full text
  const answers = answerMap(toolResult);

  // Fallback for a differently-shaped result: pull the answer side out of prose, in order
  const positional =
    answers === undefined
      ? [...(resultText(toolResult) ?? '').matchAll(ANSWER)].map((match) =>
          (match[1] ?? '').trim(),
        )
      : [];

  const pairs = asked.map(({ header, text }, position) => {
    const chosen = (
      (text === undefined ? undefined : answers?.get(text)) ??
      positional[position]
    )
      // Option labels carry a "(Recommended)" marker that means nothing to a reader
      ?.replace(/\s*\(recommended\)\s*$/i, '')
      .trim();

    const topic = header ?? text ?? '';

    if (topic === '') {
      return chosen ?? '';
    }
    return chosen === undefined || chosen === ''
      ? topic
      : `${topic} → ${chosen}`;
  });

  return clean(pairs.filter((pair) => pair !== '').join('; '), MAX_DETAIL);
}
