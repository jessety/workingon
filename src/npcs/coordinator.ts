import { clean } from '../activity/sanitize.js';
import { log } from '../logger.js';
import { NpcError, npcError } from './client.js';
import { RETENTION_MS, Session } from './session.js';
import { LegacyNpcStateError } from './state.js';
import type {
  Npc,
  NpcClient,
  NpcPatch,
  NpcRecord,
  NpcSlot,
  NpcState,
  NpcStateRepository,
  SessionSignal,
  SessionSink,
  SessionSummarizer,
} from './types.js';
import { randomBytes, randomUUID } from 'node:crypto';

export interface NpcOptions {
  client: NpcClient;
  repository: NpcStateRepository;
  summarizer: SessionSummarizer;
  /** Hash of endpoint + credential; never the credential itself. */
  account: string;
  namePrefix: string;
  idleMinutes: number;
  staleMinutes: number;
  summaryIntervalSeconds: number;
  speechCooldownSeconds: number;
  maxSessions: number;
  now?: () => number;
  random?: () => number;
}

interface Entry {
  session: Session;
  record: NpcSlot;
  releasing: boolean;
  verifiedId?: string;
  startupHidePending: boolean;
  published?: string;
  publishedRevision?: number;
  publishedLocation?: string;
  bubble?: { revision: number; expiresAt: number };
  mustClearSpeech: boolean;
  lastSpeech: string;
  lastSpeechRevision: number;
  retryAt: number;
  nextWriteAt: number;
  failures: number;
  error?: string;
  publishing: boolean;
  summarizing: boolean;
}

/**
 * Lifecycle, prose, and publishing are independent. The hook path only appends
 * bounded signals/reduces memory. A slow or broken collaborator cannot fail a hook.
 */
export class NpcCoordinator implements SessionSink {
  readonly #options: NpcOptions;
  readonly #now: () => number;
  readonly #random: () => number;
  #timer: NodeJS.Timeout | undefined;
  #state: NpcState | undefined;
  #opened = false;
  #loaded: NpcState | undefined;
  #ready = false;
  #stopping = false;
  #initializing = false;
  #initializeAt = 0;
  #initializationFailures = 0;
  #initializationError: string | undefined;
  #fatal: string | undefined;
  #creationDenied = false;
  #pending: SessionSignal[] = [];
  #entries = new Map<number, Entry>();
  #leases = new Map<string, Entry>();
  #sessions = new Map<string, { session: Session; record: NpcRecord }>();
  #dropped = 0;
  #reportedDropped = 0;
  #revision = 0;
  #savedRevision = 0;
  #saving: Promise<void> | undefined;
  #checkpointAt = 0;
  #ownerOnline = true;
  #namePrefix = 'My';
  #presenceAt = 0;
  #presenceRunning = false;
  #presenceError: string | undefined;
  #apiCount = 0;
  #summaryCount = 0;
  #apiCursor = 0;
  #summaryCursor = 0;
  #apiBlockedUntil = 0;
  #lastSpeechAt = 0;
  #requests = 0;
  #summaries = 0;
  #summaryFailures = 0;
  #io = new Set<Promise<void>>();

