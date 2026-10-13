import envSmart from 'env-smart';
import { parseNpcCharacterConfig } from './npcs/character.js';
import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~` to the home directory.
 *
 * env-smart does no shell expansion, so `~/.claude/plans` arrives literally.
 */
function expandHome(value: string): string {
  if (value === '' || value.startsWith('~') === false) {
    return value;
  }
  return path.join(os.homedir(), value.slice(1));
}

/**
 * Service configuration.
 *
 * Values come from `.env`, the process environment, and `.env.defaults`.
 * Types are applied from `.env.types` — see those files for the defaults.
 */
export interface Configuration {
  /** Port the hook receiver listens on */
  port: number;
  /**
   * Interface the server binds. Loopback by default — Claude Code only ever posts
   * from this machine, and `/hooks` is unauthenticated unless HOOK_TOKEN is set.
   * Docker sets 0.0.0.0 so port publishing works.
   */
  host: string;
  /** Shared secret hooks must present as `Authorization: Bearer <token>`. Empty disables auth. */
  hookToken: string;

  /** API key for the Anthropic API, used to summarize activity */
  anthropicApiKey: string;
  /** Model used to write the summary */
  anthropicModel: string;

  /**
   * API key for SoWork, used to update the user's text status.
   * Optional — but at least one of SOWORK_API_KEY / SLACK_API_TOKEN must be set.
   */
  soworkApiKey: string;
  /** Override the SoWork API endpoint. Empty uses the SDK default. */
  soworkBaseUrl: string;

  /**
   * Slack user token (`xoxp-…`) with the `users.profile:write` scope, used to set the
   * user's Slack status. Optional — see soworkApiKey.
   */
  slackApiToken: string;
  /** Emoji shown beside the Slack status, e.g. `:speech_balloon:`. Empty leaves it unset. */
  slackStatusEmoji: string;

  /** How often to summarize activity and push a status, in minutes */
  summaryIntervalMinutes: number;
  /** Hard ceiling on the status message length, in characters */
  summaryMaxLength: number;
  /** Clear the status after this many minutes with no activity. 0 never clears. */
  idleClearMinutes: number;

  /** Maximum activity events held in memory */
  maxEvents: number;

  /**
   * Directory holding Claude Code plan files. When a plan is found for a project it is used
   * to anchor the status. Empty disables the feature — summaries then work exactly as they
   * do without it.
   */
  planDirectory: string;
  /** Forget a plan this long after last seeing it worked on */
  planMaxAgeHours: number;
  /** Cap on how much of a plan's Context section is sent to the Anthropic API */
  planContextChars: number;

  /** Optional per-session NPC companions, independent of personal statuses. */
  npcEnabled: boolean;
  npcAnimationsEnabled: boolean;
  npcNamePrefix: string;
  /** Optional JSON matching the SoWork SDK's NpcCharacterConfiguration. */
  npcCharacterConfig: string;
  npcIdleMinutes: number;
  npcStaleMinutes: number;
  npcSummaryIntervalSeconds: number;
  npcSpeechCooldownSeconds: number;
  /** Shared physical pool and concurrent lease limit, independent of session history. */
  npcMaxSessions: number;
  /** One user-level ownership ledger shared by every checkout on this machine. */
  npcStateFile: string;

  /** Summarize and log, but never write a status anywhere */
  dryRun: boolean;
  /** Log every hook event as it arrives */
  verbose: boolean;
}

export const config = envSmart.config<Configuration>((env) => ({
  port: env.PORT as number,
  host: env.HOST as string,
  hookToken: env.HOOK_TOKEN as string,

  anthropicApiKey: env.ANTHROPIC_API_KEY as string,
  anthropicModel: env.ANTHROPIC_MODEL as string,

  soworkApiKey: env.SOWORK_API_KEY as string,
  soworkBaseUrl: env.SOWORK_BASE_URL as string,

  slackApiToken: env.SLACK_API_TOKEN as string,
  slackStatusEmoji: env.SLACK_STATUS_EMOJI as string,

  summaryIntervalMinutes: env.SUMMARY_INTERVAL_MINUTES as number,
  summaryMaxLength: env.SUMMARY_MAX_LENGTH as number,
  idleClearMinutes: env.IDLE_CLEAR_MINUTES as number,

  maxEvents: env.MAX_EVENTS as number,

  planDirectory: expandHome(env.PLAN_DIRECTORY as string),
  planMaxAgeHours: env.PLAN_MAX_AGE_HOURS as number,
  planContextChars: env.PLAN_CONTEXT_CHARS as number,

  npcEnabled: env.NPC_ENABLED as boolean,
  npcAnimationsEnabled: env.NPC_ANIMATIONS_ENABLED as boolean,
  npcNamePrefix: env.NPC_NAME_PREFIX as string,
  npcCharacterConfig: env.NPC_CHARACTER_CONFIG as string,
  npcIdleMinutes: env.NPC_IDLE_MINUTES as number,
  npcStaleMinutes: env.NPC_STALE_MINUTES as number,
  npcSummaryIntervalSeconds: env.NPC_SUMMARY_INTERVAL_SECONDS as number,
  npcSpeechCooldownSeconds: env.NPC_SPEECH_COOLDOWN_SECONDS as number,
  npcMaxSessions: env.NPC_MAX_SESSIONS as number,
  npcStateFile: expandHome(env.NPC_STATE_FILE as string),

  dryRun: env.DRY_RUN as boolean,
  verbose: env.VERBOSE as boolean,
}));

/**
 * Check for configuration that the service can't run without.
 * Returns a list of human-readable problems — empty means good to go.
 */
export function validate(configuration: Configuration): string[] {
  const problems: string[] = [];

  if (configuration.anthropicApiKey === '') {
    problems.push('ANTHROPIC_API_KEY is required to summarize activity');
  }

  if (
    configuration.soworkApiKey === '' &&
    configuration.slackApiToken === '' &&
    configuration.dryRun === false
  ) {
    problems.push(
      'Set SOWORK_API_KEY and/or SLACK_API_TOKEN — at least one status destination is required (or DRY_RUN=TRUE)',
    );
  }

  if (
    Number.isFinite(configuration.summaryIntervalMinutes) === false ||
    configuration.summaryIntervalMinutes <= 0
  ) {
    problems.push('SUMMARY_INTERVAL_MINUTES must be a positive number');
  }

  if (
    configuration.summaryMaxLength <= 0 ||
    configuration.summaryMaxLength > 256
  ) {
    // SoWork caps textStatus at 256 characters
    problems.push('SUMMARY_MAX_LENGTH must be between 1 and 256');
  }

  if (configuration.npcEnabled) {
    try {
      parseNpcCharacterConfig(configuration.npcCharacterConfig);
    } catch (error) {
      problems.push((error as Error).message);
    }
    if (!configuration.dryRun && configuration.soworkApiKey === '') {
      problems.push('NPC_ENABLED requires SOWORK_API_KEY (or DRY_RUN=TRUE)');
    }
    const positive = [
      ['NPC_IDLE_MINUTES', configuration.npcIdleMinutes],
      ['NPC_STALE_MINUTES', configuration.npcStaleMinutes],
      ['NPC_SUMMARY_INTERVAL_SECONDS', configuration.npcSummaryIntervalSeconds],
      ['NPC_SPEECH_COOLDOWN_SECONDS', configuration.npcSpeechCooldownSeconds],
    ] as const;
    for (const [name, value] of positive) {
      if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        problems.push(
          `${name} must be a positive finite number no greater than 1000000`,
        );
      }
    }
    if (configuration.npcStaleMinutes < configuration.npcIdleMinutes) {
      problems.push('NPC_STALE_MINUTES must be at least NPC_IDLE_MINUTES');
    }
    if (
      !Number.isSafeInteger(configuration.npcMaxSessions) ||
      configuration.npcMaxSessions < 1 ||
      configuration.npcMaxSessions > 1000
    ) {
      problems.push('NPC_MAX_SESSIONS must be an integer between 1 and 1000');
    }
    if (configuration.npcStateFile.trim() === '') {
      problems.push('NPC_STATE_FILE must be a non-empty path');
    }
  }

  return problems;
}
