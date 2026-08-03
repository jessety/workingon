import { PresenceUpdater, type PresenceClient } from '../src/outputs/sowork.js';

class FakeSoWork implements PresenceClient {
  textStatus: string | undefined;
  writes: Array<string | null> = [];
  failGetMe = false;

  me = {
    getMe: (): Promise<{ data: { presence?: { textStatus?: string } } }> => {
      if (this.failGetMe) {
        return Promise.reject(new Error('network down'));
      }
      return Promise.resolve({
        data: { presence: { textStatus: this.textStatus } },
      });
    },
    updatePresence: (data: {
      textStatus?: string | null;
    }): Promise<unknown> => {
      this.writes.push(data.textStatus ?? null);
      this.textStatus = data.textStatus ?? undefined;
      return Promise.resolve({});
    },
  };
}

function build(textStatus?: string) {
  const sowork = new FakeSoWork();
  sowork.textStatus = textStatus;
  const presence = new PresenceUpdater({
    apiKey: 'sw_test',
    baseUrl: '',
    dryRun: false,
    client: sowork,
  });
  return { sowork, presence };
}

describe('seeding', () => {
  test('clears a status left over from before a restart', async () => {
    // The restart bug: SoWork holds a status this process never set. Without
    // seeding, clear() sees null in memory and leaves the stale status forever.
    const { sowork, presence } = build('debugging the webhook publish path');

    await presence.seed();
    await presence.clear();

    expect(sowork.writes).toEqual([null]);
    expect(sowork.textStatus).toBeUndefined();
  });

  test('skips the write when the new status matches what SoWork already shows', async () => {
    const { sowork, presence } = build('reviewing the auth flow');

    await presence.seed();
    await presence.set('reviewing the auth flow');

    expect(sowork.writes).toEqual([]);
  });

  test('does nothing to clear when SoWork shows no status', async () => {
    const { sowork, presence } = build(undefined);

    await presence.seed();
    await presence.clear();

    expect(sowork.writes).toEqual([]);
  });

  test('a failed seed is survivable and keeps the old behavior', async () => {
    const { sowork, presence } = build('some stale status');
    sowork.failGetMe = true;

    await expect(presence.seed()).resolves.toBeUndefined();

    // Unknown state — clear() conservatively does nothing, as before seeding existed
    await presence.clear();
    expect(sowork.writes).toEqual([]);
  });

  test('is a no-op in dry run', async () => {
    const presence = new PresenceUpdater({
      apiKey: '',
      baseUrl: '',
      dryRun: true,
    });
    await expect(presence.seed()).resolves.toBeUndefined();
    expect(presence.state.status).toBeNull();
  });
});

describe('writing', () => {
  test('set then clear round-trips through the client', async () => {
    const { sowork, presence } = build();

    await presence.set('drafting docs');
    await presence.clear();

    expect(sowork.writes).toEqual(['drafting docs', null]);
    expect(presence.state.status).toBeNull();
  });

  test('a failed write leaves the recorded state untouched', async () => {
    const { sowork, presence } = build();
    sowork.me.updatePresence = () => Promise.reject(new Error('503'));

    const accepted = await presence.set('anything');

    expect(accepted).toBe(false);
    expect(presence.state.status).toBeNull();
  });
});