  constructor(options: NpcOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopping) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick();
    }, 250);
    this.#timer.unref();
    void this.tick();
  }

  observe(signal: SessionSignal): boolean {
    if (this.#stopping || this.#fatal !== undefined) {
      return false;
    }
    if (!this.#ready) {
      const capacity = this.#options.maxSessions * 100;
      if (this.#pending.length >= capacity) {
        this.#pending.shift();
        this.#dropped += 1;
      }
      this.#pending.push(signal);
      return true;
    }
    return this.#record(signal);
  }

  #record(signal: SessionSignal): boolean {
    let history = this.#sessions.get(signal.key);
    if (history === undefined) {
      // Helpers cannot create leases. History capacity is independent of pool size.
      if (signal.actor !== undefined || this.#state === undefined) {
        return false;
      }
      if (this.#sessions.size >= 10_000) {
        const oldest = [...this.#sessions.values()]
          .filter(
            ({ session }) => !session.visible && !this.#assigned(session.key),
          )
          .sort((a, b) => a.session.lastSeen - b.session.lastSeen)[0];
        if (oldest === undefined) {
          this.#dropped += 1;
          return false;
        }
        this.#removeHistory(oldest.session.key);
      }
      const record: NpcRecord = {
        key: signal.key,
        source: signal.source,
        lastSeen: signal.at,
        ended: false,
      };
      history = {
        session: new Session(signal.key, signal.source, signal.at),
        record,
      };
      this.#sessions.set(signal.key, history);
      this.#state.sessions.push(record);
      this.#revision += 1;
    }
    const recorded = history.session.apply(signal);
    if (recorded) {
      this.#sync(history);
      // Latch release even if a new prompt arrives before the hide completes.
      const entry = this.#assigned(signal.key);
      if (entry !== undefined && !history.session.visible) {
        entry.releasing = true;
      }
    }
    return recorded;
  }

  #assigned(key: string): Entry | undefined {
    return this.#leases.get(key);
  }

  #removeHistory(key: string): void {
    this.#sessions.delete(key);
    if (this.#state !== undefined) {
      this.#state.sessions = this.#state.sessions.filter(
        (record) => record.key !== key,
      );
    }
    this.#revision += 1;
  }

  #idleSession(): Session {
    const session = new Session('', 'codex', this.#now());
    session.hide(this.#now());
    return session;
  }

  #entry(session: Session, record: NpcSlot): Entry {
    return {
      session,
      record,
      releasing: false,
      startupHidePending: false,
      mustClearSpeech: true,
      lastSpeech: '',
      lastSpeechRevision: -1,
      retryAt: 0,
      nextWriteAt: 0,
      failures: 0,
      publishing: false,
      summarizing: false,
    };
  }

  #sync({ session, record }: { session: Session; record: NpcRecord }): void {
    const ended = session.phase === 'ended';
    if (
      record.lastSeen !== session.lastSeen ||
      record.hiddenAt !== session.hiddenAt ||
      record.ended !== ended
    ) {
      record.lastSeen = session.lastSeen;
      record.hiddenAt = session.hiddenAt;
      record.ended = ended;
      this.#revision += 1;
    }
  }

  #release(entry: Entry): void {
    if (entry.record.sessionKey !== undefined) {
      this.#leases.delete(entry.record.sessionKey);
    }
    delete entry.record.sessionKey;
    entry.session = this.#idleSession();
    entry.releasing = false;
    entry.startupHidePending = false;
    entry.published = undefined;
    entry.publishedRevision = undefined;
    entry.bubble = undefined;
    entry.mustClearSpeech = false;
    entry.lastSpeech = '';
    entry.lastSpeechRevision = -1;
    entry.nextWriteAt = 0;
    this.#revision += 1;
  }

  /** Reserve leases synchronously; no await can allocate the same slot twice. */
  #allocate(): void {
    if (this.#state === undefined || this.#stopping) {
      return;
    }
    // All restored characters must be hidden before any new lease can appear.
    if ([...this.#entries.values()].some((entry) => entry.startupHidePending)) {
      return;
    }
    for (const { session } of this.#sessions.values()) {
      if (!session.visible || this.#assigned(session.key) !== undefined) {
        continue;
      }
      const entries = [...this.#entries.values()].sort(
        (a, b) => a.record.number - b.record.number,
      );
      const assigned = entries.filter(
        (entry) => entry.record.sessionKey !== undefined,
      ).length;
      if (assigned >= this.#options.maxSessions) {
        break;
      }
      let entry = entries.find(
        (candidate) =>
          candidate.record.sessionKey === undefined &&
          !candidate.releasing &&
          !candidate.publishing &&
          candidate.error === undefined &&
          candidate.record.createName === undefined,
      );
      if (entry === undefined) {
        // Recovery/release/uncertain POSTs reserve capacity, never trigger growth.
        if (
          entries.some(
            (candidate) =>
              candidate.releasing ||
              !candidate.session.visible ||
              candidate.record.createName !== undefined,
          ) ||
          entries.length >= this.#options.maxSessions
        ) {
          break;
        }
        if (!Number.isSafeInteger(this.#state.counter + 1)) {
          this.#fatal = 'npc_counter_exhausted';
          return;
        }
        const record: NpcSlot = {
          number: ++this.#state.counter,
          lastSpokeAt: 0,
        };
        entry = this.#entry(this.#idleSession(), record);
        this.#entries.set(record.number, entry);
        this.#state.records.push(record);
      }
      entry.session = session;
      entry.record.sessionKey = session.key;
      this.#leases.set(session.key, entry);
      entry.mustClearSpeech = true;
      entry.published = undefined;
      entry.publishedRevision = undefined;
      this.#revision += 1;
    }
  }

  /** Every side effect waits for its ownership metadata to be durable first. */
  async #persist(): Promise<void> {
    const target = this.#revision;
    if (this.#savedRevision >= target || this.#state === undefined) {
      return;
    }
    if (this.#saving !== undefined) {
      await this.#saving;
      if (this.#savedRevision < target) {
        await this.#persist();
      }
      return;
    }
    const snapshot = structuredClone(this.#state);
    this.#saving = Promise.resolve()
      .then(() => this.#options.repository.save(snapshot))
      .then(() => {
        this.#savedRevision = target;
      })
      .catch(() => {
        this.#fatal = 'npc_state_write_failed';
        log.error(
          'NPC publishing paused: ownership metadata could not be saved',
        );
        throw new NpcError('npc_state_write_failed', false);
      })
      .finally(() => {
        this.#saving = undefined;
      });
    await this.#saving;
  }

  #job(action: () => Promise<void>): Promise<void> {
    const job = Promise.resolve()
      .then(action)
      .catch(() => {
        this.#fatal ??= 'npc_internal_error';
        log.error('NPC worker paused after an unexpected failure');
      })
      .finally(() => {
        this.#io.delete(job);
      });
    this.#io.add(job);
    return job;
  }

  async #request<T>(action: () => Promise<T>): Promise<T> {
    if (this.#fatal !== undefined) {
      throw new NpcError(this.#fatal, false);
    }
    if (this.#now() < this.#apiBlockedUntil) {
      throw new NpcError(
        'npc_rate_limited',
        true,
        this.#apiBlockedUntil - this.#now(),
        429,
      );
    }
    this.#requests += 1;
    return action();
  }

  async #initialize(): Promise<void> {
    if (!this.#opened) {
      try {
        this.#loaded = await this.#options.repository.open();
        this.#opened = true;
      } catch (error) {
        throw new NpcError(
          error instanceof LegacyNpcStateError
            ? 'npc_legacy_state_requires_reset'
            : 'npc_state_unavailable_check_file_and_lock',
          false,
        );
      }
    }
    if (this.#stopping) {
      return;
    }
    const { data: me } = await this.#request(() =>
      this.#options.client.me.getMe(),
    );
    if (typeof me.id !== 'string' || me.id === '' || me.id.length > 256) {
      throw new NpcError('npc_invalid_owner', false);
    }
    if (
      this.#loaded !== undefined &&
      (this.#loaded.account !== this.#options.account ||
        this.#loaded.ownerId !== me.id)
    ) {
      throw new NpcError('npc_state_belongs_to_another_api_identity', false);
    }
    const now = this.#now();
    this.#state = this.#loaded ?? {
      version: 2,
      installation: randomUUID(),
      account: this.#options.account,
      ownerId: me.id,
      counter: 0,
      sessions: [],
      records: [],
    };
    this.#ownerOnline = me.presence.availability !== 'offline';
    const firstName = clean(me.name ?? '', 100).split(' ')[0] ?? '';
    this.#namePrefix =
      clean(this.#options.namePrefix, 48) ||
      (firstName === '' ? 'My' : `${firstName}'s`);
    for (const record of this.#state.sessions) {
      const history = { session: Session.restore(record, now), record };
      this.#sessions.set(record.key, history);
      this.#sync(history);
    }
    for (const record of this.#state.records) {
      // Previous leases never bypass startup recovery, even with fresh hooks.
      delete record.sessionKey;
      const entry = this.#entry(this.#idleSession(), record);
      entry.startupHidePending =
        record.npcId !== undefined || record.creationAttempted === true;
      entry.releasing = entry.startupHidePending;
      this.#entries.set(record.number, entry);
      this.#lastSpeechAt = Math.max(this.#lastSpeechAt, record.lastSpokeAt);
    }
    this.#revision += 1;
    await this.#persist();
    if (this.#stopping) {
      return;
    }
    this.#ready = true;
    this.#initializationError = undefined;
    this.#presenceAt = now + 30_000;
    const pending = this.#pending;
    this.#pending = [];
    for (const signal of pending) {
      this.#record(signal);
    }
    log.info('NPC companions enabled', {
      recovered: this.#state.records.length,
    });
  }

  #backoff(failures: number, minimum = 0): number {
    return Math.max(
      minimum,
      Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) *
        (1 + this.#random() * 0.2),
    );
  }

  /** Starts available work; overlapping pulses share per-session/global limits. */
  tick(): Promise<void> {
    if (this.#stopping || this.#fatal !== undefined) {
      return Promise.resolve();
    }
    const now = this.#now();
    if (!this.#ready) {
      if (this.#initializing || now < this.#initializeAt) {
        return Promise.resolve();
      }
      this.#initializing = true;
      return this.#job(async () => {
        try {
          await this.#initialize();
        } catch (error) {
          const failure = npcError(error, this.#now());
          this.#initializationError = failure.code;
          if (failure.retryable) {
            this.#initializationFailures += 1;
            this.#initializeAt =
              this.#now() +
              this.#backoff(this.#initializationFailures, failure.retryAfterMs);
          } else {
            this.#fatal = failure.code;
          }
          log.warn('NPC initialization unavailable', failure.code);
        } finally {
          this.#initializing = false;
        }
      });
    }

    const jobs: Promise<void>[] = [];
    for (const [key, history] of this.#sessions) {
      const { session } = history;
      session.expire(
        now,
        this.#options.idleMinutes * 60_000,
        this.#options.staleMinutes * 60_000,
      );
      this.#sync(history);
      const entry = this.#assigned(key);
      if (entry !== undefined && !session.visible) {
        entry.releasing = true;
      }
      if (
        entry === undefined &&
        session.hiddenAt !== undefined &&
        now - session.hiddenAt >= RETENTION_MS
      ) {
        this.#removeHistory(key);
      }
    }
    for (const entry of this.#entries.values()) {
      if (
        entry.releasing &&
        !entry.publishing &&
        entry.record.npcId === undefined &&
        entry.record.createName === undefined
      ) {
        this.#release(entry);
      }
    }
    this.#allocate();
    if (this.#dropped !== this.#reportedDropped) {
      log.warn(
        'NPC session/buffer capacity reached; some signals were dropped',
        { dropped: this.#dropped },
      );
      this.#reportedDropped = this.#dropped;
    }
    if (
      now >= this.#checkpointAt &&
      this.#saving === undefined &&
      this.#revision > this.#savedRevision
    ) {
      this.#checkpointAt = now + 1000;
      jobs.push(this.#job(() => this.#persist()));
    }

    if (
      !this.#presenceRunning &&
      now >= this.#presenceAt &&
      this.#apiCount < 2 &&
      now >= this.#apiBlockedUntil
    ) {
      this.#presenceRunning = true;
      this.#apiCount += 1;
      this.#presenceAt = now + 30_000;
      jobs.push(
        this.#job(async () => {
          try {
            const { data: me } = await this.#request(() =>
              this.#options.client.me.getMe(),
            );
            if (me.id !== this.#state?.ownerId) {
              throw new NpcError('npc_owner_changed', false);
            }
            this.#ownerOnline = me.presence.availability !== 'offline';
            this.#presenceError = undefined;
          } catch (error) {
            const failure = npcError(error, this.#now());
            this.#presenceError = failure.code;
            if (!failure.retryable) {
              this.#fatal = failure.code;
            } else if (failure.status === 429) {
              this.#apiBlockedUntil =
                this.#now() + Math.max(30_000, failure.retryAfterMs);
            }
            log.warn(
              'NPC presence refresh failed; retaining the last known location',
              failure.code,
            );
          } finally {
            this.#presenceRunning = false;
            this.#apiCount -= 1;
          }
        }),
      );
    }

    const entries = [...this.#entries.values()];
    for (
      let offset = 0;
      offset < entries.length &&
      this.#apiCount < 2 &&
      now >= this.#apiBlockedUntil;
      offset += 1
    ) {
      const index = (this.#apiCursor + offset) % entries.length;
      const entry = entries[index];
      if (entry === undefined || !this.#needsPublish(entry, now)) {
        continue;
      }
      entry.publishing = true;
      this.#apiCount += 1;
      jobs.push(
        this.#job(async () => {
          try {
            await this.#publish(entry);
            entry.error = undefined;
            entry.failures = 0;
            entry.retryAt = 0;
          } catch (error) {
            await this.#publicationFailed(entry, error);
          } finally {
            entry.publishing = false;
            this.#apiCount -= 1;
          }
        }),
      );
    }
    this.#apiCursor = (this.#apiCursor + 1) % Math.max(1, entries.length);

    for (
      let offset = 0;
      offset < entries.length && this.#summaryCount < 2;
      offset += 1
    ) {
      const entry = entries[(this.#summaryCursor + offset) % entries.length];
      if (
        entry === undefined ||
        entry.summarizing ||
        entry.releasing ||
        entry.record.sessionKey === undefined ||
        !entry.session.visible ||
        entry.error !== undefined ||
        (this.#creationDenied && entry.record.npcId === undefined) ||
        now < entry.session.nextSummaryAt ||
        entry.session.sequence <= entry.session.summarizedThrough
      ) {
        continue;
      }
      entry.summarizing = true;
      this.#summaryCount += 1;
      // Summary work is independent of I/O ownership/shutdown. Its result is
      // discarded after shutdown; it must not delay hiding NPCs by 30 seconds.
      jobs.push(
        this.#summarize(entry).finally(() => {
          entry.summarizing = false;
          this.#summaryCount -= 1;
        }),
      );
    }
    this.#summaryCursor =
      (this.#summaryCursor + 1) % Math.max(1, entries.length);
    return Promise.all(jobs).then(() => undefined);
  }

  #name(entry: Entry): string {
    const suffix = `${entry.session.source === 'codex' ? 'Codex' : 'Claude'} ${entry.record.number}`;
    return `${clean(this.#namePrefix, 63 - suffix.length)} ${suffix}`;
  }

  #visual(entry: Entry): NpcPatch {
    const visible =
      entry.record.sessionKey !== undefined &&
      !entry.releasing &&
      entry.session.visible &&
      !this.#stopping;
    const waiting =
      entry.session.phase === 'waiting-input' ||
      entry.session.phase === 'waiting-permission';
    const reviewing =
      entry.session.phase === 'finished' &&
      this.#now() < (entry.session.reviewUntil ?? 0);
    return {
      name: this.#name(entry),
      visible,
      location:
        visible && (waiting || reviewing) && this.#ownerOnline
          ? { type: 'user', userId: this.#state?.ownerId ?? '' }
          : { type: 'desk' },
      textStatus: visible ? entry.session.status : null,
    };
  }

  #speechEligible(entry: Entry, now: number): boolean {
    const speech = entry.session.pendingSpeech;
    return (
      !this.#stopping &&
      !entry.releasing &&
      entry.session.visible &&
      speech !== undefined &&
      speech.revision === entry.session.revision &&
      now - speech.at <= 30_000 &&
      (speech.review !== true || now < (entry.session.reviewUntil ?? 0)) &&
      (speech.text !== entry.lastSpeech ||
        speech.revision !== entry.lastSpeechRevision) &&
      // A review visit always announces its purpose once. Ordinary speech still
      // obeys both cooldowns, including time reserved by review announcements.
      (speech.review === true ||
        ((entry.record.lastSpokeAt === 0 ||
          now - entry.record.lastSpokeAt >=
            this.#options.speechCooldownSeconds * 1000) &&
          (this.#lastSpeechAt === 0 || now - this.#lastSpeechAt >= 10_000)))
    );
  }

  #clearBubble(entry: Entry, now: number): boolean {
    return (
      entry.mustClearSpeech ||
      (entry.bubble !== undefined &&
        (this.#stopping ||
          !entry.session.visible ||
          entry.bubble.revision !== entry.session.revision ||
          now >= entry.bubble.expiresAt))
    );
  }

  #needsPublish(entry: Entry, now: number): boolean {
    if (
      entry.publishing ||
      now < entry.retryAt ||
      (now < entry.nextWriteAt &&
        entry.publishedRevision === entry.session.revision &&
        entry.publishedLocation ===
          JSON.stringify(this.#visual(entry).location) &&
        entry.session.visible &&
        !this.#clearBubble(entry, now))
    ) {
      return false;
    }
    if (
      entry.record.sessionKey === undefined &&
      !entry.releasing &&
      !entry.startupHidePending &&
      entry.record.createName === undefined
    ) {
      return false;
    }
    if (entry.record.createName !== undefined) {
      return true;
    }
    if (entry.record.npcId === undefined) {
      return !entry.releasing && entry.session.visible && !this.#creationDenied;
    }
    return (
      entry.startupHidePending ||
      entry.verifiedId !== entry.record.npcId ||
      entry.releasing ||
      entry.published !== JSON.stringify(this.#visual(entry)) ||
      this.#clearBubble(entry, now) ||
      this.#speechEligible(entry, now)
    );
  }

  #assertOwner(npc: Npc): void {
    if (npc.ownerId !== this.#state?.ownerId) {
      throw new NpcError('not_npc_owner', false, 0, 403);
    }
    if (!/^npc_[A-Za-z0-9]+$/.test(npc.id)) {
      throw new NpcError('npc_invalid_response', false);
    }
  }

  /** Scan every page; the marker is unique, but still reject duplicate matches. */
  async #findCreation(
    name: string,
    cursor?: string,
    cursors = new Set<string>(),
    found?: Npc,
  ): Promise<Npc | undefined> {
    const { data } = await this.#request(() =>
      this.#options.client.npcs.listNpcs({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    for (const npc of data.npcs) {
      if (npc.name === name && npc.ownerId === this.#state?.ownerId) {
        if (found !== undefined && found.id !== npc.id) {
          throw new NpcError('npc_creation_conflict', false);
        }
        found = npc;
      }
    }
    if (data.nextCursor !== undefined) {
      if (cursors.has(data.nextCursor) || cursors.size >= 1000) {
        throw new NpcError('npc_invalid_pagination', false);
      }
      cursors.add(data.nextCursor);
      return this.#findCreation(name, data.nextCursor, cursors, found);
    }
    return found;
  }

  async #ensureNpc(entry: Entry): Promise<void> {
    const record = entry.record;
    if (record.npcId !== undefined) {
      return;
    }
    if (record.createName === undefined) {
      if (
        !entry.session.visible ||
        entry.releasing ||
        this.#stopping ||
        this.#creationDenied ||
        this.#state === undefined
      ) {
        return;
      }
      record.createName = `workingon-${this.#state.installation.replaceAll('-', '').slice(0, 12)}-pool-${randomBytes(10).toString('hex')}`;
      record.creationAttempted = false;
      this.#revision += 1;
    }
    let npc: Npc | undefined;
    if (record.creationAttempted) {
      npc = await this.#findCreation(record.createName);
      if (npc === undefined) {
        // A read immediately after a timeout cannot prove a POST never committed.
        // Keep reconciling, but never blindly repeat an ambiguous creation.
        throw new NpcError('npc_create_uncertain_inspect_state', true, 60_000);
      }
    } else {
      if (!entry.session.visible || entry.releasing || this.#stopping) {
        delete record.createName;
        delete record.creationAttempted;
        this.#revision += 1;
        await this.#persist();
        return;
      }
      if (this.#creationDenied) {
        throw new NpcError('npc_create_not_permitted', false, 0, 403);
      }
      record.creationAttempted = true;
      this.#revision += 1;
      await this.#persist();
      if (!entry.session.visible || entry.releasing || this.#stopping) {
        record.creationAttempted = false;
        this.#revision += 1;
        await this.#persist();
        return;
      }
      try {
        npc = (
          await this.#request(() =>
            this.#options.client.npcs.createNpc({
              name: record.createName ?? '',
              visible: false,
            }),
          )
        ).data;
      } catch (error) {
        const failure = npcError(error, this.#now());
        if ([400, 401, 403, 404, 429].includes(failure.status)) {
          // Explicit rejection is safe to retry after its underlying cause clears.
          record.creationAttempted = false;
          this.#revision += 1;
          await this.#persist();
        }
        throw failure;
      }
    }
    this.#assertOwner(npc);
    record.npcId = npc.id;
    delete record.createName;
    delete record.creationAttempted;
    this.#revision += 1;
    await this.#persist();
    entry.verifiedId = npc.id;
    entry.published = undefined;
    entry.publishedRevision = undefined;
    entry.mustClearSpeech = true;
  }

  async #forgetNpc(entry: Entry): Promise<void> {
    delete entry.record.npcId;
    entry.verifiedId = undefined;
    entry.startupHidePending = false;
    entry.published = undefined;
    entry.publishedRevision = undefined;
    entry.bubble = undefined;
    entry.mustClearSpeech = true;
    entry.nextWriteAt = 0;
    this.#revision += 1;
    await this.#persist();
  }

  async #publish(entry: Entry): Promise<void> {
    await this.#persist();
    await this.#ensureNpc(entry);
    const id = entry.record.npcId;
    if (id === undefined) {
      return;
    }
    if (entry.verifiedId !== id) {
      const { data } = await this.#request(() =>
        this.#options.client.npcs.getNpc(id),
      );
      this.#assertOwner(data);
      if (data.id !== id) {
        throw new NpcError('npc_invalid_response', false);
      }
      entry.verifiedId = id;
    }
    if (
      entry.startupHidePending ||
      entry.releasing ||
      !entry.session.visible ||
      this.#stopping
    ) {
      await this.#request(() =>
        this.#options.client.npcs.updateNpc(id, {
          visible: false,
          say: null,
          textStatus: null,
        }),
      );
      this.#release(entry);
      await this.#persist();
      return;
    }

    let speech = this.#speechEligible(entry, this.#now())
      ? entry.session.pendingSpeech
      : undefined;
    if (speech !== undefined) {
      // Reserve both cooldowns before awaiting. Only deterministic review
      // notices bypass them; ambiguous speech is consumed rather than replayed.
      this.#lastSpeechAt = this.#now();
      entry.record.lastSpokeAt = this.#lastSpeechAt;
      this.#revision += 1;
      await this.#persist();
      if (
        this.#stopping ||
        !entry.session.visible ||
        entry.releasing ||
        speech.revision !== entry.session.revision ||
        (speech.review === true &&
          this.#now() >= (entry.session.reviewUntil ?? 0)) ||
        this.#now() - speech.at > 30_000
      ) {
        speech = undefined;
      }
    }
    const visual = this.#visual(entry);
    // A lifecycle change bypasses the prose throttle. Capture the revision now:
    // a hook arriving during PATCH still needs its own subsequent publication.
    const revision = entry.session.revision;
    const patch: NpcPatch = { ...visual };
    if (speech !== undefined) {
      patch.say = { text: clean(speech.text, 120) };
      entry.session.pendingSpeech = undefined;
      entry.lastSpeech = patch.say.text;
      entry.lastSpeechRevision = speech.revision;
      entry.bubble = {
        revision: speech.revision,
        expiresAt:
          speech.review === true
            ? (entry.session.reviewUntil ?? this.#now())
            : this.#now() + 10_000,
      };
      entry.mustClearSpeech = false;
    } else if (this.#clearBubble(entry, this.#now()) || !visual.visible) {
      patch.say = null;
    }
    await this.#request(() => this.#options.client.npcs.updateNpc(id, patch));
    entry.published = JSON.stringify(visual);
    entry.publishedRevision = revision;
    entry.publishedLocation = JSON.stringify(visual.location);
    entry.nextWriteAt = this.#now() + 2000;
    if (patch.say === null) {
      entry.bubble = undefined;
      entry.mustClearSpeech = false;
    }
  }

  async #publicationFailed(entry: Entry, error: unknown): Promise<void> {
    const failure = npcError(error, this.#now());
    if (failure.status === 404 && entry.record.npcId !== undefined) {
      await this.#forgetNpc(entry);
      entry.error = undefined;
      entry.retryAt = 0;
      return;
    }
    entry.error = failure.code;
    entry.failures += 1;
    entry.retryAt = failure.retryable
      ? this.#now() + this.#backoff(entry.failures, failure.retryAfterMs)
      : Infinity;
    if (failure.status === 401) {
      this.#fatal = failure.code;
    } else if (failure.code === 'npc_create_not_permitted') {
      this.#creationDenied = true;
    } else if (failure.status === 429) {
      this.#apiBlockedUntil = Math.max(this.#apiBlockedUntil, entry.retryAt);
    }
    log.warn('NPC operation failed', {
      name: this.#name(entry),
      code: failure.code,
      retryable: failure.retryable,
    });
  }

  async #summarize(entry: Entry): Promise<void> {
    const session = entry.session;
    const revision = session.revision;
    session.summarizedThrough = session.sequence;
    session.nextSummaryAt =
      this.#now() + this.#options.summaryIntervalSeconds * 1000;
    const digest = session.digest();
    if (digest === '') {
      return;
    }
    this.#summaries += 1;
    try {
      const result = await this.#options.summarizer.summarize(
        `${digest}\nPrevious speech (do not repeat): ${entry.lastSpeech}`,
      );
      if (result === undefined) {
        this.#summaryFailures += 1;
        return;
      }
      if (
        this.#stopping ||
        this.#fatal !== undefined ||
        entry.session !== session ||
        entry.releasing ||
        !session.visible ||
        session.revision !== revision
      ) {
        return;
      }
      session.task = clean(result.task, 160);
      const say = result.say === null ? '' : clean(result.say, 120);
      if (
        say !== '' &&
        session.phase !== 'finished' &&
        session.pendingSpeech === undefined &&
        say !== entry.lastSpeech
      ) {
        session.pendingSpeech = { text: say, revision, at: this.#now() };
      }
    } catch {
      this.#summaryFailures += 1;
      log.warn('NPC summary failed; retaining the current lifecycle state');
    }
  }

  describe(): unknown {
    const now = this.#now();
    return {
      enabled: true,
      ready: this.#ready,
      error: this.#fatal ?? this.#initializationError ?? null,
      creationDenied: this.#creationDenied,
      presenceError: this.#presenceError ?? null,
      ownerOnline: this.#ready ? this.#ownerOnline : null,
      buffered: this.#pending.length,
      dropped: this.#dropped,
      active: [...this.#entries.values()].filter(
        (entry) => entry.session.visible,
      ).length,
      hidden: [...this.#entries.values()].filter(
        (entry) => !entry.session.visible,
      ).length,
      startupHidesPending: [...this.#entries.values()].filter(
        (entry) => entry.startupHidePending,
      ).length,
      pendingWrites: [...this.#entries.values()].filter((entry) =>
        this.#needsPublish(entry, now),
      ).length,
      inFlightWrites: this.#apiCount,
      inFlightSummaries: this.#summaryCount,
      apiRequests: this.#requests,
      summaryRequests: this.#summaries,
      summaryFailures: this.#summaryFailures,
      pool: {
        total: this.#entries.size,
        assigned: [...this.#entries.values()].filter(
          (entry) => entry.record.sessionKey !== undefined,
        ).length,
        available: [...this.#entries.values()].filter(
          (entry) =>
            entry.record.sessionKey === undefined &&
            !entry.releasing &&
            !entry.publishing &&
            entry.error === undefined &&
            entry.record.createName === undefined,
        ).length,
        releasing: [...this.#entries.values()].filter(
          (entry) => entry.releasing,
        ).length,
        waiting: [...this.#sessions.values()].filter(
          ({ session }) =>
            session.visible && this.#assigned(session.key) === undefined,
        ).length,
        history: this.#sessions.size,
        limit: this.#options.maxSessions,
        slots: [...this.#entries.values()].map((entry) => ({
          number: entry.record.number,
          npcId: entry.record.npcId ?? null,
          assigned: entry.record.sessionKey !== undefined,
          releasing: entry.releasing,
          error: entry.error ?? null,
          recovering:
            entry.startupHidePending || entry.record.createName !== undefined,
        })),
      },
      sessions: [...this.#entries.values()]
        .filter((entry) => entry.record.sessionKey !== undefined)
        .map((entry) => ({
          name: this.#name(entry),
          source: entry.session.source,
          project: entry.session.project,
          phase: entry.session.phase,
          visible: entry.session.visible,
          npcId: entry.record.npcId ?? null,
          location: this.#visual(entry).location,
          reviewUntil:
            entry.session.reviewUntil !== undefined &&
            now < entry.session.reviewUntil
              ? new Date(entry.session.reviewUntil).toISOString()
              : null,
          lastActivityAt: new Date(entry.session.lastSeen).toISOString(),
          status: entry.session.status,
          error: entry.error ?? null,
          retryAt:
            entry.error !== undefined &&
            Number.isFinite(entry.retryAt) &&
            Math.abs(entry.retryAt) <= 8.64e15
              ? new Date(entry.retryAt).toISOString()
              : null,
        })),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#pending = [];
    for (const history of this.#sessions.values()) {
      history.session.hide(this.#now());
      this.#sync(history);
    }
    for (const entry of this.#entries.values()) {
      entry.releasing = true;
    }
    await Promise.allSettled([...this.#io]);
    // Two sequential workers preserve per-NPC ordering and bound shutdown load.
    const queue = [...this.#entries.values()].filter(
      (entry) => entry.record.npcId !== undefined,
    );
    const hideNext = async (): Promise<void> => {
      const entry = queue.shift();
      if (entry === undefined || this.#fatal !== undefined) {
        return;
      }
      try {
        await this.#publish(entry);
      } catch (error) {
        log.warn(
          'Could not hide an NPC during shutdown',
          npcError(error, this.#now()).code,
        );
      }
      return hideNext();
    };
    await Promise.allSettled([hideNext(), hideNext()]);
    try {
      if (this.#ready && this.#fatal === undefined) {
        await this.#persist();
      }
    } finally {
      if (this.#opened) {
        try {
          await this.#options.repository.close();
        } catch {
          log.warn(
            'NPC state could not be closed cleanly; inspect it before restarting',
          );
        }
      }
    }
  }
}
