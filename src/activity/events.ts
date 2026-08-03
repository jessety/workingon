/**
 * The neutral activity model.
 *
 * Every input — Claude Code, Codex, whatever comes next — normalizes its events into this
 * one shape, and everything downstream (store, digest, summarizer, publishers) knows only
 * this shape. Adding an input means producing these; adding an output never sees them raw.
 */

/** Which coding agent produced the hook */
export type ActivitySource = 'claude' | 'codex';

export type ActivityKind =
  | 'session-start'
  | 'prompt'
  | 'tool'
  | 'decision'
  | 'stop'
  | 'notification'
  | 'session-end';

/**
 * A single thing the user did, reduced to the smallest useful form.
 *
 * This is what gets held in memory and eventually sent to the Anthropic API,
 * so it is deliberately narrow: no tool output, no file contents, no
 * transcript paths, and everything length-capped.
 */
export interface ActivityEvent {
  /** Unix milliseconds */
  at: number;
  /** Which agent's hooks this came from */
  source: ActivitySource;
  /**
   * The agent's session id, or `unknown`.
   *
   * Not currently read by anything — digests group on `project` — but retained
   * for debugging and future per-session features. Never sent to any API.
   */
  session: string;
  /** Directory name of the session's cwd — the project being worked on */
  project: string;
  kind: ActivityKind;
  /** Short human-readable description */
  detail: string;
}
