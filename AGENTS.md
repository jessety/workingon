# AGENTS.md

This file provides guidance to AI Agents working with code in this repository.

## Commands

```bash
npm run build          # clean + tsc
npm test               # jest (coverage is on by default)
npm run lint           # eslint + editorconfig-checker — both must pass
npm run format         # sort-package-json + prettier + eslint --fix

npx jest test/plans.test.ts            # one file
npx jest -t "keeps concurrent projects apart"   # one test by name
npx tsc --noEmit                       # typecheck without emitting

npm run start:watch    # nodemon: rebuild + restart on change
npm run start:pm2      # how it actually runs day to day
```

Running it needs `.env` with `ANTHROPIC_API_KEY` plus at least one of `SOWORK_API_KEY` / `SLACK_API_TOKEN`. Set `DRY_RUN=TRUE` to summarize and log without writing anywhere, and `VERBOSE=TRUE` to log every hook as it arrives. Under pm2, logs split across `~/.pm2/logs/workingon-{out,error}.log` — **`log.warn` and `log.error` go to the error file**, which is easy to miss when debugging.

## Architecture

Coding agents POST hook events to a local HTTP server. Each input normalizes its events into one neutral shape (`ActivityEvent`), held in a fixed-size in-memory ring buffer; every N minutes an interval turns the window into a text digest, sends it to the Anthropic API for a one-line summary, and broadcasts that to every configured output.

```
POST /hooks[/claude|/codex] → input normalize() → ActivityStore    (hot path, must be fast)
                                                        ↓
Scheduler (interval) → PlanIndex → buildDigest() → Summarizer → Broadcast → SoWork / Slack
```

`src/index.ts` wires these together. `Scheduler` depends on the narrow interfaces `StatusSummarizer` / `StatusPublisher` / `PlanResolver` rather than concrete classes, so tests inject fakes — follow that pattern when adding collaborators.

**Inputs** live in `src/inputs/<agent>/` and register routes in `src/inputs/index.ts`; everything downstream sees only `ActivityEvent`s. Codex was verified to use Claude Code's wire contract by grepping the codex binary for the field names — do the same before trusting a new agent's docs. **Outputs** implement `StatusPublisher` (`set`/`clear`, errors caught internally) and fan out through `Broadcast`, which isolates failures — one destination down never blocks another. Each output clamps to its own platform limit (SoWork 256, Slack 100), and the Slack output sets `status_expiration` as a dead-man's switch instead of startup seeding.

### The provenance split is the central idea

`buildDigest()` renders each project under separate headings: **the person's own words** (their prompts, and the choices they make via `AskUserQuestion`) versus **their agent's activity** (tools, files, the closing message). The summarizer prompt leans on this heavily.

This is not cosmetic. Without it the model blends the two and describes the _agent's_ state — producing statuses like `blocked, waiting on input about the transcriber design`, when the person is still working on the thing while their agent waits. If you add a new activity kind, decide which side it belongs to and render it there.

For the same reason `Notification` events are recorded and buffered but **never reach the digest** — their entire content is agent state.

### Altitude

The status is for coworkers who are curious, not reviewing. The prompt bans filenames, tool names, counts, and command text from the output — those exist in the digest as raw material for inference, not as vocabulary. When editing `SYSTEM_PROMPT`, verify with real API calls (`DRY_RUN=TRUE`) on scenarios _unlike_ the prompt's examples; the model will otherwise parrot them and look better than it is.

### Nothing is load-bearing except prompts and tools

Every enrichment degrades to the previous behavior rather than failing:

- No new events since the last summary → no API call, status untouched.
- No plan matched → `buildDigest(events)` is byte-identical to `buildDigest(events, plans)`. There are tests asserting exactly this.
- Anthropic error, refusal, or unparseable reply → `undefined`, and the **previous status is left in place** rather than replaced with something wrong.
- The scheduler's watermark advances even when a summary fails, so a bad interval isn't retried forever.

## Things that will bite you

**Hook payload field names in the docs are wrong.** Confirmed twice: the published reference says `prompt_text` (this build sends `prompt`) and `tool_output` (it sends `tool_response`). `normalize.ts` therefore reads through alias lists (`FIELDS`) rather than single names. Before trusting any new field, subscribe to the hook, trigger it, and read the shape — `describeShape()` logs structure without logging values, and the `warn` on a subscribed-but-unreadable event exists for exactly this.

**Tool results are dropped at ingest, with one exception.** `PostToolUse` results are where file contents, command output, and secrets live. The sole exception is `AskUserQuestion`, whose result is the person's own answer; only the chosen option labels are kept. Do not widen this without a deliberate decision — the README documents it as a privacy guarantee.

**`POST /hooks` blocks Claude Code.** Parse, buffer, respond. Do not add I/O to that path. Plan files are read at summary time for this reason (and because a plan is rewritten repeatedly while being drafted).

**Never fail a hook.** Unrecognized or unusable events return `200 {"recorded": false}`, so a Claude Code upgrade that adds events can't break the user's session.

**Never take a path from a hook payload and read it.** `/hooks` is unauthenticated unless `HOOK_TOKEN` is set. `PlanIndex` matches filenames against a directory listing it produces itself, then confines reads to that directory after `realpath` — a forged event naming `/etc/passwd` matches nothing.

**Several sessions run concurrently across different repos.** Five were observed in practice. Anything associated with "the current work" must be keyed on the event's `project` (basename of `cwd`); global heuristics like "most recently modified plan file" attach one project's context to another's status.

**`clean()` is the chokepoint** for anything user-derived: it collapses whitespace, redacts credential-shaped values, and truncates. Route new text through it rather than storing raw.

**Status length is clamped in code.** JSON Schema `maxLength` is unsupported by structured outputs, so the model's limit is only a prompt instruction; `clamp()` enforces it.

## Conventions

ESM with TypeScript `NodeNext`, so **relative imports need a `.js` extension** even in `.ts` source (`import { normalize } from './hooks/normalize.js'`). `strict` and `noUncheckedIndexedAccess` are on — indexed access yields `T | undefined`.

Tests use `ts-jest` in CJS mode with a `moduleNameMapper` stripping `.js`, so no ESM flags are needed.

The runtime dependencies are deliberately few — `@anthropic-ai/sdk`, `sowork`, `env-smart`. The last two are CommonJS and interop through Node's named-export detection.

Config is typed via `env-smart` in `src/config.ts`, with defaults in `.env.defaults` and types in `.env.types` (both committed; `.env` is not). Adding a setting means touching all three.
