import { describeError, log } from '../logger.js';
import { clamp } from '../summarize.js';

/** Slack rejects status_text over 100 characters — a platform limit, not ours */
const SLACK_STATUS_MAX = 100;

export interface SlackOptions {
  /** A user token (`xoxp-…`) with the `users.profile:write` scope. Bot tokens cannot set your status. */
  token: string;
  /** Log the status instead of writing it to Slack */
  dryRun: boolean;
  /**
   * Have Slack clear the status by itself this many seconds after the last write.
   * A dead-man's switch: if this service dies, the status doesn't outlive it. 0 disables.
   */
  expirationSeconds: number;
  /** Emoji shown beside the status, e.g. `:speech_balloon:`. Empty leaves it unset. */
  emoji: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** The most recent status this publisher pushed */
export interface SlackState {
  status: string | null;
  updatedAt: string | null;
}

/**
 * Writes the summarized status to the user's Slack profile via `users.profile.set`.
 *
 * Unlike the SoWork publisher there is no startup seeding: reading the current status
 * would require the additional `users.profile:read` scope, and `status_expiration` already
 * guarantees a stale status can't outlive a dead service. The cost is one redundant write
 * after a restart, which is harmless.
 */
export class SlackStatus {
  readonly #options: SlackOptions;
  readonly #fetch: typeof fetch;
  #current: string | null = null;
  #updatedAt: number | undefined;

  constructor(options: SlackOptions) {
    this.#options = options;
    this.#fetch = options.fetchFn ?? fetch;
  }

  get state(): SlackState {
    return {
      status: this.#current,
      updatedAt:
        this.#updatedAt === undefined
          ? null
          : new Date(this.#updatedAt).toISOString(),
    };
  }

  /** Set the status. Returns true if Slack accepted the write. */
  async set(status: string): Promise<boolean> {
    return this.#write(clamp(status, SLACK_STATUS_MAX));
  }

  /** Clear the status. Returns true if Slack accepted the write. */
  async clear(): Promise<boolean> {
    if (this.#current === null) {
      return true;
    }
    return this.#write(null);
  }

  async #write(status: string | null): Promise<boolean> {
    if (status === this.#current) {
      log.debug('Slack status unchanged; skipping write');
      return true;
    }

    if (this.#options.dryRun) {
      log.info(`[dry run] Would set Slack status to: ${status ?? '(cleared)'}`);
      this.#current = status;
      this.#updatedAt = Date.now();
      return true;
    }

    // Clearing means empty strings and zero expiration, per Slack's API
    const profile = {
      status_text: status ?? '',
      status_emoji: status === null ? '' : this.#options.emoji,
      status_expiration:
        status === null || this.#options.expirationSeconds <= 0
          ? 0
          : Math.floor(Date.now() / 1000) + this.#options.expirationSeconds,
    };

    try {
      const response = await this.#fetch(
        'https://slack.com/api/users.profile.set',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#options.token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({ profile }),
        },
      );

      // Slack reports failures in the body with HTTP 200, so check both
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (response.ok === false || body.ok !== true) {
        log.error(
          `Slack rejected the status update: ${body.error ?? response.status}`,
        );
        return false;
      }
    } catch (error) {
      log.error('Failed to reach Slack', describeError(error));
      return false;
    }

    this.#current = status;
    this.#updatedAt = Date.now();
    log.info(`💬 Slack status set to: ${status ?? '(cleared)'}`);
    return true;
  }
}
