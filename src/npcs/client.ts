import { SoWork } from 'sowork';
import { clean } from '../activity/sanitize.js';
import { log } from '../logger.js';
import type { Npc, NpcClient, NpcPatch } from './types.js';

export class NpcError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
    readonly status = 0,
  ) {
    super(code);
  }
}

/** Do not log Axios errors/config: those can include Authorization headers. */
export function npcError(error: unknown, now: number): NpcError {
  if (error instanceof NpcError) {
    return error;
  }
  const response = (
    error as {
      response?: {
        status?: number;
        headers?: Record<string, unknown>;
        data?: { error?: { code?: unknown } };
      };
    } | null
  )?.response;
  const status = response?.status ?? 0;
  const rawCode = response?.data?.error?.code;
  const code =
    typeof rawCode === 'string'
      ? clean(rawCode, 100)
      : status === 0
        ? 'npc_network_error'
        : `npc_http_${status}`;
  const header = response?.headers?.['retry-after'];
  let retryAfterMs = 0;
  if (typeof header === 'string' || typeof header === 'number') {
    const seconds = Number(header);
    retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(String(header)) - now);
  }
  return new NpcError(
    code,
    status === 0 || status === 408 || status === 429 || status >= 500,
    Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    status,
  );
}

export function createNpcClient(apiKey: string, baseUrl: string): NpcClient {
  return new SoWork(apiKey, {
    ...(baseUrl === '' ? {} : { baseURL: baseUrl }),
    timeout: 10_000,
  });
}

/** No live SDK is constructed in dry run, including for identity/presence reads. */
export class DryRunNpcClient implements NpcClient {
  #next = 1;
  #npcs = new Map<string, Npc>();

  readonly me: NpcClient['me'] = {
    getMe: () =>
      Promise.resolve({
        data: { id: 'dry-run', presence: { availability: 'available' } },
      }),
  };

  readonly npcs: NpcClient['npcs'] = {
    createNpc: (data) => {
      const npc: Npc = {
        id: `npc_dry${this.#next++}`,
        ownerId: 'dry-run',
        name: data.name,
        createdAt: Math.floor(Date.now() / 1000),
        characterConfig: { version: 5, bodyType: 'dry-run-owner', slots: {} },
      };
      this.#npcs.set(npc.id, npc);
      log.info('[dry run] Would create hidden NPC', { id: npc.id });
      return Promise.resolve({ data: { ...npc } });
    },
    listNpcs: () =>
      Promise.resolve({
        data: { npcs: [...this.#npcs.values()].map((npc) => ({ ...npc })) },
      }),
    getNpc: (id) => {
      const npc = this.#npcs.get(id);
      return npc === undefined
        ? Promise.reject(new NpcError('npc_not_found', false, 0, 404))
        : Promise.resolve({ data: { ...npc } });
    },
    updateNpc: (id, patch: NpcPatch) => {
      const npc = this.#npcs.get(id);
      if (npc === undefined) {
        return Promise.reject(new NpcError('npc_not_found', false, 0, 404));
      }
      if (patch.name !== undefined) {
        npc.name = patch.name;
      }
      if (patch.characterConfig !== undefined) {
        npc.characterConfig = structuredClone(patch.characterConfig);
      }
      log.info('[dry run] Would update NPC', { id, ...patch });
      return Promise.resolve();
    },
    deleteNpc: (id) => {
      this.#npcs.delete(id);
      log.info('[dry run] Would delete NPC', { id });
      return Promise.resolve();
    },
  };
}
