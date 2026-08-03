import type { ActivityEvent } from '../src/activity/events.js';
import {
  PlanIndex,
  extractContext,
  extractTitle,
} from '../src/activity/plans.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PLAN = `# Teach the summarizer who did what

## Context

The status is meant to tell teammates what the person is working on. Instead it keeps
describing the state of the agent working for them.

## Verification

Run the tests.
`;

let directory: string;
let clock = Date.now();

function tool(project: string, detail: string, at = ++clock): ActivityEvent {
  return { at, source: 'claude', session: 's1', project, kind: 'tool', detail };
}

function index(
  overrides: {
    maxAgeHours?: number;
    contextChars?: number;
    directory?: string;
  } = {},
) {
  return new PlanIndex({
    directory: overrides.directory ?? directory,
    maxAgeHours: overrides.maxAgeHours ?? 12,
    contextChars: overrides.contextChars ?? 400,
  });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'plans-'));
  await fs.writeFile(path.join(directory, 'summarizer.md'), PLAN);
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('extraction', () => {
  test('pulls the title', () => {
    expect(extractTitle(PLAN)).toBe('Teach the summarizer who did what');
  });

  test('pulls the Context section, stopping at the next heading', () => {
    const context = extractContext(PLAN, 400);
    expect(context).toContain('tell teammates what the person is working on');
    expect(context).not.toContain('Run the tests');
    expect(context).not.toContain('##');
  });

  test('caps the context excerpt', () => {
    const context = extractContext(PLAN, 40);
    expect(context?.length).toBeLessThanOrEqual(40);
  });

  test('handles a plan with no title or no context', () => {
    expect(extractTitle('no heading here')).toBeUndefined();
    expect(extractContext('# Title only\n', 400)).toBeUndefined();
  });

  test('reads Context to the end when it is the final section', () => {
    // Regression: expressing "to the next heading or end of input" as a lookahead needs an
    // end-of-input anchor. JavaScript has no `\z` — writing one matches a literal "z", which
    // truncated any Context containing that letter. Every real plan happens to have a
    // section after Context, so only this shape catches it.
    const markdown =
      '# A plan\n\n## Context\n\nWe need to optimize the zoom and buzz logic.\n';
    const context = extractContext(markdown, 400);

    expect(context).toBe('We need to optimize the zoom and buzz logic.');
  });
});

describe('PlanIndex', () => {
  test('finds the plan a project was working on', async () => {
    const plans = await index().plansFor([
      tool('my-service', 'Edit: summarizer.md'),
    ]);

    expect(plans.get('my-service')).toEqual({
      title: 'Teach the summarizer who did what',
      context: expect.stringContaining('tell teammates') as unknown as string,
    });
  });

  test.each(['Write', 'Edit', 'NotebookEdit'])(
    'recognizes a %s of a plan file',
    async (verb) => {
      const plans = await index().plansFor([
        tool('my-service', `${verb}: summarizer.md`),
      ]);
      expect(plans.has('my-service')).toBe(true);
    },
  );

  test('ignores markdown that is not in the plans directory', async () => {
    const plans = await index().plansFor([
      tool('my-service', 'Edit: README.md'),
    ]);
    expect(plans.size).toBe(0);
  });

  test('ignores non-markdown edits', async () => {
    const plans = await index().plansFor([
      tool('my-service', 'Edit: summarizer.ts'),
    ]);
    expect(plans.size).toBe(0);
  });

  test('keeps concurrent projects apart', async () => {
    // The regression this feature exists to avoid: five sessions run in parallel, and one
    // project's plan must never be attached to another's work.
    await fs.writeFile(
      path.join(directory, 'other.md'),
      '# Something else entirely\n',
    );

    const plans = await index().plansFor([
      tool('my-service', 'Edit: summarizer.md'),
      tool('other-repo', 'Edit: other.md'),
    ]);

    expect(plans.get('my-service')?.title).toBe(
      'Teach the summarizer who did what',
    );
    expect(plans.get('other-repo')?.title).toBe('Something else entirely');
  });

  test('does not attach a plan to a project that never touched one', async () => {
    const plans = await index().plansFor([
      tool('my-service', 'Edit: summarizer.md'),
      tool('innocent-repo', 'Edit: index.ts'),
    ]);

    expect(plans.has('my-service')).toBe(true);
    expect(plans.has('innocent-repo')).toBe(false);
  });

  test('remembers the plan across intervals with no plan activity', async () => {
    const planIndex = index();
    await planIndex.plansFor([tool('my-service', 'Edit: summarizer.md')]);

    // A later interval of ordinary work — the plan should still anchor the status
    const plans = await planIndex.plansFor([
      tool('my-service', 'Edit: server.ts'),
    ]);
    expect(plans.get('my-service')?.title).toBe(
      'Teach the summarizer who did what',
    );
  });

  test('drops a plan once the file is deleted', async () => {
    const planIndex = index();
    await planIndex.plansFor([tool('my-service', 'Edit: summarizer.md')]);

    await fs.rm(path.join(directory, 'summarizer.md'));

    const plans = await planIndex.plansFor([
      tool('my-service', 'Edit: server.ts'),
    ]);
    expect(plans.size).toBe(0);
  });

  test('switches to a newer plan for the same project', async () => {
    await fs.writeFile(
      path.join(directory, 'newer.md'),
      '# The next piece of work\n',
    );
    const planIndex = index();

    await planIndex.plansFor([tool('my-service', 'Edit: summarizer.md')]);
    const plans = await planIndex.plansFor([
      tool('my-service', 'Write: newer.md'),
    ]);

    expect(plans.get('my-service')?.title).toBe('The next piece of work');
  });

  test('forgets a plan once it goes stale', async () => {
    const planIndex = index({ maxAgeHours: 1 });
    const twoHoursAgo = Date.now() - 2 * 3_600_000;

    await planIndex.plansFor([
      tool('my-service', 'Edit: summarizer.md', twoHoursAgo),
    ]);
    const plans = await planIndex.plansFor([
      tool('my-service', 'Edit: server.ts'),
    ]);

    expect(plans.size).toBe(0);
  });

  test('refuses a traversal filename', async () => {
    const plans = await index().plansFor([
      tool('my-service', 'Edit: ../../../../etc/passwd.md'),
      tool('my-service', 'Write: /etc/hosts.md'),
    ]);

    expect(plans.size).toBe(0);
  });
});

describe('failing safe', () => {
  test('an empty directory setting disables the feature', async () => {
    const planIndex = index({ directory: '' });

    expect(planIndex.enabled).toBe(false);
    await expect(
      planIndex.plansFor([tool('my-service', 'Edit: summarizer.md')]),
    ).resolves.toEqual(new Map());
  });

  test('a nonexistent directory yields no plans rather than throwing', async () => {
    const planIndex = index({
      directory: path.join(directory, 'does-not-exist'),
    });

    await expect(
      planIndex.plansFor([tool('my-service', 'Edit: summarizer.md')]),
    ).resolves.toEqual(new Map());
  });

  test('a plan with no title is skipped', async () => {
    await fs.writeFile(
      path.join(directory, 'untitled.md'),
      'just some prose, no heading\n',
    );

    const plans = await index().plansFor([
      tool('my-service', 'Edit: untitled.md'),
    ]);
    expect(plans.size).toBe(0);
  });
});
