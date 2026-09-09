# workingon

Turns what you do in Claude Code or OpenAI Codex into your SoWork and Slack status.

[![ci](https://github.com/jessety/workingon/workflows/ci/badge.svg)](https://github.com/jessety/workingon/actions/workflows/ci.yml)

Your coding agent posts hook events to this service as you work. It keeps a rolling window of that activity in memory, and every ten minutes asks the Anthropic API to boil it down to a single line under 100 characters, then writes that line to your status — SoWork, Slack, or both — so your teammates see "Migrating the auth service off Passport" instead of a stale status from Tuesday.

```
Claude Code ──┐                                                    ┌──▶ SoWork
              ├─hooks──▶ this service ──every 10m──▶ Anthropic API ┤
OpenAI Codex ─┘           (in-memory)                 (summarize)  └──▶ Slack
```

Requires Node 22 or later.

Optional **NPC companions** give every observed main Claude Code or Codex session its own SoWork character, alongside your existing personal status. They follow you, show current activity, speak at key moments, and hide between sessions. Start with the [NPC setup guide](docs/npcs.md). The feature defaults to off (`NPC_ENABLED=FALSE`).

## Setup

```bash
git clone git@github.com:jessety/workingon.git
cd workingon
npm install
cp .env.example .env    # then fill it in
npm run build && npm start
```

You need an Anthropic key, plus **at least one** status destination:

| Variable            | Required  | Where it comes from                                                  |
| ------------------- | --------- | -------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Yes       | [Anthropic Console](https://console.anthropic.com/settings/keys)     |
| `SOWORK_API_KEY`    | One of    | Your SoWork settings                                                 |
| `SLACK_API_TOKEN`   | these two | A Slack user token — see [Publishing to Slack](#publishing-to-slack) |

On startup the service logs which destinations it found credentials for and will publish to.

Also set `HOOK_TOKEN` to any long random string. Claude Code sends it as a bearer token, and without it any process on your machine can post activity to the service.

Check it's alive:

```bash
curl localhost:8220/health
# {"ok":true}
```

To see what it would post without touching your SoWork or Slack status, set `DRY_RUN=TRUE` and `VERBOSE=TRUE` — summaries are logged instead of published.

## Installing the hooks into Claude Code

> This is a manual step. Nothing in this repo edits your Claude Code configuration for you.

Hooks live in `settings.json`. Since your status follows you across projects, put these in your user-level file at **`~/.claude/settings.json`** rather than a per-project one.

If the file already exists, merge the `hooks` key into it rather than replacing the file. Every entry below uses Claude Code's `http` hook type, which POSTs the event JSON straight to this service — no wrapper script needed.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8220/hooks",
            "headers": { "Authorization": "Bearer $WORKINGON_HOOK_TOKEN" },
            "allowedEnvVars": ["WORKINGON_HOOK_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8220/hooks",
            "headers": { "Authorization": "Bearer $WORKINGON_HOOK_TOKEN" },
            "allowedEnvVars": ["WORKINGON_HOOK_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8220/hooks",
            "headers": { "Authorization": "Bearer $WORKINGON_HOOK_TOKEN" },
            "allowedEnvVars": ["WORKINGON_HOOK_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8220/hooks",
            "headers": { "Authorization": "Bearer $WORKINGON_HOOK_TOKEN" },
            "allowedEnvVars": ["WORKINGON_HOOK_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:8220/hooks",
            "headers": { "Authorization": "Bearer $WORKINGON_HOOK_TOKEN" },
            "allowedEnvVars": ["WORKINGON_HOOK_TOKEN"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Then export the token so Claude Code can interpolate it — `allowedEnvVars` only permits the substitution, it doesn't supply the value. Put this in your shell profile so it's set for every session:

```bash
export WORKINGON_HOOK_TOKEN='the same value as HOOK_TOKEN in .env'
```

Start a new Claude Code session so the hooks are picked up, send a prompt, then confirm the events landed:

```bash
curl -H "Authorization: Bearer $WORKINGON_HOOK_TOKEN" localhost:8220/status
# {"ok":true,"buffered":7,"dropped":0,"lastActivityAt":"...","status":{...}}
```

If `buffered` stays at `0`, the hooks aren't firing — see [Troubleshooting](#troubleshooting).

### Optionally, SessionStart

`SessionStart` doesn't support the `http` hook type, so it needs a `command` hook that pipes stdin through `curl`. It's the one event that tells the service which project a session belongs to before the first prompt — useful, but not required, since every other event carries `cwd` too.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "curl -sS -m 5 -X POST localhost:8220/hooks -H \"Content-Type: application/json\" -H \"Authorization: Bearer $WORKINGON_HOOK_TOKEN\" --data-binary @- >/dev/null || true",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The trailing `|| true` keeps a failed post from surfacing as a hook error when the service isn't running.

### Optionally, OpenAI Codex

Codex adopted the same hook contract — the same event names and payload fields. It only supports `command` hooks (no `http` type), so each event shells out to `curl`, exactly like the `SessionStart` workaround above, posting to this service's `/hooks/codex` route:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -sS -m 5 -X POST http://127.0.0.1:8220/hooks/codex -H \"Content-Type: application/json\" -H \"Authorization: Bearer $WORKINGON_HOOK_TOKEN\" --data-binary @- >/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

Repeat the same handler for `PostToolUse`, `Stop`, and `SessionEnd` in `~/.codex/hooks.json`. Two caveats: Codex's hooks are newer than Claude Code's and the configuration schema may shift between versions — check `codex`'s own docs against your installed version — and, as with Claude Code, the published field names haven't always matched what a build actually sends. This service reads through alias lists and logs a warning naming the fields present (never their values) when a subscribed event can't be read, so run with `VERBOSE=TRUE` for the first session to confirm events land.

## Publishing to Slack

Slack statuses are set with a **user token**, not a bot token — a bot can't set your personal status. One-time setup:

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) (from scratch, any name, your workspace)
2. **OAuth & Permissions** → **User Token Scopes** → add `users.profile:write`
3. **Install to Workspace**, then copy the **User OAuth Token** (`xoxp-…`) into `SLACK_API_TOKEN`

Slack's status field caps at 100 characters, so statuses are clamped to that independently of `SUMMARY_MAX_LENGTH`. Every write also sets `status_expiration` a few summary intervals out — a dead-man's switch: if this service dies, Slack clears the stale status by itself.

## Which hooks, and why

Claude Code exposes around thirty hook events. This service subscribes to six, chosen because together they answer "what is this person working on right now?" without drowning the summarizer in noise.

| Event              | What it contributes                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| `UserPromptSubmit` | **The highest-signal event.** Your own words about what you're trying to do |
| `PostToolUse`      | What actually happened — files edited, commands run, searches made          |
| `Stop`             | Claude's closing summary of a turn, i.e. how the work turned out            |
| `SessionEnd`       | Marks a session finishing so a stale status doesn't linger                  |
| `SessionStart`     | _(optional)_ Project and session title at the start of a session            |
| `Notification`     | Recorded and visible in `/status`, but deliberately **never summarized**    |

The events deliberately **not** subscribed to are just as important:

- **`PreToolUse`** would double every tool event for no extra information.
- **`PostToolUseFailure`**, **`PermissionRequest`**, **`PreCompact`** and friends describe the mechanics of a session, not the work.
- **`MessageDisplay`** fires while text streams, which would be enormous volume for content already captured by `Stop`.

### Whose state gets described

The summary is built from two kinds of input, and the digest keeps them under separate headings: **your own words** — your prompts, plus the choices you make when Claude asks you to decide something — and **what your agent did on your behalf** (everything else). The distinction is load-bearing. Without it the model blends the two and starts describing the agent instead of you — producing statuses like `blocked, waiting on input about the transcriber agent's design direction`, when what a teammate needs to read is `working through the transcriber agent's design direction`.

For the same reason `Notification` is recorded but never summarized. Its whole content is agent state — blocked, needs permission, idle — which says nothing about what you're working on. **You are still working on the thing while your agent waits on you.**

## Plans

Activity from the last few minutes describes motion. A plan file describes the _objective_, and stays true for hours — `# Teach the summarizer who did what` says more than any amount of tool churn.

So when a project is working from a plan, its title and a short excerpt of its `## Context` section are added to the digest, above your prompts and your agent's activity, and the summary is anchored to that objective.

This is **purely additive**. Most intervals have no plan, and when there isn't one the summary is built from activity alone exactly as it would be otherwise. A missing directory, a deleted plan, an unreadable file, or `PLAN_DIRECTORY=` all quietly fall back to that path — a plan is never required for a status.

Two details worth knowing:

- **Plans are matched per project.** Plan files live in one global directory, but this service runs against every repo you use at once — five concurrently, in testing. Matching purely on "most recently modified" attaches another project's plan to your work, which is not a rare edge case but the normal one. Instead, a plan is bound to the project whose session was seen editing it, and remembered for `PLAN_MAX_AGE_HOURS` so it keeps anchoring the status while you implement it.
- **Plan files are read at summary time, never from a hook.** Nothing here trusts a path out of a hook payload: candidate filenames are matched against a directory listing the service produces itself, and reads are confined to that directory after symlink resolution. A forged hook naming `/etc/passwd` matches nothing. This matters because `/hooks` is unauthenticated unless you set `HOOK_TOKEN`.

## What leaves your machine

Summarizing means sending activity to the Anthropic API, so it's worth being precise about what that includes.

**Sent to the Anthropic API**, every ten minutes, when there's been activity:

- Your prompt text, truncated to 300 characters per prompt
- Tool names, plus one identifying argument each — a file's basename, a shell command, a search pattern
- Claude's final message from each turn, truncated to 300 characters
- The directory name (not the full path) of the project you're in
- **When a plan is active** (see below): its title, plus roughly the first 400 characters of its `## Context` section. This is the largest single thing sent, and it's design-document prose — set `PLAN_DIRECTORY=` to switch it off.

- **Decisions you make.** When Claude asks you to choose between options, the short topic label of each question and the option you picked — e.g. `Matching → bind by project`. This is the one place tool _output_ is read, and see the caveat below.

**Never recorded, and so never sent:**

- **Tool output**, with exactly one exception. File contents, command results, and search hits are dropped at the point of ingest — see the input normalizers in `src/inputs/`. The exception is `AskUserQuestion`, whose output is your own answer rather than machine output; only the chosen option labels are kept, and only for that one tool. Every other tool's output is discarded before anything is stored.
- Notification message bodies, which can quote arbitrary tool input. Only the notification _type_ is kept.
- Full filesystem paths, transcript paths, and session IDs beyond in-memory grouping.

Values that look like credentials — `sk-…`, `ghp_…`, `SOMETHING_TOKEN=…` — are redacted before anything is stored. That's a safety net for the obvious cases, not a guarantee; treat it as defense in depth rather than a reason to relax about what you paste into a prompt.

Finally, the one-line summary itself goes to whichever of SoWork and Slack you configured, where your teammates can read it. Activity lives in a fixed-size in-memory buffer and is gone when the process restarts. Optional NPC mode also sends session-specific descriptions and speech to SoWork, and writes a small ownership ledger containing hashed session keys, NPC IDs, allocation counters, timestamps, and recovery markers. Prompt text, project names, and generated prose are not persisted in that ledger. See [NPC storage and recovery](docs/npcs.md#storage-and-recovery).

## Configuration

Set these in `.env`. Defaults live in `.env.defaults`, and types in `.env.types`.

| Variable                   | Default            | Purpose                                                       |
| -------------------------- | ------------------ | ------------------------------------------------------------- |
| `PORT`                     | `8220`             | Port the hook receiver listens on                             |
| `HOST`                     | `127.0.0.1`        | Interface to bind. Loopback by default; Docker uses `0.0.0.0` |
| `HOOK_TOKEN`               | _(empty)_          | Bearer token hooks must present. Empty disables auth          |
| `ANTHROPIC_API_KEY`        | —                  | **Required.** Used to write the summary                       |
| `ANTHROPIC_MODEL`          | `claude-sonnet-5`  | Model that writes the summary                                 |
| `SOWORK_API_KEY`           | _(empty)_          | SoWork key. One of this / `SLACK_API_TOKEN` is required       |
| `SOWORK_BASE_URL`          | _(empty)_          | Override the SoWork endpoint. Empty uses the SDK default      |
| `SLACK_API_TOKEN`          | _(empty)_          | Slack user token (`xoxp-…`) with `users.profile:write`        |
| `SLACK_STATUS_EMOJI`       | `:speech_balloon:` | Emoji beside the Slack status. Empty leaves it unset          |
| `SUMMARY_INTERVAL_MINUTES` | `10`               | How often to summarize and publish                            |
| `SUMMARY_MAX_LENGTH`       | `100`              | Hard ceiling on status length. SoWork's own limit is 256      |
| `IDLE_CLEAR_MINUTES`       | `30`               | Clear the status after this long with no activity. `0` never  |
| `MAX_EVENTS`               | `500`              | Events held in memory before the oldest are evicted           |
| `PLAN_DIRECTORY`           | `~/.claude/plans`  | Where to look for plan files. **Empty disables plans**        |
| `PLAN_MAX_AGE_HOURS`       | `12`               | Forget a plan this long after last seeing it worked on        |
| `PLAN_CONTEXT_CHARS`       | `400`              | Cap on the plan Context excerpt sent to the API               |
| `DRY_RUN`                  | `FALSE`            | Summarize and log, but never publish a status anywhere        |
| `VERBOSE`                  | `FALSE`            | Log every hook event as it arrives                            |

A quiet interval costs nothing: if no events arrived, no API call is made.

NPC mode has its own [configuration and cadence](docs/npcs.md#configuration), independent of personal summaries. It also polls your SoWork presence every 30 seconds while enabled, even without new agent activity; quiet sessions do not incur NPC summary calls.

## Endpoints

| Route         | Auth | Purpose                                         |
| ------------- | ---- | ----------------------------------------------- |
| `POST /hooks` | Yes  | Where Claude Code posts events                  |
| `GET /health` | No   | Liveness check                                  |
| `GET /status` | Yes  | Buffered event count and the last status pushed |

`POST /hooks` records the event and returns immediately — Claude Code blocks on the response, so nothing slow happens on that path. Unrecognized events return `200 {"recorded": false}` rather than an error, so a Claude Code upgrade that adds new events can never break your session.

With NPC mode enabled, a lifecycle-only event can return `recorded:true` without increasing the personal activity buffer. `/status` gains an additive `npcs` section for companion state, errors, and queue diagnostics. The existing personal `status` object is unchanged.

## Running it for real

The service has to be running whenever you're using Claude Code. With PM2:

```bash
npm run build
npm run start:pm2
npx pm2 save      # so it comes back after a reboot
```

Or in Docker, which needs the port published and your `.env` passed in:

```bash
npm run docker:build
npm run docker:start
```

## Troubleshooting

**`buffered` stays at 0.** The hooks aren't reaching the service. Check `~/.claude/settings.json` is valid JSON, that `$WORKINGON_HOOK_TOKEN` is exported in the shell you launched Claude Code from, and that you started a new session after editing settings. Run the service with `VERBOSE=TRUE` to log each delivery as it arrives.

**Events arrive but the status never changes.** Summaries only run on the interval, so wait for one to elapse. Confirm `ANTHROPIC_API_KEY` is set and check the logs — an API error or a refusal is logged and the cycle is skipped, deliberately leaving the previous status alone rather than publishing something wrong.

**401s in the Claude Code logs.** `HOOK_TOKEN` and `WORKINGON_HOOK_TOKEN` don't match.

**Everything works but the status is vague.** The summary is only as good as the digest. Short prompts like "fix it" give the model little to work with; the tool activity usually carries the rest.

## Development

```bash
npm run start:watch   # rebuild and restart on change
npm test              # jest
npm run lint          # eslint + editorconfig-checker
npm run format        # prettier + eslint --fix + sort-package-json
```

The project compiles to native ES modules with TypeScript's `NodeNext` resolution, so **relative imports need a file extension**, and that extension is `.js` even in TypeScript source:

```ts
import { normalize } from './hooks/normalize.js';
```

## Release

Determine what kind of [semantic versioning](https://semver.org) bump the release needs, make sure your git repository is clean, then run one of:

- `npm run release:major` (new functionality with breaking changes)
- `npm run release:minor` (new functionality without breaking changes)
- `npm run release:patch` (backwards compatible bug fixes)

Each one increments the version in `package.json`, creates a git tag, and pushes it. The `release` workflow then waits for build, tests, and lint to pass and cuts a GitHub release with notes generated by GitHub itself — the merged PRs since the last release, new contributors, and a full-changelog link.
