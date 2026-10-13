import envSmart from 'env-smart';
import { validate, type Configuration } from '../src/config.js';
import { parseNpcCharacterConfig } from '../src/npcs/character.js';

function configuration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    port: 8220,
    host: '127.0.0.1',
    hookToken: '',
    anthropicApiKey: 'sk-ant-test',
    anthropicModel: 'claude-sonnet-5',
    soworkApiKey: '',
    soworkBaseUrl: '',
    slackApiToken: '',
    slackStatusEmoji: '',
    summaryIntervalMinutes: 10,
    summaryMaxLength: 100,
    idleClearMinutes: 30,
    maxEvents: 500,
    planDirectory: '',
    planMaxAgeHours: 12,
    planContextChars: 400,
    npcEnabled: false,
    npcAnimationsEnabled: true,
    npcNamePrefix: '',
    npcCharacterConfig: '',
    npcIdleMinutes: 10,
    npcStaleMinutes: 120,
    npcSummaryIntervalSeconds: 30,
    npcSpeechCooldownSeconds: 60,
    npcMaxSessions: 50,
    npcStateFile: '/tmp/workingon-test-npcs.json',
    dryRun: false,
    verbose: false,
    ...overrides,
  };
}

describe('validate', () => {
  test('accepts SoWork alone', () => {
    expect(validate(configuration({ soworkApiKey: 'sw_x' }))).toEqual([]);
  });

  test('accepts Slack alone', () => {
    expect(validate(configuration({ slackApiToken: 'xoxp-x' }))).toEqual([]);
  });

  test('accepts both destinations', () => {
    expect(
      validate(
        configuration({ soworkApiKey: 'sw_x', slackApiToken: 'xoxp-x' }),
      ),
    ).toEqual([]);
  });

  test('rejects a configuration with no destination at all', () => {
    const problems = validate(configuration());

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SOWORK_API_KEY and/or SLACK_API_TOKEN');
  });

  test('allows no destination in dry run', () => {
    expect(validate(configuration({ dryRun: true }))).toEqual([]);
  });

  test('still requires the Anthropic key', () => {
    const problems = validate(
      configuration({ soworkApiKey: 'sw_x', anthropicApiKey: '' }),
    );
    expect(
      problems.some((problem) => problem.includes('ANTHROPIC_API_KEY')),
    ).toBe(true);
  });

  test('NPC mode needs SoWork credentials even when Slack is configured', () => {
    expect(
      validate(configuration({ npcEnabled: true, slackApiToken: 'xoxp-x' })),
    ).toContain('NPC_ENABLED requires SOWORK_API_KEY (or DRY_RUN=TRUE)');
  });

  test('NPC dry run can operate without a SoWork key', () => {
    expect(validate(configuration({ npcEnabled: true, dryRun: true }))).toEqual(
      [],
    );
  });

  test.each(['', '   '])(
    'empty character override uses the API default: %p',
    (raw) => {
      expect(parseNpcCharacterConfig(raw)).toBeUndefined();
    },
  );

  test.each(['', "'", '"'])(
    'reads character JSON through env-smart with %p wrapping quotes',
    (quote) => {
      const character = {
        version: 5,
        bodyType: 'example-body',
        slots: { hair: 'example-hair', shirt: 'example-shirt' },
      };
      const parsed = envSmart.parse(
        `NPC_CHARACTER_CONFIG=${quote}${JSON.stringify(character)}${quote}`,
      );
      const raw = parsed.NPC_CHARACTER_CONFIG as string;
      expect(parseNpcCharacterConfig(raw)).toEqual(character);
      expect(
        validate(
          configuration({
            npcEnabled: true,
            dryRun: true,
            npcCharacterConfig: raw,
          }),
        ),
      ).toEqual([]);
    },
  );

  test.each([
    '{"secret":"do-not-log"',
    'null',
    '[]',
    'false',
    '{}',
    '{"version":4,"bodyType":"body","slots":{}}',
    '{"version":5,"bodyType":"","slots":{}}',
    '{"version":5,"bodyType":42,"slots":{}}',
    '{"version":5,"bodyType":"body","slots":[]}',
    '{"version":5,"bodyType":"body","slots":{"hair":42}}',
    '{"version":5,"bodyType":"body","slots":{"hair":null}}',
    '{"version":5,"bodyType":"body","slots":{},"secret":"do-not-log"}',
  ])(
    'rejects malformed character overrides without echoing input: %p',
    (raw) => {
      const problems = validate(
        configuration({
          npcEnabled: true,
          dryRun: true,
          npcCharacterConfig: raw,
        }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('NPC_CHARACTER_CONFIG');
      expect(problems[0]).not.toContain('do-not-log');
    },
  );

  test('an unused character override does not prevent personal statuses', () => {
    expect(
      validate(
        configuration({
          soworkApiKey: 'sw_x',
          npcCharacterConfig: 'invalid',
        }),
      ),
    ).toEqual([]);
  });

  test.each([NaN, Infinity, 0, -1])(
    'rejects invalid NPC timing: %p',
    (value) => {
      expect(
        validate(
          configuration({
            npcEnabled: true,
            dryRun: true,
            npcIdleMinutes: value,
          }),
        ).some((message) => message.startsWith('NPC_IDLE_MINUTES')),
      ).toBe(true);
    },
  );

  test('validates capacity, state path, and a stale timeout shorter than idle', () => {
    const problems = validate(
      configuration({
        npcEnabled: true,
        dryRun: true,
        npcMaxSessions: 1.5,
        npcStateFile: '',
        npcStaleMinutes: 1,
      }),
    );
    expect(problems).toHaveLength(3);
  });
});
