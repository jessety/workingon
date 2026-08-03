import { buildDigest } from './activity/digest.js';
import { type ActivityEvent } from './activity/events.js';
import { type PlanSummary } from './activity/plans.js';
import { type ActivityStore } from './activity/store.js';
import { describeError, log } from './logger.js';

/** Turns an activity digest into a status line. Implemented by `Summarizer`. */
export interface StatusSummarizer {
  summarize(digest: string): Promise<string | undefined>;
}

/** Publishes a status line. Implemented by `PresenceUpdater`. */
export interface StatusPublisher {
  set(status: string): Promise<boolean>;
  clear(): Promise<boolean>;
}

/**
 * Supplies the plan each project is working from. Implemented by `PlanIndex`.
 *
 * Optional throughout — when absent, or when it returns nothing, summaries are built from
 * activity alone exactly as they were before plans existed.
 */
export interface PlanResolver {
  plansFor(
    events: readonly ActivityEvent[],
  ): Promise<ReadonlyMap<string, PlanSummary>>;
}

export interface SchedulerOptions {
  store: ActivityStore;
  summarizer: StatusSummarizer;
  presence: StatusPublisher;
  /** How often to run, in minutes */
  intervalMinutes: number;
  /** Clear the status after this many idle minutes. 0 disables clearing. */
  idleClearMinutes: number;
  /** Optional. Supplies the plan each project is working from, when there is one. */
  plans?: PlanResolver;
}

/**
 * Runs the summarize-and-publish cycle on a fixed interval.
 *
 * Each tick looks only at activity recorded since the last tick, so a quiet
 * interval produces no API call at all.
 */
export class Scheduler {
  readonly #options: SchedulerOptions;
  #timer: NodeJS.Timeout | undefined;
  /** Watermark: events at or before this have already been summarized */
  #summarizedThrough = 0;
  #running = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }

    const intervalMs = this.#options.intervalMinutes * 60_000;
    this.#summarizedThrough = Date.now();

    this.#timer = setInterval(() => {
      void this.tick();
    }, intervalMs);

    // Don't hold the process open on the timer alone
    this.#timer.unref();

    log.info(`Summarizing every ${this.#options.intervalMinutes} minute(s)`);
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Run one cycle. Exposed for tests and for a manual trigger.
   *
   * Overlapping runs are skipped rather than queued — if a summary is still in
   * flight when the next interval fires, the newer activity just rolls into the
   * following cycle.
   */
  async tick(): Promise<void> {
    if (this.#running) {
      log.debug('Previous summary still running; skipping this interval');
      return;
    }

    this.#running = true;
    try {
      await this.#run();
    } catch (error) {
      log.error('Summary cycle failed', describeError(error));
    } finally {
      this.#running = false;
    }
  }

  async #run(): Promise<void> {
    const { store, summarizer, presence, idleClearMinutes, plans } =
      this.#options;

    const events = store.since(this.#summarizedThrough);

    // No new hooks since the last summary: no API call, and the existing
    // status is left exactly as it is.
    if (events.length === 0) {
      await this.#handleIdle(idleClearMinutes);
      return;
    }

    // Enrichment only. A failure here must not cost us the summary, so fall back to
    // building the digest from activity alone — which is what it always did.
    let planSummaries: ReadonlyMap<string, PlanSummary> | undefined;
    if (plans !== undefined) {
      try {
        planSummaries = await plans.plansFor(events);
      } catch (error) {
        log.debug(
          'Could not resolve plans; summarizing from activity alone',
          describeError(error),
        );
      }
    }

    const digest = buildDigest(events, planSummaries);

    // Advance the watermark regardless of what happens next. A failed summary
    // shouldn't cause the same activity to be re-sent on every later tick.
    this.#summarizedThrough = events[events.length - 1]?.at ?? Date.now();

    if (digest === '') {
      log.debug(`${events.length} event(s) held nothing worth summarizing`);
      return;
    }

    log.debug(`Summarizing ${events.length} event(s)`);

    const status = await summarizer.summarize(digest);

    if (status === undefined) {
      log.debug(
        'No status produced this interval; leaving the current one in place',
      );
      return;
    }

    await presence.set(status);
  }

  async #handleIdle(idleClearMinutes: number): Promise<void> {
    if (idleClearMinutes <= 0) {
      log.debug('No new activity; idle clearing is disabled');
      return;
    }

    const { store, presence } = this.#options;
    const lastActivityAt = store.lastActivityAt;

    if (lastActivityAt === 0) {
      return;
    }

    const idleMinutes = (Date.now() - lastActivityAt) / 60_000;

    if (idleMinutes >= idleClearMinutes) {
      log.debug(
        `Idle for ${Math.round(idleMinutes)} minute(s); clearing status`,
      );
      await presence.clear();
    }
  }
}
