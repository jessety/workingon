import { SoWork } from 'sowork';
import { describeError, log } from '../logger.js';

/**
 * The slice of the SoWork client that presence updates need.
 *
 * The real `SoWork` client satisfies this structurally; tests inject a fake —
 * the same pattern as `StatusSummarizer` / `StatusPublisher` on the scheduler.
 */
export interface PresenceClient {
  me: {
    getMe(): Promise<{ data: { presence?: { textStatus?: string } } }>;
    updatePresence(data: { textStatus?: string | null }): Promise<unknown>;
  };
}

export interface PresenceOptions {
  apiKey: string;
  /** Override the API endpoint. Empty string uses the SDK default. */
  baseUrl: string;
  /** Log the status instead of writing it to SoWork */
  dryRun: boolean;
  /** Injectable for tests. Ignored in dry run; defaults to the real SoWork client. */
  client?: PresenceClient;
}

/** The most recent status this service pushed */
export interface PresenceState {
  status: string | null;
  updatedAt: string | null;
}

/**
 * Writes the summarized status to the SoWork user's presence.
 *
 * SoWork's presence endpoint is a JSON Merge Patch: sending `textStatus` alone
 * leaves availability untouched, and `null` clears the status.
 */
export class PresenceUpdater {
  readonly #client: PresenceClient | undefined;
  readonly #dryRun: boolean;
  #current: string | null = null;
  #updatedAt: number | undefined;

  constructor(options: PresenceOptions) {
    this.#dryRun = options.dryRun;
    this.#client = options.dryRun
      ? undefined
      : (options.client ??
        new SoWork(
          options.apiKey,
          options.baseUrl === '' ? undefined : { baseURL: options.baseUrl },
        ));
  }

  get state(): PresenceState {
    return {
      status: this.#current,
      updatedAt:
        this.#updatedAt === undefined
          ? null
          : new Date(this.#updatedAt).toISOString(),
    };
  }

  /**
   * Learn what SoWork currently holds. Call once at startup.
   *
   * The in-memory record starts as null on every boot, but SoWork keeps whatever
   * the previous process wrote. Without this, `clear()` sees "nothing to clear"
   * after a restart and a stale status survives on the profile indefinitely.
   *
   * A failure is logged and ignored — the service then behaves as it did before
   * seeding existed.
   */
  async seed(): Promise<void> {
    if (this.#client === undefined) {
      return;
    }

    try {
      const response = await this.#client.me.getMe();
      this.#current = response.data.presence?.textStatus ?? null;
      log.debug(`SoWork currently shows: ${this.#current ?? '(no status)'}`);
    } catch (error) {
      log.warn(
        'Could not read the current SoWork status; assuming none',
        describeError(error),
      );
    }
  }

  /** Set the text status. Returns true if SoWork accepted the write. */
  async set(status: string): Promise<boolean> {
    return this.#write(status);
  }

  /** Clear the text status. Returns true if SoWork accepted the write. */
  async clear(): Promise<boolean> {
    if (this.#current === null) {
      return true;
    }
    return this.#write(null);
  }

  async #write(textStatus: string | null): Promise<boolean> {
    if (textStatus === this.#current) {
      log.debug('Status unchanged; skipping SoWork write');
      return true;
    }

    if (this.#dryRun || this.#client === undefined) {
      log.info(
        `[dry run] Would set SoWork status to: ${textStatus ?? '(cleared)'}`,
      );
      this.#current = textStatus;
      this.#updatedAt = Date.now();
      return true;
    }

    try {
      await this.#client.me.updatePresence({ textStatus });
    } catch (error) {
      log.error('Failed to update SoWork presence', describeError(error));
      return false;
    }

    this.#current = textStatus;
    this.#updatedAt = Date.now();
    log.info(`💬 SoWork status set to: ${textStatus ?? '(cleared)'}`);
    return true;
  }
}
