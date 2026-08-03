import {
  describeToolInput,
  normalize,
} from '../src/inputs/claude/normalize.js';
import type { HookEvent } from '../src/inputs/claude/types.js';

const NOW = 1_700_000_000_000;

describe('describeToolInput', () => {
  test('uses the command for Bash', () => {
    expect(describeToolInput('Bash', { command: 'npm test' })).toBe('npm test');
  });

  test('reduces file paths to a basename', () => {
    expect(
      describeToolInput('Edit', {
        file_path: '/Users/jesse/repo/src/index.ts',
      }),
    ).toBe('index.ts');
  });

  test('falls back to generic keys for unknown tools', () => {
    expect(
      describeToolInput('SomeNewTool', { description: 'do a thing' }),
    ).toBe('do a thing');
  });

  test('returns empty when nothing describes the call', () => {
    expect(describeToolInput('Mystery', { unrelated: 5 })).toBe('');
  });

  test('redacts secrets inside a command', () => {
    const result = describeToolInput('Bash', {
      command: 'ANTHROPIC_API_KEY=sk-hunter2 node x.js',
    });
    expect(result).not.toContain('hunter2');
  });
});

describe('normalize', () => {
  test('records a user prompt', () => {
    const event: HookEvent = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      cwd: '/Users/jesse/repo',
      prompt_text: 'Fix the failing tests',
    };

    expect(normalize(event, NOW)).toEqual({
      at: NOW,
      source: 'claude',
      session: 's1',
      project: 'repo',
      kind: 'prompt',
      detail: 'Fix the failing tests',
    });
  });

  test('skips an empty prompt', () => {
    expect(
      normalize(
        { hook_event_name: 'UserPromptSubmit', prompt_text: '   ' },
        NOW,
      ),
    ).toBeUndefined();
  });

  test.each(['prompt_text', 'prompt', 'user_prompt'])(
    'reads the prompt from the %s field',
    (field) => {
      const event = {
        hook_event_name: 'UserPromptSubmit',
        [field]: 'Ship it',
      } as HookEvent;
      expect(normalize(event, NOW)?.detail).toBe('Ship it');
    },
  );

  test('reads the assistant message from either Stop field name', () => {
    const documented = {
      hook_event_name: 'Stop',
      last_assistant_message: 'Done',
    } as HookEvent;
    const alias = {
      hook_event_name: 'Stop',
      assistant_message: 'Done',
    } as HookEvent;

    expect(normalize(documented, NOW)?.detail).toBe('Done');
    expect(normalize(alias, NOW)?.detail).toBe('Done');
  });

  test('records a tool call as name plus subject', () => {
    const event: HookEvent = {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: '/Users/jesse/repo',
      tool_name: 'Edit',
      tool_input: { file_path: '/Users/jesse/repo/package.json' },
    };

    expect(normalize(event, NOW)?.detail).toBe('Edit: package.json');
  });

  test('never records tool output', () => {
    const event = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/secrets.txt' },
      tool_output: { content: 'AKIAIOSFODNN7EXAMPLE super secret contents' },
    } as unknown as HookEvent;

    const result = normalize(event, NOW);
    expect(JSON.stringify(result)).not.toContain('super secret contents');
    expect(JSON.stringify(result)).not.toContain('AKIA');
  });

  test('records only the notification type, not the message body', () => {
    const event: HookEvent = {
      hook_event_name: 'Notification',
      notification_type: 'agent_needs_input',
      message: 'Bash tool requires permission to run rm -rf /important',
    };

    const result = normalize(event, NOW);
    expect(result?.detail).toBe('agent_needs_input');
    expect(JSON.stringify(result)).not.toContain('important');
  });

  test('records the final assistant message on Stop', () => {
    const event: HookEvent = {
      hook_event_name: 'Stop',
      last_assistant_message: 'Committed as 0d21b33 on a new branch',
    };

    expect(normalize(event, NOW)?.kind).toBe('stop');
  });

  test('tool output is still ignored for every other tool', () => {
    const event = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat secrets.env' },
      tool_output: { content: 'DATABASE_PASSWORD=hunter2 and other secrets' },
    } as unknown as HookEvent;

    const result = normalize(event, NOW);
    expect(result?.kind).toBe('tool');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('other secrets');
  });

  test('ignores events we do not subscribe to', () => {
    expect(
      normalize({ hook_event_name: 'PreToolUse' } as unknown as HookEvent, NOW),
    ).toBeUndefined();
  });

  test('falls back to unknown when cwd and session are absent', () => {
    const result = normalize({ hook_event_name: 'SessionStart' }, NOW);
    expect(result?.project).toBe('unknown');
    expect(result?.session).toBe('unknown');
  });
});
