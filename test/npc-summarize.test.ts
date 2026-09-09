import type Anthropic from '@anthropic-ai/sdk';
import { extractNpcSummary } from '../src/npcs/summarize.js';

function response(body: unknown, stopReason = 'end_turn'): Anthropic.Message {
  return {
    content: [
      {
        type: 'text',
        text: typeof body === 'string' ? body : JSON.stringify(body),
      },
    ],
    stop_reason: stopReason,
  } as Anthropic.Message;
}

describe('NPC summary extraction', () => {
  test('allows a task with no speech', () => {
    expect(
      extractNpcSummary(response({ task: 'Calendar invitations', say: null })),
    ).toEqual({ task: 'Calendar invitations', say: null });
  });

  test('sanitizes and clamps generated output', () => {
    const result = extractNpcSummary(
      response({
        task: `API_TOKEN=super-secret-value ${'x'.repeat(300)}`,
        say: `  New\nunderstanding ${'y'.repeat(200)}`,
      }),
    );
    expect(result?.task.length).toBeLessThanOrEqual(160);
    expect(result?.task).not.toContain('super-secret-value');
    expect(result?.say?.length).toBeLessThanOrEqual(120);
    expect(result?.say).not.toContain('\n');
  });

  test.each([
    'not json',
    null,
    [],
    { task: '', say: null },
    { task: 'A task' },
    { task: 2, say: null },
    { task: 'A task', say: { text: 'Wrong shape' } },
  ])('drops unusable responses: %p', (body) => {
    expect(extractNpcSummary(response(body))).toBeUndefined();
  });

  test.each(['refusal', 'max_tokens'])('does not use %s output', (reason) => {
    expect(
      extractNpcSummary(response({ task: 'A task', say: null }, reason)),
    ).toBeUndefined();
  });
});
