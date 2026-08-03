import { type ActivityEvent } from '../../activity/events.js';
import {
  MAX_ASSISTANT,
  MAX_DETAIL,
  MAX_PROMPT,
  clean,
} from '../../activity/sanitize.js';
import { describeShape, log } from '../../logger.js';
import { FIELDS, describeToolSubject, readAny } from '../util.js';
import { describeDecision } from './decision.js';
import { type HookEvent } from './types.js';

/**
 * Tool argument that best describes what a Claude Code tool call did.
 *
 * Deliberately excludes tool *output* — output routinely contains file
 * contents, command results, and secrets, none of which belong in a status.
 */
const TOOL_SUBJECT: Record<string, readonly string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Agent: ['description'],
  Task: ['description'],
  Skill: ['skill'],
  TaskCreate: ['subject'],
  TaskUpdate: ['subject'],
};

/** Fallback argument names, tried in order, for tools we don't know about */
const GENERIC_SUBJECT = [
  'description',
  'file_path',
  'path',
  'command',
  'query',
  'name',
];

/** Pick the argument that best describes a Claude Code tool call */
export function describeToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string {
  return describeToolSubject(
    toolInput,
    TOOL_SUBJECT[toolName] ?? GENERIC_SUBJECT,
  );
}

/**
 * Reduce a raw Claude Code hook payload to an activity event.
 *
 * Returns `undefined` for events we don't record, and for events that carry no
 * usable detail (an empty prompt, a tool call we can't describe).
 */
export function normalize(
  event: HookEvent,
  now: number,
): ActivityEvent | undefined {
  const session = event.session_id ?? 'unknown';
  const project =
    typeof event.cwd === 'string' && event.cwd !== ''
      ? (event.cwd.split('/').filter(Boolean).at(-1) ?? 'unknown')
      : 'unknown';

  const base = { at: now, source: 'claude' as const, session, project };

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

      // The one tool whose result is the person speaking rather than machine output.
      // Recorded as a decision so the digest can attribute it to them, not their agent.
      if (toolName === 'AskUserQuestion') {
        const result = event.tool_response ?? event.tool_output;
        const detail = describeDecision(event.tool_input, result);

        if (detail !== '' && detail.includes('→') === false) {
          // Topics survived but no answers parsed — a format change. Log the result's
          // shape, never the person's answers, to make it diagnosable.
          log.warn(
            'Recorded a decision but could not read the answers. Result shape:',
            describeShape(result),
          );
        }

        return detail === ''
          ? undefined
          : { ...base, kind: 'decision', detail };
      }

      const subject = describeToolInput(toolName, event.tool_input);
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

    case 'Notification': {
      // Only the type is recorded, never the message body — bodies can quote arbitrary
      // tool input. Notifications are buffered for /status and the logs, but they
      // deliberately never reach the digest: their entire content is agent state.
      const type = readAny(event, FIELDS.notificationType);
      if (type === undefined) {
        return undefined;
      }
      return { ...base, kind: 'notification', detail: clean(type, MAX_DETAIL) };
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
