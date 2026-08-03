import { Broadcast } from '../src/outputs/broadcast.js';
import type { StatusPublisher } from '../src/scheduler.js';

class Recorder implements StatusPublisher {
  set_: string[] = [];
  cleared = 0;
  accept = true;

  set(status: string): Promise<boolean> {
    this.set_.push(status);
    return Promise.resolve(this.accept);
  }

  clear(): Promise<boolean> {
    this.cleared += 1;
    return Promise.resolve(this.accept);
  }
}

describe('Broadcast', () => {
  test('fans a status out to every publisher', async () => {
    const a = new Recorder();
    const b = new Recorder();

    await new Broadcast([a, b]).set('shipping the release');

    expect(a.set_).toEqual(['shipping the release']);
    expect(b.set_).toEqual(['shipping the release']);
  });

  test('one destination failing does not stop the others', async () => {
    const failing = new Recorder();
    failing.accept = false;
    const healthy = new Recorder();

    const accepted = await new Broadcast([failing, healthy]).set('still ships');

    expect(healthy.set_).toEqual(['still ships']);
    expect(accepted).toBe(true);
  });

  test('reports failure only when every destination fails', async () => {
    const a = new Recorder();
    const b = new Recorder();
    a.accept = false;
    b.accept = false;

    await expect(new Broadcast([a, b]).set('nope')).resolves.toBe(false);
  });

  test('clear reaches every publisher', async () => {
    const a = new Recorder();
    const b = new Recorder();

    await new Broadcast([a, b]).clear();

    expect(a.cleared).toBe(1);
    expect(b.cleared).toBe(1);
  });
});
