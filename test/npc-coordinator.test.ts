import { identity, normalizeSession } from '../src/inputs/session.js';
import { NpcError } from '../src/npcs/client.js';
import { NpcCoordinator, type NpcOptions } from '../src/npcs/coordinator.js';
import { RETENTION_MS } from '../src/npcs/session.js';
import { FileNpcState } from '../src/npcs/state.js';
import type {
  Npc,
  NpcClient,
  NpcPatch,
  NpcState,
  NpcStateRepository,
  NpcSummary,
} from '../src/npcs/types.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NOW = 1_700_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Repository implements NpcStateRepository {
  state: NpcState | undefined;
  snapshots: NpcState[] = [];
  rejectWrites = false;

  open(): Promise<NpcState | undefined> {
    return Promise.resolve(
      this.state === undefined ? undefined : structuredClone(this.state),
    );
  }

  save(state: NpcState): Promise<void> {
    if (this.rejectWrites) {
      return Promise.reject(new Error('Disk unavailable'));
    }
    this.state = structuredClone(state);
    this.snapshots.push(structuredClone(state));
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class Client implements NpcClient {
  ownerId = 'u_owner';
  availability: 'available' | 'offline' = 'available';
  characters = new Map<string, Npc & NpcPatch>();
  writes: { id: string; patch: NpcPatch }[] = [];
  creates = 0;
  deleted: string[] = [];

  readonly me: NpcClient['me'] = {
    getMe: jest.fn(() =>
      Promise.resolve({
        data: {
          id: this.ownerId,
          name: 'Jesse Youngblood',
          presence: { availability: this.availability },
        },
      }),
    ),
  };

  readonly npcs: NpcClient['npcs'] = {
    createNpc: jest.fn((data) => {
      const npc: Npc = {
        id: `npc_${++this.creates}`,
        ownerId: this.ownerId,
        name: data.name,
        createdAt: NOW / 1000,
      };
      this.characters.set(npc.id, { ...npc, visible: data.visible });
      return Promise.resolve({ data: npc });
    }),
    listNpcs: jest.fn(() =>
      Promise.resolve({ data: { npcs: [...this.characters.values()] } }),
    ),
    getNpc: jest.fn((id) => {
      const npc = this.characters.get(id);
      return npc === undefined
        ? Promise.reject(new NpcError('npc_not_found', false, 0, 404))
        : Promise.resolve({ data: { ...npc } });
    }),
    updateNpc: jest.fn((id, patch) => {
      const npc = this.characters.get(id);
      if (npc === undefined) {
        return Promise.reject(new NpcError('npc_not_found', false, 0, 404));
      }
      this.writes.push({ id, patch: structuredClone(patch) });
      Object.assign(npc, patch);
      return Promise.resolve();
    }),
    deleteNpc: jest.fn((id) => {
      this.deleted.push(id);
      this.characters.delete(id);
      return Promise.resolve();
    }),
  };
}

function setup(overrides: Partial<NpcOptions> = {}) {
  let now = NOW;
  const client = new Client();
  const repository = new Repository();
  const summarize = jest.fn(
    async (_digest: string): Promise<NpcSummary | undefined> => ({
      task: 'Invitation improvements',
      say: null,
    }),
  );
  const options: NpcOptions = {
    client,
    repository,
    summarizer: { summarize },
    account: identity('test-account'),
    namePrefix: '',
    idleMinutes: 10,
    staleMinutes: 120,
    summaryIntervalSeconds: 30,
    speechCooldownSeconds: 60,
    maxSessions: 50,
    now: () => now,
    random: () => 0,
    ...overrides,
  };
  const coordinator = new NpcCoordinator(options);

  function observe(
    hook: string,
    fields: Record<string, unknown> = {},
    source: 'codex' | 'claude' = 'codex',
  ): boolean {
    const signal = normalizeSession(
      source,
      {
        hook_event_name: hook,
        session_id: 'main',
        cwd: '/tmp/shared',
        ...fields,
      },
      now,
    );
    if (signal === undefined) {
      throw new Error('Invalid fixture signal');
    }
    return coordinator.observe(signal);
  }

  async function flush(count = 4): Promise<void> {
    if (count === 0) {
      return;
    }
    await coordinator.tick();
    return flush(count - 1);
  }

  return {
    client,
    repository,
    summarize,
    coordinator,
    options,
    observe,
    flush,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('NPC coordination', () => {
  test('creates five independent companions across sources and same-project sessions', async () => {
    const h = setup();
    await h.coordinator.tick();
    for (const [source, session] of [
      ['claude', 'same'],
      ['codex', 'same'],
      ['codex', 'b'],
      ['claude', 'c'],
      ['codex', 'd'],
    ] as const) {
      h.observe(
        'UserPromptSubmit',
        { session_id: session, prompt: `Task ${source} ${session}` },
        source,
      );
    }
    await h.flush(6);
    expect(h.client.creates).toBe(5);
    expect(
      new Set([...h.client.characters.values()].map((npc) => npc.name)).size,
    ).toBe(5);
    expect([...h.client.characters.values()].map((npc) => npc.name)).toEqual(
      expect.arrayContaining(["Jesse's Codex 1", "Jesse's Claude 1"]),
    );
    expect(
      h.summarize.mock.calls
        .map(([digest]) => digest)
        .every((digest) => digest.match(/Task /g)?.length === 1),
    ).toBe(true);
  });

  test('writes creation intent before POST and the id before any visible PATCH', async () => {
    const h = setup();
    const create = jest
      .mocked(h.client.npcs.createNpc)
      .getMockImplementation()!;
    jest.spyOn(h.client.npcs, 'createNpc').mockImplementation(async (data) => {
      expect(data.visible).toBe(false);
      expect(h.repository.state?.records[0]).toMatchObject({
        createName: data.name,
        creationAttempted: true,
      });
      return create(data);
    });
    const update = jest
      .mocked(h.client.npcs.updateNpc)
      .getMockImplementation()!;
    jest
      .spyOn(h.client.npcs, 'updateNpc')
      .mockImplementation(async (id, patch) => {
        if (patch.visible) {
          expect(h.repository.state?.records[0]?.npcId).toBe(id);
        }
        return update(id, patch);
      });
    h.observe('UserPromptSubmit', { prompt: 'Private request' });
    await h.flush();
    expect(h.client.creates).toBe(1);
    expect(JSON.stringify(h.repository.snapshots)).not.toMatch(
      /Private request|shared|Invitation improvements/,
    );
  });

  test('does not create an NPC when only a helper or an end event was observed', async () => {
    const h = setup();
    await h.coordinator.tick();
    expect(
      h.observe('UserPromptSubmit', {
        agent_id: 'child',
        prompt: 'Delegation',
      }),
    ).toBe(false);
    h.observe('SessionEnd');
    await h.flush();
    expect(h.client.creates).toBe(0);
  });

  test('hides idle NPCs, reuses their IDs, and deletes on session end', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task', turn_id: 't1' });
    await h.flush();
    h.observe('Stop', { turn_id: 't1' });
    h.advance(10 * 60_000);
    await h.flush();
    expect(h.client.characters.get('npc_1')?.visible).toBe(false);
    h.observe('UserPromptSubmit', { prompt: 'Continue', turn_id: 't2' });
    await h.flush();
    expect(h.client.characters.get('npc_1')?.visible).toBe(true);
    expect(h.client.creates).toBe(1);
    h.observe('SessionEnd');
    await h.flush();
    expect(h.client.characters.size).toBe(0);
    expect(h.observe('PostToolUse', { tool_name: 'Bash', turn_id: 't2' })).toBe(
      false,
    );
  });

  test('keeps long-running tools visible and eventually deletes stale hidden NPCs', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Run a lengthy operation' });
    await h.flush();
    h.advance(11 * 60_000);
    await h.flush();
    expect(h.client.characters.get('npc_1')?.visible).toBe(true);
    h.advance(110 * 60_000);
    await h.flush();
    expect(h.client.characters.get('npc_1')?.visible).toBe(false);
    h.advance(RETENTION_MS);
    await h.flush();
    expect(h.client.characters.size).toBe(0);
  });

  test('moves to the desk while offline and follows the owner on return', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    expect(h.client.characters.get('npc_1')?.location).toEqual({
      type: 'user',
      userId: 'u_owner',
    });
    h.client.availability = 'offline';
    h.advance(30_000);
    await h.flush();
    expect(h.client.characters.get('npc_1')?.location).toEqual({
      type: 'desk',
    });
    h.client.availability = 'available';
    h.advance(30_000);
    await h.flush();
    expect(h.client.characters.get('npc_1')?.location).toEqual({
      type: 'user',
      userId: 'u_owner',
    });
  });

  test('a session ending during creation can never be made visible by the stale create response', async () => {
    const h = setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const create = jest
      .mocked(h.client.npcs.createNpc)
      .getMockImplementation()!;
    jest
      .spyOn(h.client.npcs, 'createNpc')
      .mockImplementationOnce(async (data) => {
        entered.resolve();
        await release.promise;
        return create(data);
      });
    await h.coordinator.tick();
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    const work = h.coordinator.tick();
    await entered.promise;
    h.observe('SessionEnd');
    release.resolve();
    await work;
    expect(h.client.writes.some(({ patch }) => patch.visible === true)).toBe(
      false,
    );
    expect(h.client.characters.size).toBe(0);
  });

  test('overlapping pulses allow only two concurrent NPC workers while hooks keep recording', async () => {
    const h = setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const create = jest
      .mocked(h.client.npcs.createNpc)
      .getMockImplementation()!;
    let requests = 0;
    jest.spyOn(h.client.npcs, 'createNpc').mockImplementation(async (data) => {
      requests += 1;
      if (requests === 2) {
        entered.resolve();
      }
      await release.promise;
      return create(data);
    });
    await h.coordinator.tick();
    for (const session of ['a', 'b', 'c']) {
      h.observe('UserPromptSubmit', { session_id: session, prompt: 'Task' });
    }
    const work = h.coordinator.tick();
    await entered.promise;
    expect(h.observe('Stop', { session_id: 'a' })).toBe(true);
    await h.coordinator.tick();
    expect(requests).toBe(2);
    release.resolve();
    await work;
    await h.flush();
    expect(requests).toBe(3);
    expect(h.client.characters.get('npc_1')?.textStatus).toMatch(
      /^Ready for review/,
    );
  });

  test('old summaries cannot overwrite a new turn and failed batches are not retried forever', async () => {
    const h = setup();
    const response = deferred<NpcSummary | undefined>();
    h.summarize.mockImplementationOnce(() => response.promise);
    await h.coordinator.tick();
    h.observe('UserPromptSubmit', { prompt: 'Old objective', turn_id: 'old' });
    const work = h.coordinator.tick();
    h.observe('UserPromptSubmit', { prompt: 'New objective', turn_id: 'new' });
    response.resolve({ task: 'Old result', say: 'Old speech' });
    await work;
    expect(JSON.stringify(h.coordinator.describe())).not.toContain(
      'Old result',
    );
    h.summarize.mockResolvedValue(undefined);
    h.advance(30_000);
    await h.flush();
    const calls = h.summarize.mock.calls.length;
    h.advance(30_000);
    await h.flush();
    expect(h.summarize).toHaveBeenCalledTimes(calls);
    expect(h.summarize.mock.calls.at(-1)?.[0]).toContain('New objective');
    expect(h.summarize.mock.calls.at(-1)?.[0]).not.toContain('Old objective');
  });

  test('a lifecycle change during PATCH is published immediately after the stale response', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task', turn_id: 't1' });
    await h.flush();
    const entered = deferred<void>();
    const release = deferred<void>();
    const update = jest
      .mocked(h.client.npcs.updateNpc)
      .getMockImplementation()!;
    jest
      .spyOn(h.client.npcs, 'updateNpc')
      .mockImplementationOnce(async (id, patch) => {
        entered.resolve();
        await release.promise;
        return update(id, patch);
      });
    h.observe('Stop', { turn_id: 't1' });
    const work = h.coordinator.tick();
    await entered.promise;
    h.observe('UserPromptSubmit', { prompt: 'Next task', turn_id: 't2' });
    release.resolve();
    await work;
    await h.flush();
    expect(h.client.characters.get('npc_1')?.textStatus).toBe('Working');
    expect(h.client.characters.get('npc_1')?.say).toBeNull();
  });

  test('recovers an ambiguous create through its marker without issuing a second POST', async () => {
    const h = setup();
    const create = jest
      .mocked(h.client.npcs.createNpc)
      .getMockImplementation()!;
    jest
      .spyOn(h.client.npcs, 'createNpc')
      .mockImplementationOnce(async (data) => {
        await create(data);
        throw new Error('Response lost after commit');
      });
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    expect(h.repository.state?.records[0]?.creationAttempted).toBe(true);
    h.advance(60_000);
    await h.flush();
    expect(h.client.creates).toBe(1);
    expect(h.client.characters.get('npc_1')?.visible).toBe(true);
    expect(h.repository.state?.records[0]?.createName).toBeUndefined();
  });

  test('an unresolved ambiguous create stays inspectable instead of creating duplicates', async () => {
    const h = setup();
    jest
      .spyOn(h.client.npcs, 'createNpc')
      .mockRejectedValueOnce(new Error('Unknown delivery outcome'));
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    h.advance(60_000);
    await h.flush();
    h.advance(60_000);
    await h.flush();
    expect(h.client.npcs.createNpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.coordinator.describe())).toContain(
      'npc_create_uncertain_inspect_state',
    );
  });

  test('finds an ambiguous creation on a later page and ignores another owner with the same marker', async () => {
    const h = setup();
    const create = jest
      .mocked(h.client.npcs.createNpc)
      .getMockImplementation()!;
    jest
      .spyOn(h.client.npcs, 'createNpc')
      .mockImplementationOnce(async (data) => {
        await create(data);
        throw new Error('Response lost');
      });
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    const created = h.client.characters.get('npc_1')!;
    jest
      .spyOn(h.client.npcs, 'listNpcs')
      .mockResolvedValueOnce({
        data: {
          npcs: [{ ...created, id: 'npc_other', ownerId: 'u_someone' }],
          nextCursor: 'page2',
        },
      })
      .mockResolvedValueOnce({ data: { npcs: [created] } });
    h.advance(60_000);
    await h.flush();
    expect(h.client.npcs.listNpcs).toHaveBeenNthCalledWith(2, {
      limit: 100,
      cursor: 'page2',
    });
    expect(h.repository.state?.records[0]?.npcId).toBe('npc_1');
    expect(h.client.npcs.createNpc).toHaveBeenCalledTimes(1);
    expect(h.client.writes.some(({ id }) => id === 'npc_other')).toBe(false);
  });

  test('honors a rate-limit delay before retrying a definitively rejected create', async () => {
    const h = setup();
    jest.spyOn(h.client.npcs, 'createNpc').mockRejectedValueOnce({
      response: {
        status: 429,
        headers: { 'retry-after': '5' },
        data: { error: { code: 'rate_limited' } },
      },
    });
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    h.advance(4999);
    await h.flush();
    expect(h.client.npcs.createNpc).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.flush();
    expect(h.client.npcs.createNpc).toHaveBeenCalledTimes(2);
  });

  test('bounds speech across sessions and clears bubbles without replaying them', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { session_id: 'a', prompt: 'Task A' });
    h.observe('UserPromptSubmit', { session_id: 'b', prompt: 'Task B' });
    await h.flush();
    h.advance(2000);
    h.observe('Stop', { session_id: 'a' });
    h.observe('Stop', { session_id: 'b' });
    await h.flush();
    const spoken = () =>
      h.client.writes.filter(
        ({ patch }) => patch.say !== undefined && patch.say !== null,
      );
    expect(spoken()).toHaveLength(1);
    h.advance(10_000);
    await h.flush();
    expect(spoken()).toHaveLength(2);
    h.advance(10_000);
    await h.flush();
    expect(
      [...h.client.characters.values()].every((npc) => npc.say === null),
    ).toBe(true);
  });

  test('restores identity after restart and cannot touch an unrelated NPC', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    h.client.characters.set('npc_other', {
      id: 'npc_other',
      ownerId: 'u_someone',
      name: 'Unrelated',
      visible: true,
      createdAt: 1,
    });
    await h.coordinator.stop();
    const restarted = new NpcCoordinator(h.options);
    await restarted.tick();
    await restarted.tick();
    const signal = normalizeSession(
      'codex',
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'main',
        prompt: 'Resume',
      },
      NOW + 1000,
    )!;
    restarted.observe(signal);
    h.advance(3000);
    await restarted.tick();
    expect(h.client.creates).toBe(1);
    expect(h.client.characters.get('npc_1')?.name).toBe("Jesse's Codex 1");
    expect(h.client.writes.some(({ id }) => id === 'npc_other')).toBe(false);
    await restarted.stop();
  });

  test('refuses to use a ledger with another credential or owner', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    await h.coordinator.stop();
    const calls = h.client.writes.length;
    const wrongIdentity = new NpcCoordinator({
      ...h.options,
      account: identity('other-account'),
    });
    await wrongIdentity.tick();
    expect(JSON.stringify(wrongIdentity.describe())).toContain(
      'npc_state_belongs_to_another_api_identity',
    );
    expect(h.client.writes).toHaveLength(calls);
    await wrongIdentity.stop();
  });

  test('a fresh launch reads the persistent ledger and hides every previously visible NPC before reuse', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'workingon-restart-'),
    );
    const file = path.join(directory, 'npcs.json');
    const repository = new FileNpcState(file);
    const h = setup({ repository });
    const restarted = new NpcCoordinator({
      ...h.options,
      repository: new FileNpcState(file),
    });
    try {
      for (const session of ['a', 'b', 'c']) {
        h.observe('UserPromptSubmit', { session_id: session, prompt: 'Task' });
      }
      await h.flush(6);
      const saved = JSON.parse(await readFile(file, 'utf8')) as NpcState;
      expect(saved.records.map((record) => record.npcId)).toHaveLength(3);
      expect(
        [...h.client.characters.values()].every((npc) => npc.visible),
      ).toBe(true);
      // Release only the file lock, as process death would: do not run the
      // coordinator's shutdown cleanup or alter the remote characters.
      await repository.close();
      for (const npc of h.client.characters.values()) {
        npc.say = { text: 'Stale speech from before the crash' };
      }
      const writesBeforeRestart = h.client.writes.length;
      await restarted.tick();
      await restarted.tick();
      await restarted.tick();
      await restarted.tick();
      expect(
        [...h.client.characters.values()].every(
          (npc) =>
            npc.visible === false &&
            npc.say === null &&
            npc.textStatus === null,
        ),
      ).toBe(true);
      expect(
        new Set(h.client.writes.slice(writesBeforeRestart).map(({ id }) => id))
          .size,
      ).toBe(3);
      expect(restarted.describe()).toMatchObject({ startupHidesPending: 0 });
      const resume = normalizeSession(
        'codex',
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'a',
          prompt: 'Resume',
        },
        NOW,
      )!;
      restarted.observe(resume);
      await restarted.tick();
      const id = saved.records.find(
        (record) => record.key === resume.key,
      )!.npcId!;
      expect(h.client.characters.get(id)?.visible).toBe(true);
      expect(h.client.creates).toBe(3);
    } finally {
      await restarted.stop();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('early hooks and a failed startup hide cannot bypass hiding before reuse', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    // The old coordinator never started a timer. Leave its visible remote NPC
    // and durable snapshot intact to simulate a crash without graceful cleanup.
    const restarted = new NpcCoordinator(h.options);
    restarted.observe(
      normalizeSession(
        'codex',
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'main',
          prompt: 'Resume immediately',
        },
        NOW,
      )!,
    );
    const update = jest
      .mocked(h.client.npcs.updateNpc)
      .getMockImplementation()!;
    const entered = deferred<void>();
    const release = deferred<void>();
    jest
      .spyOn(h.client.npcs, 'updateNpc')
      .mockRejectedValueOnce(new Error('Temporary outage while hiding'))
      .mockImplementationOnce(async (id, patch) => {
        expect(patch).toMatchObject({
          visible: false,
          say: null,
          textStatus: null,
        });
        entered.resolve();
        await release.promise;
        return update(id, patch);
      });
    const before = h.client.writes.length;
    await restarted.tick();
    await restarted.tick();
    expect(restarted.describe()).toMatchObject({ startupHidesPending: 1 });
    expect(h.client.writes).toHaveLength(before);
    h.advance(1000);
    const recovery = restarted.tick();
    await entered.promise;
    restarted.observe(
      normalizeSession(
        'codex',
        {
          hook_event_name: 'PreToolUse',
          session_id: 'main',
          tool_name: 'Bash',
        },
        NOW + 1000,
      )!,
    );
    await restarted.tick();
    expect(h.client.writes).toHaveLength(before);
    release.resolve();
    await recovery;
    expect(h.client.characters.get('npc_1')?.visible).toBe(false);
    expect(restarted.describe()).toMatchObject({ startupHidesPending: 0 });
    await restarted.tick();
    expect(h.client.characters.get('npc_1')?.visible).toBe(true);
    expect(
      h.client.writes.slice(before).map(({ patch }) => patch.visible),
    ).toEqual([false, true]);
    await restarted.stop();
  });

  test('creation permission denial does not prevent existing companions from updating', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Existing task' });
    await h.flush();
    jest
      .spyOn(h.client.npcs, 'createNpc')
      .mockRejectedValueOnce(
        new NpcError('npc_create_not_permitted', false, 0, 403),
      );
    h.observe('UserPromptSubmit', { session_id: 'new', prompt: 'New task' });
    await h.flush();
    expect(h.coordinator.describe()).toMatchObject({
      creationDenied: true,
      error: null,
    });
    h.observe('Stop');
    await h.flush();
    expect(h.client.characters.get('npc_1')?.textStatus).toMatch(
      /^Ready for review/,
    );
    h.advance(60_000);
    await h.flush();
    expect(h.client.npcs.createNpc).toHaveBeenCalledTimes(2);
  });

  test('refuses to mutate a recorded NPC whose remote owner no longer matches', async () => {
    const h = setup();
    h.observe('UserPromptSubmit', { prompt: 'Task' });
    await h.flush();
    await h.coordinator.stop();
    h.client.characters.get('npc_1')!.ownerId = 'u_someone';
    const calls = h.client.writes.length;
    const restarted = new NpcCoordinator(h.options);
    await restarted.tick();
    await restarted.tick();
    expect(JSON.stringify(restarted.describe())).toContain('not_npc_owner');
    expect(h.client.writes).toHaveLength(calls);
    await restarted.stop();
    expect(h.client.writes).toHaveLength(calls);
  });

  test('disk failure prevents creation and capacity remains bounded', async () => {
    const h = setup({ maxSessions: 1 });
    await h.coordinator.tick();
    h.repository.rejectWrites = true;
    expect(h.observe('UserPromptSubmit', { prompt: 'Task' })).toBe(true);
    expect(
      h.observe('UserPromptSubmit', {
        session_id: 'second',
        prompt: 'Overflow',
      }),
    ).toBe(false);
    await h.flush();
    expect(h.client.creates).toBe(0);
    expect(JSON.stringify(h.coordinator.describe())).toContain(
      'npc_state_write_failed',
    );
  });
});
