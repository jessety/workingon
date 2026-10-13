import { normalizeSession } from '../src/inputs/session.js';
import { log } from '../src/logger.js';
import { DryRunNpcClient } from '../src/npcs/client.js';
import { NpcCoordinator } from '../src/npcs/coordinator.js';
import type { NpcState, NpcStateRepository } from '../src/npcs/types.js';

const NOW = 1_700_000_000_000;

// Exercise the real coordinator with a fake clock and memory-only collaborators.
// No live client, ownership file, or interval is started by these tests.
function setup() {
  let now = NOW;
  let state: NpcState | undefined;
  const client = new DryRunNpcClient();
  const getMe = jest.spyOn(client.me, 'getMe');
  const create = jest.spyOn(client.npcs, 'createNpc');
  const update = jest.spyOn(client.npcs, 'updateNpc');
  const repository: NpcStateRepository = {
    open: jest.fn(async () => structuredClone(state)),
    save: jest.fn(async (snapshot) => {
      state = structuredClone(snapshot);
    }),
    close: jest.fn(async () => {}),
  };

  const coordinator = new NpcCoordinator({
    client,
    repository,
    summarizer: { summarize: async () => undefined },
    account: 'test-account',
    namePrefix: 'Test',
    animationsEnabled: false,
    idleMinutes: 10,
    staleMinutes: 120,
    summaryIntervalSeconds: 30,
    speechCooldownSeconds: 60,
    maxSessions: 50,
    now: () => now,
    random: () => 0,
  });

  function observe(
    hook = 'UserPromptSubmit',
    session = 'first',
    source: 'claude' | 'codex' = 'claude',
  ): boolean {
    const signal = normalizeSession(
      source,
      {
        hook_event_name: hook,
        session_id: session,
        cwd: '/tmp/shared-project',
        tool_name: 'Bash',
      },
      now,
    );

    if (signal === undefined) {
      throw new Error('Invalid test signal');
    }

    return coordinator.observe(signal);
  }

  async function flush(count = 6): Promise<void> {
    if (count === 0) {
      return;
    }

    await coordinator.tick();
    await flush(count - 1);
  }

  return {
    coordinator,
    getMe,
    create,
    update,
    repository,
    observe,
    flush,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NPC presence recovery', () => {
  test.each(['claude', 'codex'] as const)(
    '%s sessions keep updating, allocating, hiding, and reusing NPCs through repeated presence 404s',
    async (source) => {
      const h = setup();
      const info = jest.spyOn(log, 'info');
      const warn = jest.spyOn(log, 'warn');
      h.observe('UserPromptSubmit', 'first', source);
      await h.flush();

      // Match the production error classification without a structured API code.
      const failure = { response: { status: 404, data: 'Not Found' } };
      h.getMe
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure);
      h.advance(30_000);
      await h.flush();

      expect(h.coordinator.describe()).toMatchObject({
        ready: true,
        error: null,
        presenceError: 'npc_http_404',
        ownerOnline: true,
      });
      expect(warn).toHaveBeenCalledWith(
        'NPC presence refresh failed; retaining last known availability and retrying',
        { code: 'npc_http_404', retryInMs: 30_000 },
      );
      expect(h.observe('PermissionRequest', 'first', source)).toBe(true);
      expect(h.observe('UserPromptSubmit', 'second', source)).toBe(true);
      expect(h.observe('UserPromptSubmit', 'third', source)).toBe(true);
      await h.flush();

      expect(h.create).toHaveBeenCalledTimes(3);
      expect(h.coordinator.describe()).toMatchObject({ pool: { assigned: 3 } });
      expect(h.update).toHaveBeenCalledWith(
        'npc_dry1',
        expect.objectContaining({
          location: { type: 'user', userId: 'dry-run' },
        }),
      );

      h.advance(30_000);
      await h.flush();
      h.observe('Stop', 'first', source);
      await h.flush();
      h.advance(600_000);
      await h.flush();

      expect(h.coordinator.describe()).toMatchObject({
        error: null,
        presenceError: 'npc_http_404',
        pool: { available: 1, assigned: 2 },
      });
      expect(h.update).toHaveBeenCalledWith('npc_dry1', {
        visible: false,
        say: null,
        textStatus: null,
        animation: null,
      });
      h.observe('UserPromptSubmit', 'fourth', source);
      await h.flush();
      expect(h.create).toHaveBeenCalledTimes(3);
      expect(h.coordinator.describe()).toMatchObject({ pool: { assigned: 3 } });

      h.advance(30_000);
      await h.flush();
      expect(h.coordinator.describe()).toMatchObject({
        error: null,
        presenceError: null,
      });
      expect(info).toHaveBeenCalledWith('NPC presence refresh recovered');
    },
  );

  test.each(['available', 'offline'] as const)(
    'retains %s availability during failed reads, then applies the recovered presence',
    async (availability) => {
      const h = setup();
      h.getMe.mockResolvedValueOnce({
        data: { id: 'dry-run', presence: { availability } },
      });
      h.observe('PermissionRequest');
      await h.flush();

      h.getMe.mockRejectedValueOnce({ response: { status: 404 } });
      h.advance(30_000);
      await h.flush();
      const online = availability !== 'offline';
      expect(h.coordinator.describe()).toMatchObject({
        ownerOnline: online,
        sessions: [{ location: { type: online ? 'user' : 'desk' } }],
      });

      h.advance(29_999);
      await h.flush();
      expect(h.getMe).toHaveBeenCalledTimes(2);

      h.getMe.mockResolvedValueOnce({
        data: {
          id: 'dry-run',
          presence: { availability: online ? 'offline' : 'available' },
        },
      });
      h.advance(1);
      await h.flush();
      expect(h.getMe).toHaveBeenCalledTimes(3);
      expect(h.coordinator.describe()).toMatchObject({
        ownerOnline: !online,
        presenceError: null,
        sessions: [{ location: { type: online ? 'desk' : 'user' } }],
      });
      expect(h.update).toHaveBeenLastCalledWith(
        'npc_dry1',
        expect.objectContaining({
          location: online
            ? { type: 'desk' }
            : { type: 'user', userId: 'dry-run' },
        }),
      );
    },
  );

  test('a slow failed read does not overlap polls or trigger an immediate retry', async () => {
    const h = setup();
    await h.flush();
    h.getMe.mockImplementationOnce(async () => {
      h.advance(45_000);
      await h.coordinator.tick();
      return Promise.reject({ response: { status: 404 } });
    });

    h.advance(30_000);
    await h.flush();
    expect(h.getMe).toHaveBeenCalledTimes(2);

    h.advance(29_999);
    await h.flush();
    expect(h.getMe).toHaveBeenCalledTimes(2);

    h.advance(1);
    await h.flush();
    expect(h.getMe).toHaveBeenCalledTimes(3);
    expect(h.coordinator.describe()).toMatchObject({ presenceError: null });
  });

  test.each([400, 404, 408, 500, 502])(
    'startup HTTP %i retries with backoff before any NPC mutation',
    async (status) => {
      const h = setup();
      h.getMe.mockRejectedValueOnce({ response: { status } });
      h.observe();
      await h.flush();

      expect(h.getMe).toHaveBeenCalledTimes(1);
      expect(h.repository.open).toHaveBeenCalledTimes(1);
      expect(h.repository.save).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
      expect(h.coordinator.describe()).toMatchObject({
        ready: false,
        buffered: 1,
      });

      h.advance(999);
      await h.flush();
      expect(h.getMe).toHaveBeenCalledTimes(1);
      h.advance(1);
      await h.flush();

      expect(h.getMe).toHaveBeenCalledTimes(2);
      expect(h.repository.open).toHaveBeenCalledTimes(1);
      expect(h.coordinator.describe()).toMatchObject({
        ready: true,
        error: null,
        buffered: 0,
        pool: { assigned: 1 },
      });
      expect(h.create).toHaveBeenCalledTimes(1);
    },
  );

  test.each([429, 503])(
    'presence HTTP %i honors Retry-After while retaining incoming sessions',
    async (status) => {
      const h = setup();
      await h.flush();
      h.getMe.mockRejectedValueOnce({
        response: { status, headers: { 'retry-after': '75' } },
      });
      h.advance(30_000);
      await h.flush();
      expect(h.observe()).toBe(true);
      await h.flush();

      h.advance(74_999);
      await h.flush();
      expect(h.getMe).toHaveBeenCalledTimes(2);
      expect(h.create).toHaveBeenCalledTimes(status === 429 ? 0 : 1);

      h.advance(1);
      await h.flush();
      expect(h.getMe).toHaveBeenCalledTimes(3);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.coordinator.describe()).toMatchObject({
        error: null,
        presenceError: null,
        pool: { assigned: 1 },
      });
    },
  );

  test.each([401, 403])(
    'startup HTTP %i still fails closed',
    async (status) => {
      const h = setup();
      h.getMe.mockRejectedValueOnce({ response: { status } });
      h.observe();
      await h.flush();
      h.advance(60_000);
      await h.flush();

      expect(h.coordinator.describe()).toMatchObject({
        error: `npc_http_${status}`,
      });
      expect(h.getMe).toHaveBeenCalledTimes(1);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
    },
  );

  test.each([401, 403, 'owner-change'] as const)(
    'a periodic %s stops publishing and logs the actual fatal state',
    async (failure) => {
      const h = setup();
      const error = jest.spyOn(log, 'error');
      h.observe();
      await h.flush();
      const updates = h.update.mock.calls.length;

      if (failure === 'owner-change') {
        h.getMe.mockResolvedValueOnce({
          data: {
            id: 'another-owner',
            presence: { availability: 'available' },
          },
        });
      } else {
        h.getMe.mockRejectedValueOnce({ response: { status: failure } });
      }

      h.advance(30_000);
      await h.flush();
      const code =
        failure === 'owner-change'
          ? 'npc_owner_changed'
          : `npc_http_${failure}`;
      expect(h.coordinator.describe()).toMatchObject({ error: code });
      expect(error).toHaveBeenCalledWith(
        'NPC publishing paused: presence identity or authentication check failed',
        code,
      );
      expect(h.observe('UserPromptSubmit', 'second')).toBe(false);

      h.advance(60_000);
      await h.flush();
      expect(h.getMe).toHaveBeenCalledTimes(2);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.update).toHaveBeenCalledTimes(updates);
    },
  );
});
