import { identity } from '../src/inputs/session.js';
import { FileNpcState, parseNpcState } from '../src/npcs/state.js';
import type { NpcState } from '../src/npcs/types.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function state(): NpcState {
  return {
    version: 2,
    installation: '11111111-1111-4111-8111-111111111111',
    account: identity('test-account'),
    ownerId: 'u_owner',
    counter: 1,
    records: [{ number: 1, npcId: 'npc_1', lastSpokeAt: 0 }],
    sessions: [
      {
        key: identity('session'),
        source: 'codex',

        lastSeen: 1000,

        ended: false,
      },
    ],
  };
}

describe('NPC ownership state', () => {
  let directory: string;
  let file: string;
  const stores: FileNpcState[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'workingon-npcs-'));
    file = path.join(directory, 'npcs.json');
  });

  afterEach(async () => {
    await Promise.allSettled(stores.splice(0).map((store) => store.close()));
    await rm(directory, { recursive: true, force: true });
  });

  function store(): FileNpcState {
    const instance = new FileNpcState(file);
    stores.push(instance);
    return instance;
  }

  test('round-trips metadata atomically and allows reopening after release', async () => {
    const first = store();
    await expect(first.open()).resolves.toBeUndefined();
    await first.save(state());
    expect((await stat(file)).mode % 0o1000).toBe(0o600);
    await first.close();
    await expect(store().open()).resolves.toEqual(state());
  });

  test('refuses a live second writer', async () => {
    await store().open();
    await expect(store().open()).rejects.toThrow('locked');
  });

  test('serializes snapshots without persisting later mutations', async () => {
    const writer = store();
    await writer.open();
    const first = state();
    const writing = writer.save(first);
    first.sessions[0]!.lastSeen = 2000;
    await writing;
    expect(JSON.parse(await readFile(file, 'utf8')).sessions[0].lastSeen).toBe(
      1000,
    );
    await writer.save(first);
    expect(JSON.parse(await readFile(file, 'utf8')).sessions[0].lastSeen).toBe(
      2000,
    );
  });

  test('corrupt files fail closed and remain available for inspection', async () => {
    await writeFile(file, '{incomplete');
    await expect(store().open()).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{incomplete');
  });

  test('legacy ledgers fail closed with a reset instruction and remain intact', async () => {
    const legacy = JSON.stringify({
      version: 1,
      records: [{ npcId: 'npc_legacy' }],
    });
    await writeFile(file, legacy);
    await expect(store().open()).rejects.toThrow(
      'explicit ownership-verified reset',
    );
    expect(await readFile(file, 'utf8')).toBe(legacy);
  });

  test('rejects dangling and duplicate leases', () => {
    const input = state();
    input.records[0]!.sessionKey = identity('missing');
    expect(() => parseNpcState(input)).toThrow('lease');
    input.records[0]!.sessionKey = input.sessions[0]!.key;
    input.counter = 2;
    input.records.push({
      number: 2,
      lastSpokeAt: 0,
      sessionKey: input.sessions[0]!.key,
    });
    expect(() => parseNpcState(input)).toThrow('lease');
  });

  test('incomplete locks are not automatically stolen', async () => {
    await writeFile(`${file}.lock`, '');
    await expect(store().open()).rejects.toThrow();
    expect(await readFile(`${file}.lock`, 'utf8')).toBe('');
  });

  test('recovers a lock only when its process is confirmed dead', async () => {
    await writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: 999999, token: 'previous' }),
    );
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Process no longer exists'), {
        code: 'ESRCH',
      });
    });
    try {
      await expect(store().open()).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith(999999, 0);
      expect(JSON.parse(await readFile(`${file}.lock`, 'utf8')).pid).toBe(
        process.pid,
      );
    } finally {
      kill.mockRestore();
    }
  });

  test('permission to inspect a process being denied does not authorize stealing its lock', async () => {
    const lock = JSON.stringify({ pid: 999999, token: 'previous' });
    await writeFile(`${file}.lock`, lock);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Not allowed to inspect this process'), {
        code: 'EPERM',
      });
    });
    try {
      await expect(store().open()).rejects.toThrow('locked');
      expect(await readFile(`${file}.lock`, 'utf8')).toBe(lock);
    } finally {
      kill.mockRestore();
    }
  });

  test('strips unrecognized fields so prompt text cannot leak into snapshots', () => {
    const input = { ...state(), prompt: 'private prompt' };
    Object.assign(input.records[0]!, {
      project: 'private project',
      textStatus: 'private summary',
    });
    expect(JSON.stringify(parseNpcState(input))).not.toMatch(
      /private|textStatus|project|prompt/,
    );
  });

  test('rejects duplicate ownership and invalid pending creation markers', () => {
    const duplicate = state();
    duplicate.counter = 2;
    duplicate.records.push({
      ...duplicate.records[0]!,
      number: 2,
    });
    expect(() => parseNpcState(duplicate)).toThrow('multiple slots');
    const invalid = state();
    delete invalid.records[0]!.npcId;
    invalid.records[0]!.createName = "Jesse's manually created NPC";
    invalid.records[0]!.creationAttempted = true;
    expect(() => parseNpcState(invalid)).toThrow('pending creation');
  });
});
