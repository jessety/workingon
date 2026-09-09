import type { ActivitySource } from '../activity/events.js';
import {
  clean,
  MAX_ASSISTANT,
  MAX_DETAIL,
  MAX_PROMPT,
} from '../activity/sanitize.js';
import type { SessionKind, SessionSignal } from '../npcs/types.js';
import { describeDecision } from './claude/decision.js';
import { describeToolInput } from './claude/normalize.js';
import { describeToolSubject, FIELDS, readAny } from './util.js';
import { createHash } from 'node:crypto';

export const SESSION_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const;

export const CLAUDE_SESSION_EVENTS = [
  ...SESSION_EVENTS,
  'PostToolUseFailure',
  'StopFailure',
] as const;
export const CODEX_SESSION_EVENTS = [...SESSION_EVENTS, 'Interrupt'] as const;

const KINDS: Record<string, SessionKind> = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool-start',
  PostToolUse: 'tool-end',
  PostToolUseFailure: 'tool-end',
  PermissionRequest: 'permission',
  Stop: 'stop',
  StopFailure: 'failed',
  Interrupt: 'interrupted',
  SessionEnd: 'end',
};

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 256 &&
    value.trim() !== '' &&
    value !== 'unknown' &&
    !/\s/.test(value) &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
    ? value
    : undefined;
}

export function identity(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function optionalIdentity(value: unknown): string | undefined {
  const id = identifier(value);
  return id === undefined ? undefined : identity(id);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Keep source contracts separate even where they currently share field names. */
export function normalizeSession(
  source: ActivitySource,
  body: { hook_event_name: string; [key: string]: unknown },
  at: number,
): SessionSignal | undefined {
  const subscribed: readonly string[] =
    source === 'claude' ? CLAUDE_SESSION_EVENTS : CODEX_SESSION_EVENTS;
  if (!subscribed.includes(body.hook_event_name)) {
    return undefined;
  }
  const event = body as Record<string, unknown>;
  const session = identifier(event.session_id);
  if (
    session === undefined ||
    (event.agent_id !== undefined && identifier(event.agent_id) === undefined)
  ) {
    return undefined;
  }
  let kind = KINDS[body.hook_event_name];
  if (kind === undefined) {
    return undefined;
  }
  const actor = optionalIdentity(event.agent_id);
  const toolName =
    typeof event.tool_name === 'string'
      ? clean(event.tool_name, 100)
      : undefined;
  const toolInput = record(event.tool_input);
  let detail = '';
  let voice: 'person' | 'agent' = 'agent';

  if (kind === 'prompt') {
    detail = clean(readAny(event, FIELDS.prompt) ?? '', MAX_PROMPT);
    voice = actor === undefined ? 'person' : 'agent';
  } else if (kind === 'stop') {
    // A null or missing closing message still ends the turn.
    detail = clean(
      readAny(event, FIELDS.assistantMessage) ?? '',
      MAX_ASSISTANT,
    );
  } else if (
    kind === 'tool-start' ||
    kind === 'tool-end' ||
    kind === 'permission'
  ) {
    if (toolName === undefined || toolName === '') {
      return undefined;
    }
    const shortName = toolName.split('.').at(-1) ?? toolName;
    const isQuestion = [
      'AskUserQuestion',
      'request_user_input',
      'request_user_input_async',
    ].includes(shortName);
    if (kind === 'tool-start' && isQuestion) {
      kind = 'question';
    }
    if (toolName === 'AskUserQuestion' && kind === 'tool-end') {
      // The existing privacy exception: chosen labels, never arbitrary tool output.
      detail = describeDecision(
        toolInput,
        event.tool_response ?? event.tool_output,
      );
      voice = 'person';
    } else {
      const subject =
        source === 'claude'
          ? describeToolInput(toolName, toolInput)
          : describeToolSubject(toolInput, [
              'description',
              'file_path',
              'path',
              'command',
              'cmd',
              'query',
              'name',
            ]);
      detail = clean(
        subject === '' ? toolName : `${toolName}: ${subject}`,
        MAX_DETAIL,
      );
    }
    if (body.hook_event_name === 'PostToolUseFailure') {
      // Classify failure without retaining the raw error or any tool result.
      detail = clean(`${toolName}: tool failed`, MAX_DETAIL);
    }
  }
  const cwd = typeof event.cwd === 'string' ? event.cwd : '';
  return {
    key: identity(`${source}\0${session}`),
    source,
    at,
    kind,
    actor,
    project: clean(cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? 'unknown', 100),
    turn: optionalIdentity(event.turn_id ?? event.prompt_id),
    tool: optionalIdentity(event.tool_use_id ?? event.tool_call_id),
    toolName,
    startReason:
      kind === 'start' && typeof event.source === 'string'
        ? clean(event.source, 30)
        : undefined,
    detail,
    voice,
  };
}
