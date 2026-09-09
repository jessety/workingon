import { identity, normalizeSession } from '../src/inputs/session.js';
import { Session } from '../src/npcs/session.js';
import type { SessionSignal } from '../src/npcs/types.js';

const NOW = 1_700_000_000_000;

function signal(
  hook: string,
  fields: Record<string, unknown> = {},
  at = NOW,
): SessionSignal {
  const result = normalizeSession(
    'codex',
    {
      hook_event_name: hook,
      session_id: 'main',
      cwd: '/tmp/shared-repo',
      ...fields,
    },
    at,
  );
  if (result === undefined) {
    throw new Error('Invalid test signal');
  }
  return result;
}

function session(): Session {
  const input = signal('UserPromptSubmit', {
    prompt: 'Improve invitations',
    turn_id: 'turn-1',
  });
  const result = new Session(input.key, input.source, input.at);
  result.apply(input);
  return result;
}

describe('NPC input privacy and identity', () => {
  test('keeps same-repository sessions and agent sources independent', () => {
    const codex = signal('SessionStart');
    const other = signal('SessionStart', { session_id: 'another' });
    const claude = normalizeSession(
      'claude',
      { hook_event_name: 'SessionStart', session_id: 'main' },
      NOW,
    );
    expect(new Set([codex.key, other.key, claude?.key]).size).toBe(3);
    expect(codex.key).toBe(identity('codex\0main'));
    expect(JSON.stringify(codex)).not.toContain('/tmp/');
  });

  test.each(
    [undefined, null, '', 'unknown', {}, ['s1'], 'x'.repeat(257)].map((id) => [
      id,
    ]),
  )('rejects unusable session ids: %p', (id) => {
    expect(
      normalizeSession(
        'codex',
        { hook_event_name: 'Stop', session_id: id },
        NOW,
      ),
    ).toBeUndefined();
  });

  test('a malformed child id cannot be mistaken for a main session', () => {
    expect(
      normalizeSession(
        'claude',
        { hook_event_name: 'Stop', session_id: 's1', agent_id: {} },
        NOW,
      ),
    ).toBeUndefined();
  });

  test('accepts stops without text and keeps source-specific failure events separate', () => {
    expect(signal('Stop', { last_assistant_message: null }).kind).toBe('stop');
    expect(
      normalizeSession(
        'codex',
        { hook_event_name: 'StopFailure', session_id: 's1' },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      normalizeSession(
        'claude',
        {
          hook_event_name: 'StopFailure',
          session_id: 's1',
          error: 'SECRET=value',
        },
        NOW,
      )?.detail,
    ).toBe('');
  });

  test('drops outputs, errors, transcript paths, notification bodies, and credential-shaped values', () => {
    const input = signal('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'API_TOKEN=super-secret-value npm test' },
      tool_response: { output: 'private output' },
      tool_output: 'more private output',
      transcript_path: '/etc/shadow',
    });
    const encoded = JSON.stringify(input);
    expect(encoded).not.toMatch(/super-secret-value|private output|shadow/);
    expect(encoded).toContain('[redacted]');
    expect(
      normalizeSession(
        'claude',
        {
          hook_event_name: 'Notification',
          session_id: 's1',
          message: 'private notification',
        },
        NOW,
      ),
    ).toBeUndefined();
    const failed = normalizeSession(
      'claude',
      {
        hook_event_name: 'PostToolUseFailure',
        session_id: 's1',
        tool_name: 'Bash',
        error: 'private error',
        tool_response: 'private result',
      },
      NOW,
    );
    expect(failed?.detail).toBe('Bash: tool failed');
  });

  test('delegated prompts are agent instructions, while AskUserQuestion labels are the person answering', () => {
    expect(
      signal('UserPromptSubmit', {
        agent_id: 'child',
        prompt: 'Delegated instructions',
      }).voice,
    ).toBe('agent');
    const answer = normalizeSession(
      'claude',
      {
        hook_event_name: 'PostToolUse',
        session_id: 'main',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{ header: 'Strategy', question: 'Which approach?' }],
        },
        tool_response: {
          answers: { 'Which approach?': 'Incremental (Recommended)' },
          other: 'private result',
        },
      },
      NOW,
    );
    expect(answer?.voice).toBe('person');
    expect(answer?.detail).toBe('Strategy → Incremental');
  });
});

