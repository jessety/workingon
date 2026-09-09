import type { NpcRecord, NpcState, NpcStateRepository } from './types.js';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const NPC_ID = /^npc_[A-Za-z0-9]+$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('NPC state contains an invalid object');
  }
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('NPC state contains an invalid counter or timestamp');
  }
  return value;
}

function timestamp(value: unknown): number {
  const result = number(value);
  if (result > 8_640_000_000_000_000) {
    throw new Error('NPC state contains an out-of-range timestamp');
  }
  return result;
}

function string(value: unknown, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error('NPC state contains an invalid identifier');
  }
  return value;
}

/** Rebuild the allowlisted shape, rather than trusting/copying arbitrary JSON. */
export function parseNpcState(value: unknown): NpcState {
  const state = object(value);
  if (
    state.version !== 1 ||
    !Array.isArray(state.records) ||
    state.records.length > 10_000
  ) {
    throw new Error(
      'Unsupported or oversized NPC state; preserve the file for recovery',
    );
  }
  const installation = string(state.installation, UUID);
  const counters = object(state.counters);
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const seenNumbers = new Set<string>();
  const seenNames = new Set<string>();
  const records = state.records.map((value): NpcRecord => {
    const row = object(value);
    const key = string(row.key, HASH);
    if (
      (row.source !== 'claude' && row.source !== 'codex') ||
      typeof row.ended !== 'boolean'
    ) {
      throw new Error('NPC state contains an invalid session');
    }
    const ordinal = number(row.number);
    const allocation = `${row.source}:${ordinal}`;
    if (
      ordinal < 1 ||
      ordinal > number(counters[row.source]) ||
      seenKeys.has(key) ||
      seenNumbers.has(allocation)
    ) {
      throw new Error(
        'NPC state contains duplicate or inconsistent allocations',
      );
    }
    seenKeys.add(key);
    seenNumbers.add(allocation);
    const result: NpcRecord = {
      key,
      source: row.source,
      number: ordinal,
      ended: row.ended,
      lastSeen: timestamp(row.lastSeen),
      lastSpokeAt: timestamp(row.lastSpokeAt),
    };
    if (row.hiddenAt !== undefined) {
      result.hiddenAt = timestamp(row.hiddenAt);
    }
    if (row.npcId !== undefined) {
      result.npcId = string(row.npcId, NPC_ID);
      if (seenIds.has(result.npcId)) {
        throw new Error('NPC state assigns one NPC to multiple sessions');
      }
      seenIds.add(result.npcId);
    }
    if (row.createName !== undefined) {
      result.createName = string(row.createName);
      const prefix = `workingon-${installation.replaceAll('-', '').slice(0, 12)}-${row.source}-`;
      if (
        !result.createName.startsWith(prefix) ||
        !/^[a-f0-9]{20}$/.test(result.createName.slice(prefix.length)) ||
        typeof row.creationAttempted !== 'boolean' ||
        row.npcId !== undefined ||
        seenNames.has(result.createName)
      ) {
        throw new Error('NPC state contains an invalid pending creation');
      }
      result.creationAttempted = row.creationAttempted;
      seenNames.add(result.createName);
    } else if (row.creationAttempted !== undefined) {
      throw new Error('NPC creation marker is missing its recovery name');
    }
    return result;
  });
  return {
    version: 1,
    installation,
    account: string(state.account, HASH),
    ownerId: string(state.ownerId),
    counters: {
      claude: number(counters.claude),
      codex: number(counters.codex),
    },
    records,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function ownerIsDead(value: unknown): boolean {
  const lock = object(value);
  const pid = number(lock.pid);
  if (pid <= 0) {
    throw new Error('NPC lock is incomplete; inspect it before removing it');
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM does not mean the owner is dead. PID reuse safely refuses takeover.
    return hasCode(error, 'ESRCH');
  }
}

/** Atomic metadata snapshots and an exclusive single-writer lock. */
export class FileNpcState implements NpcStateRepository {
  readonly #file: string;
  readonly #token = randomUUID();
  #lock: FileHandle | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async #createLock(): Promise<void> {
    const handle = await open(`${this.#file}.lock`, 'wx', 0o600);
    this.#lock = handle;
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token: this.#token }),
      );
      await handle.sync();
    } catch (error) {
      await handle.close();
      this.#lock = undefined;
      await unlink(`${this.#file}.lock`);
      throw error;
    }
  }

  async #acquire(): Promise<void> {
    try {
      await this.#createLock();
      return;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
    }
    const lockFile = `${this.#file}.lock`;
    const existing: unknown = JSON.parse(await readFile(lockFile, 'utf8'));
    if (!ownerIsDead(existing)) {
      throw new Error('NPC state is locked by another live process');
    }
    // Serialize stale-lock recovery. Never automatically steal a recovery guard:
    // a crash during this tiny window requires explicit operator inspection.
    const recoveryFile = `${this.#file}.recovering`;
    const recovery = await open(recoveryFile, 'wx', 0o600);
    try {
      const current: unknown = JSON.parse(await readFile(lockFile, 'utf8'));
      if (!ownerIsDead(current)) {
        throw new Error(
          'Another process acquired the NPC state during recovery',
        );
      }
      await unlink(lockFile);
      await this.#createLock();
    } finally {
      await recovery.close();
      await unlink(recoveryFile);
    }
  }

  async open(): Promise<NpcState | undefined> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    await this.#acquire();
    try {
      let size: number;
      try {
        size = (await stat(this.#file)).size;
      } catch (error) {
        if (hasCode(error, 'ENOENT')) {
          return undefined;
        }
        throw error;
      }
      if (size > MAX_STATE_BYTES) {
        throw new Error(
          'NPC state exceeds the size limit; preserve it for recovery',
        );
      }
      return parseNpcState(
        JSON.parse(await readFile(this.#file, 'utf8')) as unknown,
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  save(state: NpcState): Promise<void> {
    if (this.#lock === undefined) {
      return Promise.reject(
        new Error('NPC state cannot be written without its lock'),
      );
    }
    // Snapshot now: later hook arrivals must not mutate an in-flight write.
    const payload = JSON.stringify(parseNpcState(state));
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
      return Promise.reject(new Error('NPC state exceeds the size limit'));
    }
    const write = this.#writes.then(async () => {
      const temporary = `${this.#file}.${this.#token}.tmp`;
      const handle = await open(temporary, 'w', 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.#file);
      // Persist the directory entry too, so a successful save precedes a POST
      // even across a machine crash, not merely a process restart.
      const directory = await open(path.dirname(this.#file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    // A failed snapshot poisons the writer; the coordinator must stop publishing.
    this.#writes = write;
    return write;
  }

  async close(): Promise<void> {
    try {
      await this.#writes;
    } finally {
      const handle = this.#lock;
      this.#lock = undefined;
      if (handle !== undefined) {
        await handle.close();
        const lock = object(
          JSON.parse(await readFile(`${this.#file}.lock`, 'utf8')) as unknown,
        );
        if (lock.token === this.#token) {
          await unlink(`${this.#file}.lock`);
        }
      }
    }
  }
}

/** Dry runs have no relationship to the live state file or lock. */
export class MemoryNpcState implements NpcStateRepository {
  #state: NpcState | undefined;

  open(): Promise<NpcState | undefined> {
    return Promise.resolve(
      this.#state === undefined ? undefined : structuredClone(this.#state),
    );
  }

  save(state: NpcState): Promise<void> {
    this.#state = structuredClone(state);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
