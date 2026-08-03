import type { ActivityEvent } from '../src/activity/events.js';
import { ActivityStore } from '../src/activity/store.js';

function event(at: number, detail = 'x'): ActivityEvent {
  return {
    at,
    source: 'claude',
    session: 's',
    project: 'p',
    kind: 'tool',
    detail,
  };
}

describe('ActivityStore', () => {
  test('rejects a non-positive capacity', () => {
    expect(() => new ActivityStore(0)).toThrow(RangeError);
    expect(() => new ActivityStore(1.5)).toThrow(RangeError);
  });

  test('holds events up to capacity', () => {
    const store = new ActivityStore(3);
    store.add(event(1));
    store.add(event(2));

    expect(store.size).toBe(2);
    expect(store.dropped).toBe(0);
  });

  test('evicts the oldest event past capacity', () => {
    const store = new ActivityStore(2);
    store.add(event(1, 'first'));
    store.add(event(2, 'second'));
    store.add(event(3, 'third'));

    expect(store.size).toBe(2);
    expect(store.dropped).toBe(1);
    expect(store.since(0).map((e) => e.detail)).toEqual(['second', 'third']);
  });

  test('since() returns only events strictly after the watermark', () => {
    const store = new ActivityStore(10);
    store.add(event(10));
    store.add(event(20));
    store.add(event(30));

    expect(store.since(20).map((e) => e.at)).toEqual([30]);
    expect(store.since(30)).toEqual([]);
  });

  test('tracks the most recent activity timestamp', () => {
    const store = new ActivityStore(10);
    expect(store.lastActivityAt).toBe(0);

    store.add(event(42));
    expect(store.lastActivityAt).toBe(42);
  });

  test('clear() empties the buffer', () => {
    const store = new ActivityStore(10);
    store.add(event(1));
    store.clear();

    expect(store.size).toBe(0);
    expect(store.lastActivityAt).toBe(0);
  });
});
