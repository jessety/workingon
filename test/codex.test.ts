import {
  normalizeCodex,
  type CodexHookEvent,
} from '../src/inputs/codex/normalize.js';

const NOW = 1_700_000_000_000;

function normalize(event: Record<string, unknown>) {
  return normalizeCodex(event as unknown as CodexHookEvent, NOW);
}

describe('normalizeCodex', () => {
  test('records a user prompt, tagged with the codex source', () => {
    const result = normalize({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'c1',
      cwd: '/Users/jesse/repo',
      prompt: 'Refactor the queue consumer',
    });

    expect(result).toEqual({
      at: NOW,
      source: 'codex',
      session: 'c1',
      project: 'repo',
      kind: 'prompt',
      detail: 'Refactor the queue consumer',
    });
  });

  test('joins an argv-array shell command into a readable subject', () => {
    // Codex's shell tool sends command as an array, unlike Claude Code's Bash string
    const result = normalize({
      hook_event_name: 'PostToolUse',
      cwd: '/x/repo',
      tool_name: 'shell',
      tool_input: { command: ['npm', 'test', '--', '--watch'] },
    });

    expect(result?.kind).toBe('tool');
    expect(result?.detail).toBe('shell: npm test -- --watch');
  });

  test('reduces apply_patch paths to a basename', () => {
    const result = normalize({
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: { path: '/Users/jesse/repo/src/consumer.ts' },
    });

    expect(result?.detail).toBe('apply_patch: consumer.ts');
  });

  test('falls back to the tool name for unknown tools with no usable argument', () => {
    const result = normalize({
      hook_event_name: 'PostToolUse',
      tool_name: 'update_plan',
      tool_input: { plan: [{ step: 'x' }] },
    });

    expect(result?.detail).toBe('update_plan');
  });

  test('records the closing message on Stop, including the kebab-case field', () => {
    const snake = normalize({
      hook_event_name: 'Stop',
      last_assistant_message: 'Done.',
    });
    const kebab = normalize({
      hook_event_name: 'Stop',
      'last-assistant-message': 'Done.',
    });

    expect(snake?.kind).toBe('stop');
    expect(kebab?.kind).toBe('stop');
  });

  test('never records tool results', () => {
    const result = normalize({
      hook_event_name: 'PostToolUse',
      tool_name: 'shell',
      tool_input: { command: ['cat', '.env'] },
      tool_response: { output: 'SECRET_VALUE_HERE' },
    });

    expect(JSON.stringify(result)).not.toContain('SECRET_VALUE_HERE');
  });

  test('ignores events codex sends that we do not record', () => {
    expect(
      normalize({ hook_event_name: 'PreToolUse', tool_name: 'shell' }),
    ).toBeUndefined();
    expect(normalize({ hook_event_name: 'PermissionRequest' })).toBeUndefined();
  });

  test('redacts credential-shaped values in commands', () => {
    const result = normalize({
      hook_event_name: 'PostToolUse',
      tool_name: 'shell',
      tool_input: {
        command: ['env', 'OPENAI_API_KEY=sk-proj-abcdef123456789', 'run'],
      },
    });

    expect(result?.detail).not.toContain('abcdef123456789');
  });
});
