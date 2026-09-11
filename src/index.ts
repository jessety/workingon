import { PlanIndex } from './activity/plans.js';
import { ActivityStore } from './activity/store.js';
import { config, validate } from './config.js';
import { identity } from './inputs/session.js';
import { describeError, log, setVerbose } from './logger.js';
import { parseNpcCharacterConfig } from './npcs/character.js';
import { createNpcClient, DryRunNpcClient } from './npcs/client.js';
import { NpcCoordinator } from './npcs/coordinator.js';
import { FileNpcState, MemoryNpcState } from './npcs/state.js';
import { NpcSummarizer } from './npcs/summarize.js';
import { Broadcast } from './outputs/broadcast.js';
import { SlackStatus } from './outputs/slack.js';
import { PresenceUpdater } from './outputs/sowork.js';
import { Scheduler, type StatusPublisher } from './scheduler.js';
import { createServer } from './server.js';
import { Summarizer } from './summarize.js';

setVerbose(config.verbose);

const problems = validate(config);
if (problems.length > 0) {
  for (const problem of problems) {
    log.error(`Configuration: ${problem}`);
  }
  log.error(
    'Set the missing values in .env — see .env.defaults for the full list',
  );
  process.exit(1);
}

const store = new ActivityStore(config.maxEvents);

// Build one publisher per destination with credentials. In dry run a single
// logging publisher stands in for all of them.
const publishers: StatusPublisher[] = [];
const destinations: string[] = [];
const states: Record<string, () => unknown> = {};

if (config.dryRun) {
  const dryRun = new PresenceUpdater({ apiKey: '', baseUrl: '', dryRun: true });
  publishers.push(dryRun);
  states['dryRun'] = () => dryRun.state;
} else {
  if (config.soworkApiKey !== '') {
    const sowork = new PresenceUpdater({
      apiKey: config.soworkApiKey,
      baseUrl: config.soworkBaseUrl,
      dryRun: false,
    });
    // Learn what SoWork already shows, so a status set before a restart can still be
    // deduplicated against and cleared. Fire-and-forget: seed() handles its own errors.
    void sowork.seed();
    publishers.push(sowork);
    destinations.push('SoWork');
    states['sowork'] = () => sowork.state;
  }

  if (config.slackApiToken !== '') {
    const slack = new SlackStatus({
      token: config.slackApiToken,
      dryRun: false,
      emoji: config.slackStatusEmoji,
      // Dead-man's switch: Slack clears the status by itself if this service dies
      // before the next summary would have refreshed or cleared it.
      expirationSeconds:
        Math.max(config.summaryIntervalMinutes * 3, config.idleClearMinutes) *
        60,
    });
    publishers.push(slack);
    destinations.push('Slack');
    states['slack'] = () => slack.state;
  }
}

const presence = new Broadcast(publishers);

const summarizer = new Summarizer({
  apiKey: config.anthropicApiKey,
  model: config.anthropicModel,
  maxLength: config.summaryMaxLength,
});

const plans = new PlanIndex({
  directory: config.planDirectory,
  maxAgeHours: config.planMaxAgeHours,
  contextChars: config.planContextChars,
});

const scheduler = new Scheduler({
  store,
  summarizer,
  presence,
  plans,
  intervalMinutes: config.summaryIntervalMinutes,
  idleClearMinutes: config.idleClearMinutes,
});

const npcs = config.npcEnabled
  ? new NpcCoordinator({
      client: config.dryRun
        ? new DryRunNpcClient()
        : createNpcClient(config.soworkApiKey, config.soworkBaseUrl),
      repository: config.dryRun
        ? new MemoryNpcState()
        : new FileNpcState(config.npcStateFile),
      summarizer: new NpcSummarizer({
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
      }),
      account: identity(
        config.dryRun
          ? 'dry-run'
          : `${config.soworkBaseUrl || 'https://api.sowork.com/public'}\0${config.soworkApiKey}`,
      ),
      namePrefix: config.npcNamePrefix,
      characterConfig: parseNpcCharacterConfig(config.npcCharacterConfig),
      idleMinutes: config.npcIdleMinutes,
      staleMinutes: config.npcStaleMinutes,
      summaryIntervalSeconds: config.npcSummaryIntervalSeconds,
      speechCooldownSeconds: config.npcSpeechCooldownSeconds,
      maxSessions: config.npcMaxSessions,
    })
  : undefined;

const server = createServer({
  port: config.port,
  token: config.hookToken,
  store,
  sessions: npcs,
  describeStatus: () =>
    Object.fromEntries(
      Object.entries(states).map(([name, state]) => [name, state()]),
    ),
});

server.listen(config.port, config.host, () => {
  const publishingTo = config.dryRun
    ? 'nowhere — DRY_RUN is on, statuses will be logged only'
    : destinations.join(' + ');

  log.info(
    `workingon is starting — listening for Claude Code and Codex hooks on ` +
      `http://${config.host}:${config.port}, publishing your status to ${publishingTo}`,
  );

  if (config.hookToken === '') {
    log.warn(
      'HOOK_TOKEN is unset — any local process can post activity to this service',
    );
  }

  scheduler.start();
  npcs?.start();
});

server.on('error', (error) => {
  log.error('Server error', describeError(error));
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  log.info(`Received ${signal}, shutting down`);
  scheduler.stop();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  void Promise.allSettled([closed, npcs?.stop() ?? Promise.resolve()]).then(
    () => process.exit(0),
  );

  // Don't wait forever on lingering keep-alive connections
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
