import { normalize } from '../src/inputs/claude/normalize.js';
import type { HookEvent } from '../src/inputs/claude/types.js';

const NOW = 1_700_000_000_000;

describe('AskUserQuestion', () => {
  // Shapes taken verbatim from a real Claude Code transcript
  const input = {
    questions: [
      {
        question:
          'The `Notification` hook exists only to detect "agent is blocked". What now?',
        header: 'Notification',
        multiSelect: false,
        options: [{ label: 'Unsubscribe entirely (Recommended)' }],
      },
      {
        question:
          "Claude's closing message is the agent's own voice. How to treat it?",
        header: 'Agent report',
        multiSelect: false,
        options: [{ label: 'Keep, labeled as agent evidence (Recommended)' }],
      },
    ],
  };
  // The real shape Claude Code sends: `answers` keyed by each question's full text
  const response = {
    questions: input.questions,
    answers: {
      [input.questions[0].question]: 'Keep recording, exclude from summary',
      [input.questions[1].question]:
        'Keep, labeled as agent evidence (Recommended)',
    },
    annotations: {},
  };

  // A looser prose shape, kept working as a fallback in case the format changes
  const prose =
    'Your questions have been answered: "The `Notification` hook exists only to detect "agent is blocked". What now?"="Keep recording, exclude from summary", ' +
    '"Claude\'s closing message is the agent\'s own voice. How to treat it?"="Keep, labeled as agent evidence (Recommended)". You can now continue.';

  function decision(toolResponse: unknown, toolInput: unknown = input) {
    return normalize(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: toolInput,
        tool_response: toolResponse,
      } as unknown as HookEvent,
      NOW,
    );
  }

  test('pairs each topic with the answer chosen', () => {
    const result = decision(response);

    expect(result?.kind).toBe('decision');
    expect(result?.detail).toBe(
      'Notification → Keep recording, exclude from summary; Agent report → Keep, labeled as agent evidence',
    );
  });

  test('strips the (Recommended) marker', () => {
    expect(decision(response)?.detail).not.toMatch(/recommended/i);
  });

  test('falls back to parsing a prose result', () => {
    // Guards against the structured shape changing in a future release
    expect(decision(prose)?.detail).toContain('Notification → Keep recording');
    expect(decision({ content: prose })?.detail).toContain('Keep recording');
  });

  test('still reads the legacy tool_output field name', () => {
    const legacy = normalize(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: input,
        tool_output: response,
      } as unknown as HookEvent,
      NOW,
    );
    expect(legacy?.detail).toContain('Keep recording');
  });

  test('falls back to topics alone when the output cannot be parsed', () => {
    // The output format is prose and a Claude Code release could reword it
    const result = decision('the format changed entirely');

    expect(result?.kind).toBe('decision');
    expect(result?.detail).toBe('Notification; Agent report');
  });

  test('survives missing output', () => {
    expect(decision(undefined)?.detail).toBe('Notification; Agent report');
  });

  test('does not leak the question text, only the topic', () => {
    expect(decision(response)?.detail).not.toContain('agent is blocked');
  });

  test('is skipped when there are no questions', () => {
    expect(decision(response, { questions: [] })).toBeUndefined();
    expect(decision(response, {})).toBeUndefined();
  });

  test('redacts anything credential-shaped in an answer', () => {
    const leaky = {
      answers: { 'Which key?': 'use sk-ant-abcdefgh12345678 for now' },
    };
    expect(
      decision(leaky, {
        questions: [{ header: 'Key', question: 'Which key?' }],
      })?.detail,
    ).not.toContain('abcdefgh12345678');
  });
});
