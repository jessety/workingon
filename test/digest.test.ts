import {
  AGENT_HEADING,
  PERSON_HEADING,
  PLAN_HEADING,
  buildDigest,
} from '../src/activity/digest.js';
import type { ActivityEvent, ActivityKind } from '../src/activity/events.js';

let clock = 1_000;

function event(
  kind: ActivityKind,
  detail: string,
  project = 'repo',
): ActivityEvent {
  clock += 1;
  return { at: clock, source: 'claude', session: 's1', project, kind, detail };
}

describe('buildDigest', () => {
  test('returns empty for no events', () => {
    expect(buildDigest([])).toBe('');
  });

  test('returns empty when nothing but session lifecycle happened', () => {
    const digest = buildDigest([
      event('session-start', ''),
      event('session-end', 'logout'),
    ]);
    expect(digest).toBe('');
  });

  test('includes prompts, tool counts, and subjects', () => {
    const digest = buildDigest([
      event('prompt', 'Update the dependencies'),
      event('tool', 'Edit: package.json'),
      event('tool', 'Edit: tsconfig.json'),
      event('tool', 'Bash: npm test'),
    ]);

    expect(digest).toContain('## Project: repo');
    expect(digest).toContain('Update the dependencies');
    expect(digest).toContain('Edit x2');
    expect(digest).toContain('package.json');
    expect(digest).toContain('tsconfig.json');
  });

  test('deduplicates repeated subjects', () => {
    const digest = buildDigest([
      event('prompt', 'Keep editing'),
      event('tool', 'Edit: same.ts'),
      event('tool', 'Edit: same.ts'),
    ]);

    expect(digest.match(/same\.ts/g)).toHaveLength(1);
  });

  describe('agent state is never summarized', () => {
    test.each([
      'agent_needs_input',
      'permission_prompt',
      'idle_prompt',
      'auth_success',
    ])('a %s notification contributes nothing', (notificationType) => {
      const withNotification = buildDigest([
        event('prompt', 'Deploy it'),
        event('notification', notificationType),
      ]);
      const without = buildDigest([event('prompt', 'Deploy it')]);

      expect(withNotification).toBe(without);
      expect(withNotification).not.toContain(notificationType);
    });

    test('a notification on its own produces no digest at all', () => {
      expect(buildDigest([event('notification', 'agent_needs_input')])).toBe(
        '',
      );
    });

    test('never emits blocked or waiting language', () => {
      const digest = buildDigest([
        event('prompt', 'Deploy it'),
        event('notification', 'agent_needs_input'),
        event('notification', 'permission_prompt'),
        event('tool', 'Bash: npm run deploy'),
      ]);

      expect(digest).not.toMatch(/waiting|blocked|permission|awaiting/i);
    });
  });

  describe('plans are additive', () => {
    const events = [
      event('prompt', 'Migrate off Passport'),
      event('tool', 'Edit: auth.ts'),
      event('stop', 'Swapped the strategy'),
    ];
    const plan = {
      title: 'Replace the auth layer',
      context: 'Passport is unmaintained',
    };

    test('omitting plans is identical to passing none', () => {
      expect(buildDigest(events)).toBe(buildDigest(events, new Map()));
    });

    test('a plan for a different project changes nothing', () => {
      const elsewhere = new Map([['some-other-repo', plan]]);
      expect(buildDigest(events, elsewhere)).toBe(buildDigest(events));
    });

    test('no plan means no plan heading', () => {
      expect(buildDigest(events)).not.toContain(PLAN_HEADING);
    });

    test('a matching plan is added above the existing sections, which are unchanged', () => {
      const digest = buildDigest(events, new Map([['repo', plan]]));

      expect(digest).toContain(PLAN_HEADING);
      expect(digest).toContain('Objective: Replace the auth layer');
      expect(digest).toContain('Context: Passport is unmaintained');

      expect(digest.indexOf(PLAN_HEADING)).toBeLessThan(
        digest.indexOf(PERSON_HEADING),
      );
      expect(digest.indexOf(PERSON_HEADING)).toBeLessThan(
        digest.indexOf(AGENT_HEADING),
      );

      // Everything the digest said before is still said
      const without = buildDigest(events);
      for (const line of without.split('\n').filter((l) => l.trim() !== '')) {
        expect(digest).toContain(line);
      }
    });

    test('a plan without context renders just the objective', () => {
      const digest = buildDigest(
        events,
        new Map([['repo', { title: 'Only a title' }]]),
      );

      expect(digest).toContain('Objective: Only a title');
      expect(digest).not.toContain('Context:');
    });

    test('a plan alone is not enough to produce a digest', () => {
      expect(buildDigest([], new Map([['repo', plan]]))).toBe('');
      expect(
        buildDigest([event('session-start', '')], new Map([['repo', plan]])),
      ).toBe('');
    });
  });

  describe('provenance', () => {
    test("separates the person's words from the agent's activity", () => {
      const digest = buildDigest([
        event('prompt', 'Migrate off Passport'),
        event('tool', 'Edit: auth.ts'),
        event('stop', 'Swapped the strategy'),
      ]);

      expect(digest).toContain(PERSON_HEADING);
      expect(digest).toContain(AGENT_HEADING);

      // The prompt belongs to the person, everything else to the agent
      const personAt = digest.indexOf(PERSON_HEADING);
      const agentAt = digest.indexOf(AGENT_HEADING);
      expect(personAt).toBeLessThan(agentAt);
      expect(digest.indexOf('Migrate off Passport')).toBeGreaterThan(personAt);
      expect(digest.indexOf('Migrate off Passport')).toBeLessThan(agentAt);
      expect(digest.indexOf('auth.ts')).toBeGreaterThan(agentAt);
      expect(digest.indexOf('Swapped the strategy')).toBeGreaterThan(agentAt);
    });

    test('attributes a decision to the person, not the agent', () => {
      // The agent asked the question, but the answer is the person speaking
      const digest = buildDigest([
        event('tool', 'Edit: config.ts'),
        event(
          'decision',
          'Matching → bind by project; How much → title and context',
        ),
      ]);

      const decisionAt = digest.indexOf('Decided:');
      expect(decisionAt).toBeGreaterThan(digest.indexOf(PERSON_HEADING));
      expect(decisionAt).toBeLessThan(digest.indexOf(AGENT_HEADING));
    });

    test('a decision alone is enough to be worth summarizing', () => {
      const digest = buildDigest([
        event('decision', 'Scope → questions and answers'),
      ]);

      expect(digest).toContain(PERSON_HEADING);
      expect(digest).toContain('Decided: Scope → questions and answers');
    });

    test('attributes the closing report to the agent, not the person', () => {
      const digest = buildDigest([
        event('prompt', 'Run the tests'),
        event('stop', 'All 24 tests passed'),
      ]);

      expect(digest).toContain("Agent's closing report: All 24 tests passed");
    });

    test('omits the agent heading when only the person spoke', () => {
      const digest = buildDigest([event('prompt', 'Just thinking out loud')]);

      expect(digest).toContain(PERSON_HEADING);
      expect(digest).not.toContain(AGENT_HEADING);
    });

    test('omits the person heading when only the agent acted', () => {
      const digest = buildDigest([event('tool', 'Edit: a.ts')]);

      expect(digest).not.toContain(PERSON_HEADING);
      expect(digest).toContain(AGENT_HEADING);
    });
  });

  test('orders projects with the busiest first', () => {
    const digest = buildDigest([
      event('prompt', 'quiet work', 'quiet-project'),
      event('prompt', 'busy work', 'busy-project'),
      event('tool', 'Edit: a.ts', 'busy-project'),
      event('tool', 'Edit: b.ts', 'busy-project'),
    ]);

    expect(digest.indexOf('busy-project')).toBeLessThan(
      digest.indexOf('quiet-project'),
    );
  });

  test('includes the last assistant message', () => {
    const digest = buildDigest([
      event('prompt', 'Run the tests'),
      event('stop', 'All 24 tests passed'),
    ]);

    expect(digest).toContain('All 24 tests passed');
  });
});
