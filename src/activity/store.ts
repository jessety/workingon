import { type ActivityEvent } from './events.js';

/**
 * Fixed-size, in-memory record of recent activity.
 *
 * Activity is intentionally not persisted: it is a rolling window used to write
 * the next status message, and it contains prompt text. Restarting the service
 * forgets everything, which is the desired behavior.
 */
export class ActivityStore {
  readonly #capacity: number;
  #events: ActivityEvent[] = [];
  #dropped = 0;

  constructor(capacity: number) {
    if (Number.isInteger(capacity) === false || capacity <= 0) {
      throw new RangeError(
        `Activity store capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.#capacity = capacity;
  }

  /** Record an event, evicting the oldest if the buffer is full */
  add(event: ActivityEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#capacity) {
      this.#events = this.#events.slice(this.#events.length - this.#capacity);
      this.#dropped += 1;
    }
  }

  /** Events recorded strictly after `timestamp`, oldest first */
  since(timestamp: number): ActivityEvent[] {
    return this.#events.filter((event) => event.at > timestamp);
  }

  /** Timestamp of the most recent event, or 0 if there has never been one */
  get lastActivityAt(): number {
    return this.#events.at(-1)?.at ?? 0;
  }

  get size(): number {
    return this.#events.length;
  }

  /** How many events have been evicted for capacity since startup */
  get dropped(): number {
    return this.#dropped;
  }

  clear(): void {
    this.#events = [];
  }
}
