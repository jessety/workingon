import { MAX_DETAIL, clean } from '../activity/sanitize.js';
import path from 'node:path';

/**
 * Helpers shared by input normalizers.
 *
 * Both Claude Code and Codex send hook payloads whose field names have drifted from their
 * published references, so everything here reads through alias lists rather than trusting
 * a single name. A rename in either agent degrades to "we recorded slightly less" instead
 * of "we silently recorded nothing".
 */

/**
 * Field aliases, most-observed first.
 *
 * Codex adopted Claude Code's hook wire contract (verified by inspecting the binary:
 * `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt` all present),
 * so both inputs share one alias table.
 */
export const FIELDS = {
  prompt: ['prompt_text', 'prompt', 'user_prompt', 'message', 'text'],
  assistantMessage: [
    'last_assistant_message',
    'last-assistant-message',
    'assistant_message',
    'message',
  ],
  notificationType: ['notification_type', 'type'],
  sessionEndReason: ['session_end_reason', 'reason'],
  sessionTitle: ['session_title', 'title'],
} as const;

export function readString(
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read the first non-empty string among several candidate field names */
export function readAny(
  event: object,
  keys: readonly string[],
): string | undefined {
  const record = event as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

/**
 * Pick the tool argument that best describes a tool call, given the argument names to try.
 *
 * Handles both string values and argv-style string arrays (Codex's shell tool sends
 * `command: ["ls", "-la"]`). Path-like keys are reduced to a basename so a status line
 * never carries a full filesystem path.
 */
export function describeToolSubject(
  toolInput: Record<string, unknown> | undefined,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const raw = toolInput?.[key];

    let value: string | undefined;
    if (typeof raw === 'string' && raw !== '') {
      value = raw;
    } else if (
      Array.isArray(raw) &&
      raw.every((entry) => typeof entry === 'string')
    ) {
      const joined = (raw as string[]).join(' ').trim();
      value = joined === '' ? undefined : joined;
    }

    if (value === undefined) {
      continue;
    }

    const subject = key.endsWith('path') ? path.basename(value) : value;
    return clean(subject, MAX_DETAIL);
  }

  return '';
}
