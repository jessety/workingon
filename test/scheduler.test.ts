import type { ActivityEvent } from '../src/activity/events.js';
import { ActivityStore } from '../src/activity/store.js';
import {
  Scheduler,
  type StatusPublisher,
  type StatusSummarizer,
} from '../src/scheduler.js';

function prompt(at: number, detail: string): ActivityEvent {
  return {
    at,
    source: 'claude',
    session: 's1',
    project: 'repo',
    kind: 'prompt',
    detail,
  };
}

class FakeSummarizer implements StatusSummarizer {
  digests: string[] = [];
  result: string | undefined = 'Updating the build tooling';

  summarize(digest: string): Promise<string | undefined> {
    this.digests.push(digest);
    return Promise.resolve(this.result);
  }
}

class FakePublisher implements StatusPublisher {
  set_: string[] = [];
  cleared = 0;

  set(status: string): Promise<boolean> {
    this.set_.push(status);
    return Promise.resolve(true);
  }

  clear(): Promise<boolean> {
    this.cleared += 1;
    return Promise.resolve(true);
  }
}

function build(options: { idleClearMinutes?: number } = {}) {
  const store = new ActivityStore(100);
  const summarizer = new FakeSummarizer();
  const presence = new FakePublisher();
  const scheduler = new Scheduler({
    store,
    summarizer,
    presence,
    intervalMinutes: 10,
    idleClearMinutes: options.idleClearMinutes ?? 30,
  });

  return { store, summarizer, presence, scheduler };
}

describe('Scheduler.tick', () => {
  test('summarizes new activity and publishes the status', async () => {
    const { store, summarizer, presence, scheduler } = build();
    store.add(prompt(Date.now(), 'Upgrade the dependencies'));

    await scheduler.tick();

    expect(summarizer.digests).toHaveLength(1);
    expect(summarizer.digests[0]).toContain('Upgrade the dependencies');
    expect(presence.set_).toEqual(['Updating the build tooling']);
  });

  test('makes no API call when nothing happened', async () => {
    const { summarizer, presence, scheduler } = build();

    await scheduler.tick();

    expect(summarizer.digests).toHaveLength(0);
    expect(presence.set_).toHaveLength(0);
  });

  test('does not re-summarize activity it already covered', async () => {
    const { store, summarizer, scheduler } = build();
    store.add(prompt(Date.now(), 'First batch'));

    await scheduler.tick();
    await scheduler.tick();

    expect(summarizer.digests).toHaveLength(1);
  });

  test('summarizes only activity newer than the last cycle', async () => {
    const { store, summarizer, scheduler } = build();
    store.add(prompt(Date.now(), 'First batch'));
    await scheduler.tick();

    store.add(prompt(Date.now() + 1, 'Second batch'));
    await scheduler.tick();

    expect(summarizer.digests).toHaveLength(2);
    expect(summarizer.digests[1]).toContain('Second batch');
    expect(summarizer.digests[1]).not.toContain('First batch');
  });

  test('leaves the existing status alone when the model returns nothing', async () => {
    const { store, summarizer, presence, scheduler } = build();
    summarizer.result = undefined;
    store.add(prompt(Date.now(), 'Something happened'));

    await scheduler.tick();

    expect(presence.set_).toHaveLength(0);
    expect(presence.cleared).toBe(0);
  });

  test('advances past activity even when summarizing fails', async () => {
    const { store, summarizer, scheduler } = build();
    summarizer.result = undefined;
    store.add(prompt(Date.now(), 'Failed batch'));

    await scheduler.tick();
    await scheduler.tick();

    // Second tick should find nothing new rather than retrying the same batch
    expect(summarizer.digests).toHaveLength(1);
  });

  test('clears the status once activity has gone stale', async () => {
    const { store, presence, scheduler } = build({ idleClearMinutes: 30 });
    store.add(prompt(Date.now() - 60 * 60_000, 'Ancient history'));

    // First tick consumes the old event, second sees an idle window
    await scheduler.tick();
    await scheduler.tick();

    expect(presence.cleared).toBe(1);
  });

  test('does not clear while still within the idle window', async () => {
    const { store, presence, scheduler } = build({ idleClearMinutes: 30 });
    store.add(prompt(Date.now() - 60_000, 'Recent work'));

    await scheduler.tick();
    await scheduler.tick();

    expect(presence.cleared).toBe(0);
  });

  test('never clears when idle clearing is disabled', async () => {
    const { store, presence, scheduler } = build({ idleClearMinutes: 0 });
    store.add(prompt(Date.now() - 60 * 60_000, 'Ancient history'));

    await scheduler.tick();
    await scheduler.tick();

    expect(presence.cleared).toBe(0);
  });
});
