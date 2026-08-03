import { SlackStatus } from '../src/outputs/slack.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: {
    profile: {
      status_text: string;
      status_emoji: string;
      status_expiration: number;
    };
  };
}

function build(
  options: { expirationSeconds?: number; reply?: unknown; emoji?: string } = {},
) {
  const calls: Call[] = [];

  const fetchFn = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Call['body'],
    });
    return Promise.resolve(
      new Response(JSON.stringify(options.reply ?? { ok: true }), {
        status: 200,
      }),
    );
  }) as typeof fetch;

  const slack = new SlackStatus({
    token: 'xoxp-test',
    dryRun: false,
    emoji: options.emoji ?? ':speech_balloon:',
    expirationSeconds: options.expirationSeconds ?? 1800,
    fetchFn,
  });

  return { slack, calls };
}

describe('SlackStatus', () => {
  test('writes the status through users.profile.set with the token', async () => {
    const { slack, calls } = build();

    const accepted = await slack.set('drafting docs explaining design choices');

    expect(accepted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://slack.com/api/users.profile.set');
    expect(calls[0]?.headers.authorization).toBe('Bearer xoxp-test');
    expect(calls[0]?.body.profile.status_text).toBe(
      'drafting docs explaining design choices',
    );
    expect(calls[0]?.body.profile.status_emoji).toBe(':speech_balloon:');
  });

  test("clamps to Slack's 100-character platform limit", async () => {
    const { slack, calls } = build();

    await slack.set('x'.repeat(300));

    const sent = calls[0]?.body.profile.status_text ?? '';
    expect(sent.length).toBeLessThanOrEqual(100);
  });

  test('sets an expiration so a dead service cannot leave a stale status', async () => {
    const { slack, calls } = build({ expirationSeconds: 1800 });
    const before = Math.floor(Date.now() / 1000);

    await slack.set('working');

    const expiration = calls[0]?.body.profile.status_expiration ?? 0;
    expect(expiration).toBeGreaterThanOrEqual(before + 1800);
    expect(expiration).toBeLessThanOrEqual(before + 1810);
  });

  test('clear() empties text, emoji, and expiration', async () => {
    const { slack, calls } = build();
    await slack.set('working');

    await slack.clear();

    expect(calls[1]?.body.profile).toEqual({
      status_text: '',
      status_emoji: '',
      status_expiration: 0,
    });
    expect(slack.state.status).toBeNull();
  });

  test('clear() without a known status writes nothing', async () => {
    const { slack, calls } = build();
    await slack.clear();
    expect(calls).toHaveLength(0);
  });

  test('skips the write when the status is unchanged', async () => {
    const { slack, calls } = build();
    await slack.set('same thing');
    await slack.set('same thing');
    expect(calls).toHaveLength(1);
  });

  test('treats ok:false from Slack as failure and keeps state', async () => {
    // Slack reports failures in the body with HTTP 200
    const { slack, calls } = build({
      reply: { ok: false, error: 'invalid_auth' },
    });

    const accepted = await slack.set('anything');

    expect(accepted).toBe(false);
    expect(calls).toHaveLength(1);
    expect(slack.state.status).toBeNull();
  });

  test('survives a network failure', async () => {
    const slack = new SlackStatus({
      token: 'xoxp-test',
      dryRun: false,
      emoji: '',
      expirationSeconds: 0,
      fetchFn: (() => Promise.reject(new Error('offline'))) as typeof fetch,
    });

    await expect(slack.set('anything')).resolves.toBe(false);
  });

  test('dry run records state without calling Slack', async () => {
    const calls: Call[] = [];
    const slack = new SlackStatus({
      token: '',
      dryRun: true,
      emoji: '',
      expirationSeconds: 0,
      fetchFn: (() => {
        calls.push({} as Call);
        return Promise.resolve(new Response('{}'));
      }) as typeof fetch,
    });

    await slack.set('working');

    expect(calls).toHaveLength(0);
    expect(slack.state.status).toBe('working');
  });
});
