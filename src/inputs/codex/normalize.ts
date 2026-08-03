import { type ActivityEvent } from '../../activity/events.js';
import {
  MAX_ASSISTANT,
  MAX_DETAIL,
  MAX_PROMPT,
  clean,
} from '../../activity/sanitize.js';
import { FIELDS, describeToolSubject, readAny } from '../util.js';

/**
 * OpenAI Codex hook payloads.
 *
 * Codex adopted Claude Code's hooks contract: the same event names
 * (`UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`) and the same
 * common fields (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`,
 * `tool_response`) — verified by inspecting the codex binary, not just its docs. Codex has
 * no HTTP hook type, so payloads arrive here via a small `curl` shim documented in the
 * README.
 *
 * Kept separate from the Claude normalizer even so: the two contracts are maintained by
 * different vendors and will drift, and a self-contained input is the template someone
 * forking this for another agent will copy.
 */
export interface CodexHookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Codex hook events this input records. Anything else is accepted and dropped. */
export const CODEX_SUBSCRIBED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;

/**
 * Codex's tool vocabulary differs from Claude Code's — lowercase names, and `shell`
 * sends its command as an argv array rather than a string.
 */
const TOOL_SUBJECT: Record<string, readonly string[]> = {
  shell: ['command', 'cmd'],
  local_shell: ['command', 'cmd'],
  apply_patch: ['path', 'file_path'],
  read_file: ['path', 'file_path'],
  web_search: ['query'],
  view_image: ['path'],
};

/** Fallback argument names for tools we don't know about */
const GENERIC_SUBJECT = [
  'description',
  'file_path',
  'path',
  'command',
  'query',
  'name',
];

/**
 * Reduce a raw Codex hook payload to an activity event.
 *
 * Returns `undefined` for events we don't record, and for events with no usable detail.
 */
export function normalizeCodex(
  event: CodexHookEvent,
  now: number,
): ActivityEvent | undefined {
  const session = event.session_id ?? 'unknown';
  const project =
    typeof event.cwd === 'string' && event.cwd !== ''
      ? (event.cwd.split('/').filter(Boolean).at(-1) ?? 'unknown')
      : 'unknown';

  const base = { at: now, source: 'codex' as const, session, project };

  switch (event.hook_event_name) {
    case 'SessionStart': {
      const title = readAny(event, FIELDS.sessionTitle);
      return {
        ...base,
        kind: 'session-start',
        detail: title === undefined ? '' : clean(title, MAX_DETAIL),
      };
    }

    case 'UserPromptSubmit': {
      const prompt = readAny(event, FIELDS.prompt);
      if (prompt === undefined) {
        return undefined;
      }
      return { ...base, kind: 'prompt', detail: clean(prompt, MAX_PROMPT) };
    }

    case 'PostToolUse': {
      const toolName = event.tool_name;
      if (typeof toolName !== 'string' || toolName === '') {
        return undefined;
      }

      const subject = describeToolSubject(
        event.tool_input,
        TOOL_SUBJECT[toolName] ?? GENERIC_SUBJECT,
      );
      const detail = subject === '' ? toolName : `${toolName}: ${subject}`;
      return { ...base, kind: 'tool', detail };
    }

    case 'Stop': {
      const message = readAny(event, FIELDS.assistantMessage);
      if (message === undefined) {
        return undefined;
      }
      return { ...base, kind: 'stop', detail: clean(message, MAX_ASSISTANT) };
    }

    case 'SessionEnd': {
      const reason = readAny(event, FIELDS.sessionEndReason);
      return {
        ...base,
        kind: 'session-end',
        detail: reason === undefined ? '' : clean(reason, MAX_DETAIL),
      };
    }

    default:
      return undefined;
  }
}
