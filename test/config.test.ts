import { validate, type Configuration } from '../src/config.js';

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
});