describe('NPC lifecycle reducer', () => {
  test('textless stop finishes a turn, and only SessionEnd ends its session', () => {
    const current = session();
    current.apply(signal('Stop', { turn_id: 'turn-1' }, NOW + 1000));
    expect(current.phase).toBe('finished');
    expect(current.visible).toBe(true);
    current.apply(signal('SessionEnd', {}, NOW + 2000));
    expect(current.phase).toBe('ended');
    expect(current.visible).toBe(false);
    expect(
      current.apply(
        signal(
          'PostToolUse',
          { tool_name: 'Bash', turn_id: 'turn-1' },
          NOW + 3000,
        ),
      ),
    ).toBe(false);
    current.apply(
      signal(
        'UserPromptSubmit',
        { prompt: 'Resume', turn_id: 'turn-2' },
        NOW + 4000,
      ),
    );
    expect(current.phase).toBe('working');
    expect(current.visible).toBe(true);
  });

  test('main completion cannot be caused by a child stop', () => {
    const current = session();
    current.apply(
      signal('Stop', {
        agent_id: 'child',
        last_assistant_message: 'Child finished',
      }),
    );
    expect(current.phase).toBe('working');
    expect(current.digest()).toContain('Delegated agent: Child finished');
    expect(current.digest()).not.toContain('main');
  });

  test('waits for each outstanding question or permission, not unrelated tool completion', () => {
    const current = session();
    current.apply(
      signal('PreToolUse', {
        tool_name: 'functions.request_user_input',
        tool_use_id: 'question',
      }),
    );
    current.apply(
      signal('PermissionRequest', {
        tool_name: 'Bash',
        tool_use_id: 'permission',
      }),
    );
    expect(current.phase).toBe('waiting-permission');
    current.apply(
      signal('PostToolUse', { tool_name: 'Read', tool_use_id: 'unrelated' }),
    );
    expect(current.phase).toBe('waiting-permission');
    current.apply(
      signal('PostToolUse', { tool_name: 'Bash', tool_use_id: 'permission' }),
    );
    expect(current.phase).toBe('waiting-input');
    current.apply(
      signal('PostToolUse', {
        tool_name: 'functions.request_user_input',
        tool_use_id: 'question',
      }),
    );
    expect(current.phase).toBe('working');
  });

  test('handles permission payloads without a tool id by actor and tool name', () => {
    const current = session();
    current.apply(
      signal('PermissionRequest', { tool_name: 'Bash', agent_id: 'child' }),
    );
    current.apply(
      signal('PostToolUse', { tool_name: 'Bash', tool_use_id: 'root-command' }),
    );
    expect(current.phase).toBe('waiting-permission');
    current.apply(
      signal('PostToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'child-command',
        agent_id: 'child',
      }),
    );
    expect(current.phase).toBe('working');
  });

  test('uses separate idle and working-silence timeouts', () => {
    const current = session();
    current.expire(NOW + 11 * 60_000, 10 * 60_000, 120 * 60_000);
    expect(current.visible).toBe(true);
    current.expire(NOW + 120 * 60_000, 10 * 60_000, 120 * 60_000);
    expect(current.visible).toBe(false);
    current.apply(
      signal('PostToolUse', { tool_name: 'Bash' }, NOW + 121 * 60_000),
    );
    expect(current.visible).toBe(true);
    current.apply(signal('Stop', {}, NOW + 122 * 60_000));
    current.expire(NOW + 132 * 60_000, 10 * 60_000, 120 * 60_000);
    expect(current.visible).toBe(false);
  });

  test('ignores old-turn completions and duplicate tool deliveries', () => {
    const current = session();
    current.apply(
      signal('UserPromptSubmit', {
        prompt: 'A different task',
        turn_id: 'turn-2',
      }),
    );
    expect(current.apply(signal('Stop', { turn_id: 'turn-1' }))).toBe(false);
    const event = signal('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      turn_id: 'turn-2',
    });
    expect(current.apply(event)).toBe(true);
    const sequence = current.sequence;
    expect(current.apply(event)).toBe(false);
    expect(current.sequence).toBe(sequence);
    expect(current.phase).toBe('working');
  });

  test('same-millisecond activity survives, while new prompts clear old task context', () => {
    const current = session();
    current.apply(
      signal('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'First operation' },
      }),
    );
    current.apply(
      signal('PostToolUse', {
        tool_name: 'Read',
        tool_input: { path: '/tmp/second' },
      }),
    );
    expect(current.sequence).toBe(3);
    expect(current.digest()).toContain('First operation');
    expect(current.digest()).toContain('second');
    current.task = 'Old task';
    current.apply(
      signal('UserPromptSubmit', {
        prompt: 'Replace the objective',
        turn_id: 'turn-2',
      }),
    );
    expect(current.task).toBe('');
    expect(current.digest()).not.toMatch(/First operation|invitations/);
  });

  test('compaction does not turn an active session into a new idle session', () => {
    const current = session();
    current.apply(signal('SessionStart', { source: 'compact' }));
    expect(current.phase).toBe('working');
    expect(current.digest()).toContain('Improve invitations');
  });
});
