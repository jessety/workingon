import { type StatusPublisher } from '../scheduler.js';

/**
 * Fans one status out to several publishers.
 *
 * The scheduler keeps talking to a single `StatusPublisher`; this is how "SoWork and
 * Slack" (and whatever comes next) hide behind that interface.
 *
 * Failure isolation is the point: publishers are written in parallel and each already
 * catches its own errors, so SoWork being down never blocks Slack. Returns true if at
 * least one destination accepted the write.
 */
export class Broadcast implements StatusPublisher {
  readonly #publishers: readonly StatusPublisher[];

  constructor(publishers: readonly StatusPublisher[]) {
    this.#publishers = publishers;
  }

  async set(status: string): Promise<boolean> {
    const results = await Promise.all(
      this.#publishers.map((publisher) => publisher.set(status)),
    );
    return results.some((accepted) => accepted);
  }

  async clear(): Promise<boolean> {
    const results = await Promise.all(
      this.#publishers.map((publisher) => publisher.clear()),
    );
    return results.some((accepted) => accepted);
  }
}
