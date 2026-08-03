import { type ActivityEvent } from '../activity/events.js';
import { normalize } from './claude/normalize.js';
import { SUBSCRIBED_EVENTS, isHookEvent } from './claude/types.js';
import { CODEX_SUBSCRIBED_EVENTS, normalizeCodex } from './codex/normalize.js';

/**
 * An input: one coding agent whose hooks this service understands.
 *
 * To add an agent, write a normalizer producing `ActivityEvent`s and register it here —
 * nothing downstream changes.
 */
export interface Input {
  name: string;
  /** Routes that accept this input's hook payloads */
  paths: readonly string[];
  /** Events this input records — used to warn when a subscribed event can't be read */
  subscribed: readonly string[];
  normalize(
    body: { hook_event_name: string },
    now: number,
  ): ActivityEvent | undefined;
}

export const INPUTS: readonly Input[] = [
  {
    name: 'claude',
    // Bare `/hooks` predates multiple inputs and stays as an alias so existing
    // Claude Code configurations keep working.
    paths: ['/hooks', '/hooks/claude'],
    subscribed: SUBSCRIBED_EVENTS,
    normalize: (body, now) =>
      isHookEvent(body) ? normalize(body, now) : undefined,
  },
  {
    name: 'codex',
    paths: ['/hooks/codex'],
    subscribed: CODEX_SUBSCRIBED_EVENTS,
    normalize: (body, now) => normalizeCodex(body, now),
  },
];
