import { ActivityStore } from '../src/activity/store.js';
import type { SessionSink } from '../src/npcs/types.js';
import { createServer } from '../src/server.js';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

const TOKEN = 'test-token';

let server: http.Server;
let store: ActivityStore;
let origin: string;

function listen(instance: http.Server): Promise<void> {
  return new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
}

function close(instance: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    instance.close((error) => (error ? reject(error) : resolve())),
  );
}

function post(path: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  store = new ActivityStore(100);
  server = createServer({
    port: 0,
    token: TOKEN,
    store,
    describeStatus: () => ({ status: 'Testing', updatedAt: null }),
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await close(server);
});

describe('GET /health', () => {
  test('responds without authentication', async () => {
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe('POST /hooks', () => {
  test('records a recognized hook event', async () => {
    const response = await post('/hooks', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/Users/jesse/my-project',
      prompt_text: 'Add a changelog',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recorded: true });

    const events = store.since(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.project).toBe('my-project');
    expect(events[0]?.detail).toBe('Add a changelog');
  });

  test('accepts but does not record an unsubscribed event', async () => {
    const response = await post('/hooks', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recorded: false });
    expect(store.size).toBe(0);
  });

  test('rejects a request with no token', async () => {
    const response = await fetch(`${origin}/hooks`, {
      method: 'POST',
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    });

    expect(response.status).toBe(401);
    expect(store.size).toBe(0);
  });

  test('rejects a request with the wrong token', async () => {
    const response = await post(
      '/hooks',
      { hook_event_name: 'Stop' },
      'wrong-token',
    );
    expect(response.status).toBe(401);
  });

  test('rejects a malformed body', async () => {
    const response = await post('/hooks', 'not json at all');
    expect(response.status).toBe(400);
  });

  test('rejects a body with no hook_event_name', async () => {
    const response = await post('/hooks', { something: 'else' });
    expect(response.status).toBe(400);
  });
});

describe('input routes', () => {
  test('POST /hooks/claude records like the bare /hooks alias', async () => {
    const explicit = await post('/hooks/claude', {
      hook_event_name: 'UserPromptSubmit',
      cwd: '/x/repo',
      prompt_text: 'via the explicit route',
    });

    expect(explicit.status).toBe(200);
    await expect(explicit.json()).resolves.toEqual({ recorded: true });
    expect(store.since(0)[0]?.source).toBe('claude');
  });

  test('POST /hooks/codex records with the codex source', async () => {
    const response = await post('/hooks/codex', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'c1',
      cwd: '/x/repo',
      prompt: 'refactor the consumer',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ recorded: true });

    const events = store.since(0);
    expect(events[0]?.source).toBe('codex');
    expect(events[0]?.detail).toBe('refactor the consumer');
  });

  test('codex route requires the same authentication', async () => {
    const response = await post(
      '/hooks/codex',
      { hook_event_name: 'Stop' },
      'wrong-token',
    );
    expect(response.status).toBe(401);
  });

  test('an unknown hooks path is a 404, not a silent success', async () => {
    const response = await post('/hooks/cursor', { hook_event_name: 'Stop' });
    expect(response.status).toBe(404);
  });
});

describe('GET /status', () => {
  test('reports buffered activity', async () => {
    await post('/hooks', {
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/demo',
      prompt_text: 'Do the thing',
    });

    const response = await fetch(`${origin}/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      buffered: number;
      status: { status: string };
    };
    expect(body.buffered).toBe(1);
    expect(body.status.status).toBe('Testing');
  });

  test('requires authentication', async () => {
    const response = await fetch(`${origin}/status`);
    expect(response.status).toBe(401);
  });
});

describe('unknown routes', () => {
  test('returns 404', async () => {
    const response = await fetch(`${origin}/nope`);
    expect(response.status).toBe(404);
  });
});

describe('authentication disabled', () => {
  test('accepts hooks with no token when none is configured', async () => {
    const openStore = new ActivityStore(10);
    const openServer = createServer({
      port: 0,
      token: '',
      store: openStore,
      describeStatus: () => null,
    });
    await listen(openServer);
    const { port } = openServer.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        hook_event_name: 'Stop',
        last_assistant_message: 'Done',
      }),
    });

    expect(response.status).toBe(200);
    expect(openStore.size).toBe(1);

    await close(openServer);
  });
});

describe('optional NPC lifecycle lane', () => {
  async function withNpcs(
    sessions: SessionSink,
    run: () => Promise<void>,
  ): Promise<void> {
    await close(server);
    server = createServer({
      port: 0,
      token: TOKEN,
      store,
      sessions,
      describeStatus: () => ({ personal: 'Existing status' }),
    });
    await listen(server);
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await run();
  }

  test('accepts a textless lifecycle event without adding noise to the personal digest', async () => {
    const observe = jest.fn(() => true);
    await withNpcs(
      { observe, describe: () => ({ enabled: true }) },
      async () => {
        const response = await post('/hooks/codex', {
          hook_event_name: 'Stop',
          session_id: 's1',
          last_assistant_message: null,
        });
        await expect(response.json()).resolves.toEqual({ recorded: true });
        expect(observe).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'stop', source: 'codex' }),
        );
        expect(store.size).toBe(0);
        const status = await fetch(`${origin}/status`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        await expect(status.json()).resolves.toMatchObject({
          status: { personal: 'Existing status' },
          npcs: { enabled: true },
        });
      },
    );
  });

  test('a failed NPC sink cannot fail a hook or lose personal activity', async () => {
    await withNpcs(
      {
        observe: () => {
          throw new Error('NPC unavailable');
        },
        describe: () => null,
      },
      async () => {
        const response = await post('/hooks', {
          hook_event_name: 'UserPromptSubmit',
          session_id: 's1',
          prompt: 'A request',
        });
        expect(response.status).toBe(200);
        expect(store.size).toBe(1);
      },
    );
  });
});
