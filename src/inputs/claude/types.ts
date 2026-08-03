/**
 * Claude Code hook payloads.
 *
 * Claude Code POSTs one JSON body per hook event. These types cover only the
 * events this service subscribes to; every other event is ignored.
 *
 * Only the fields we actually read are declared. Claude Code sends more, and
 * sends more over time — an unknown field is not an error.
 */

/** Fields present on every hook event */
export interface HookEventBase {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name: string;
}

/** Fires when a session begins, resumes, or is cleared */
export interface SessionStartEvent extends HookEventBase {
  hook_event_name: 'SessionStart';
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  model?: string;
  session_title?: string;
}

/** Fires when the user submits a prompt, before Claude processes it */
export interface UserPromptSubmitEvent extends HookEventBase {
  hook_event_name: 'UserPromptSubmit';
  prompt_text?: string;
}

/**
 * Fires after a tool call succeeds.
 */
export interface PostToolUseEvent extends HookEventBase {
  hook_event_name: 'PostToolUse';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /**
   * The tool's result.
   *
   * Claude Code sends this as `tool_response`; the published reference calls it
   * `tool_output`. Both are accepted — the documented name has been wrong before.
   *
   * Read for exactly one tool: `AskUserQuestion`, where the result is the person's own
   * answer and nothing else. For every other tool this is ignored, because tool results are
   * where file contents, command output, and search hits live. `normalize.ts` enforces
   * that — the fields are declared here only so that one case can reach them.
   */
  tool_response?: unknown;
  tool_output?: unknown;
}

/** Fires when Claude finishes responding */
export interface StopEvent extends HookEventBase {
  hook_event_name: 'Stop';
  stop_reason?: string;
  last_assistant_message?: string;
}

/** Fires when Claude Code raises a notification, e.g. waiting on input */
export interface NotificationEvent extends HookEventBase {
  hook_event_name: 'Notification';
  notification_type?: string;
  message?: string;
}

/** Fires when the session terminates */
export interface SessionEndEvent extends HookEventBase {
  hook_event_name: 'SessionEnd';
  session_end_reason?: string;
}

export type HookEvent =
  | SessionStartEvent
  | UserPromptSubmitEvent
  | PostToolUseEvent
  | StopEvent
  | NotificationEvent
  | SessionEndEvent;

/** Hook events this service records. Anything else is accepted and dropped. */
export const SUBSCRIBED_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionEnd',
] as const;

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

/** Narrow an arbitrary parsed body to something that looks like a hook event */
export function isHookEvent(body: unknown): body is HookEvent {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { hook_event_name?: unknown }).hook_event_name === 'string'
  );
}
