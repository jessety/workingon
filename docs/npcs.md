# NPC companions

Optional companions give each observed main Claude Code or Codex session its own character in SoWork. Personal SoWork and Slack statuses continue on their existing schedule.

Companions default to off. Enable them with `NPC_ENABLED=TRUE`.

## Setup

1. Install the updated dependencies with `npm ci`. The lockfile selects `sowork` 0.7.0, which exposes the NPC and animation APIs.
2. Set `NPC_ENABLED=TRUE` in `.env`. Live mode requires `SOWORK_API_KEY` and a role allowed to create characters. Your existing Anthropic key/model supplies the NPC descriptions.
3. Install the additional hooks using [the Claude example](npc-hooks.claude.json) and [the Codex example](npc-hooks.codex.json).
4. Start with `DRY_RUN=TRUE`. It simulates all NPC operations in memory, logs intended changes, and still calls Anthropic for prose. No SoWork client or live ownership file is used. Set `NPC_NAME_PREFIX=Jesse's` if you want that prefix in dry-run logs; without a live identity lookup the fallback is `My`.
5. Once validated, switch `DRY_RUN=FALSE`, build, and restart your usual service.

For an existing PM2 process, run these from the repository after editing `.env`:

```bash
npm run build
pm2 restart workingon --update-env
pm2 logs workingon
```

If the process is not registered yet, use `npm run start:pm2` instead of restarting it. PM2 runs `build/index.js` without watching source files, so changes require a build and restart. Send a fresh prompt to trigger an NPC; already-open conversations are not automatically enumerated.

Merge hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`, preserving unrelated handlers. Add a handler only where an event does not already forward to workingon. If it already does, replace that workingon handler with the example instead of installing both: `/hooks` and `/hooks/claude` are aliases, not separate inputs.

Both providers need `PreToolUse` and `PermissionRequest` for attention following, plus `PostToolUse`, `Stop`, and `SessionEnd` to leave those states. The basic personal-status hooks alone do not provide all of these signals. After installing or changing Codex hooks, review new definitions with `/hooks` if Codex marks them as needing trust; see [hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks). Start fresh agent sessions when checking updated hook configuration.

The examples assume port 8220 and `WORKINGON_HOOK_TOKEN` exported into your agents' environment. It must match `HOOK_TOKEN` in this service's `.env`. Claude uses HTTP hooks except for `SessionStart`; Codex uses command hooks. Command hooks discard the HTTP response and return successfully even if the receiver is down. They never return approval or denial instructions to the coding agent.

Validate hook support and actual field shapes on your installed builds before enabling office writes. The fixtures in the tests are synthetic, informed by the inspected schemas; they are not a substitute for capturing live shapes. Useful additional signals are `SessionStart`, `PreToolUse`, and `PermissionRequest`; Claude also supplies `PostToolUseFailure` and `StopFailure`, while Codex supplies `Interrupt`. Notification bodies and transcript files are not used.

## What you should see

One persistent NPC pool serves your user across this machine, shared by Claude Code and Codex in every repository. The lowest available numbered NPC is reused: `Jesse's Codex 1` can become `Jesse's Claude 1`, keeping its SoWork ID and avatar. A new numbered slot is created only when existing slots are assigned. Concurrent sessions get separate NPCs, even in the same repository; project names never identify sessions.

An NPC starts as **Ready**, becomes **Working**, and reports **Needs permission**, **Waiting for your answer**, **Ready for review**, **Interrupted**, or **Encountered an error** when corresponding signals arrive. A completed response does not mean the underlying task succeeded. Tool failures are evidence about the attempted work, not terminal session failures.

State changes are processed on a 250 ms worker pulse. Writes are coalesced, normally at most once every two seconds per NPC; lifecycle changes and bubble clearing bypass that throttle. Initial creation requires multiple requests because the NPC is created hidden and recorded before becoming visible. Network latency and retries can delay what appears in the office; hooks themselves do not wait for those requests.

Natural-language task descriptions use only the corresponding session's sanitized activity. A new prompt clears its previous description until new prose arrives. Summaries run at most once every 30 seconds per session with new evidence, with two simultaneous requests. Steady activity arriving during a request does not invalidate it, but a new turn or lifecycle transition does. Failed batches advance their watermark and wait for new activity.

Waiting and finished NPCs hide after 10 minutes. Working NPCs use a separate 120-minute silence timeout so a long command can keep its character around. A fresh prompt or tool start brings a hidden NPC back. A working session's delayed tool completion can also bring it back. `SessionEnd` immediately releases the NPC. Every release must successfully hide the character and clear its status and speech before another session can borrow it. Hidden characters remain in the pool indefinitely; they do not accumulate visibly at your desk. Only inactive session history expires after 24 hours (also bounded to 10,000 records). Ended sessions reject late tools/stops while retained; a new start or prompt can reopen them.

NPCs follow you (`{type: "user", userId: yourId}`) while a blocking question or permission hook puts the session in **Waiting for your answer** or **Needs permission**, subject to the idle timeout above. Queued asynchronous questions let the agent keep working and do not trigger waiting or following. A completed response makes one **30-second review visit**, saying **Ready for review**, then returns to your desk (`{type: "desk"}`) and clears the bubble. It remains available for review at the desk until the usual idle timeout hides it. Working, ready, interrupted, and failed sessions stay at the desk.

Each review window starts when the response completes. Duplicate finish hooks do not extend it, and delayed publishing never starts a late visit after the window expires. Resuming work cancels the visit immediately; a new question or permission request takes over following until resolved or idle-hidden. Review timers are memory-only and are not replayed after a restart. If your presence becomes `offline`, all visible NPCs stay at the desk; going online does not reset the review window. Presence is polled once every 30 seconds for the whole group; `busy` and `away` remain online. The integration delegates actual movement/rendering to SoWork's native location behavior.

A failed presence read, including HTTP 404, retains the owner's last known availability while session tracking, movement, idle hiding, and pool reuse continue. The read retries after at least 30 seconds, honoring longer `Retry-After` delays; HTTP 429 also pauses other API requests until that delay expires. A successful read clears `presenceError` and logs recovery. During startup, failed identity reads retry with backoff before any NPC can be created or reused. HTTP 401/403, an invalid initial owner ID, an ownership mismatch, and ownership-ledger failures still stop NPC publishing and require intervention. Fatal periodic presence failures explicitly log that publishing is paused.

Ordinary speech bubbles mark questions and meaningful milestones. They are limited to one per NPC per minute and one across the group every 10 seconds, and clear after 10 seconds or when their lifecycle context changes. Pending ordinary speech expires after 30 seconds instead of becoming a backlog. The deterministic **Ready for review** announcement is exempt from these speech cooldowns so each visit explains its purpose; it is sent once per completed response and lasts only for the remaining review window. Review announcements still reserve cooldown time for subsequent ordinary speech. An ambiguous speech write is consumed rather than replayed.

### Brief reactions

With NPC mode enabled, `NPC_ANIMATIONS_ENABLED=TRUE` adds a brief reaction when the session changes state. Both providers use the same lifecycle mapping:

| Event                                             | Animation        |
| ------------------------------------------------- | ---------------- |
| Starts or resumes working, including a new prompt | `reactThink`     |
| Enters a blocking question or permission wait     | `reactSurprise`  |
| Response finishes and is ready for review         | `reactCelebrate` |
| Terminal session failure                          | `reactCry`       |

Each reaction has a 15-second window starting at the hook. The publisher sends only the remaining whole seconds, skipping a reaction with less than a second left. Normal tools, duplicate events, compaction, and new summaries do not extend or restart it. Only the latest reaction is kept; none are persisted or replayed after a restart. A completion reaction means **ready for review**, not that the underlying task succeeded. Ordinary tool failures do not trigger crying. The other eligible clips (`reactHype`, `reactLol`, `jump1`) are not currently assigned to events; emoji animations are not used.

Movement, appearance, status, and speech publish before an animation starts. Expiry, interruption, hiding, and new lifecycle states clear the old reaction. A question can therefore keep following you after its expression ends, and the review visit still lasts 30 seconds. Existing idle hiding is unchanged. As with movement, actual rendering and request timing depend on SoWork and network latency.

Reactions currently require a `characterA` body and an advertised `loop` mode for the clip. The API's catalog currently lists the same clips for every body, even where the art is unsupported, so the body check is intentional. Capabilities are cached per physical NPC and appearance, refreshed after an appearance change or restart. Unsupported bodies/clips skip animation while all other behavior continues. Catalog failures back off; permanent catalog denials remain isolated until the next reuse, appearance change, or restart. An attempted start is consumed even on a timeout, while clears retry. Animation errors do not disable ordinary NPC updates.

Set `NPC_ANIMATIONS_ENABLED=FALSE` and restart to disable reactions. Startup still explicitly clears old animations before any NPC is reused. No ledger migration or reset is needed.

## Configuration

| Variable                       | Default                              | Meaning                                                                          |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------- |
| `NPC_ENABLED`                  | `FALSE`                              | Enable companions alongside personal statuses                                    |
| `NPC_ANIMATIONS_ENABLED`       | `TRUE`                               | Brief lifecycle reactions when NPC mode is enabled                               |
| `NPC_NAME_PREFIX`              | empty                                | Derive a possessive first name; fallback `My`                                    |
| `NPC_CHARACTER_CONFIG`         | empty                                | Optional complete v5 character JSON shared by all NPCs                           |
| `NPC_IDLE_MINUTES`             | `10`                                 | Hide waiting, ready, interrupted, or finished sessions                           |
| `NPC_STALE_MINUTES`            | `120`                                | Hide working sessions with no hooks; must be at least the idle timeout           |
| `NPC_SUMMARY_INTERVAL_SECONDS` | `30`                                 | Minimum interval between summary attempts for a session                          |
| `NPC_SPEECH_COOLDOWN_SECONDS`  | `60`                                 | Minimum interval for ordinary speech per physical NPC; review notices are exempt |
| `NPC_MAX_SESSIONS`             | `50`                                 | Maximum pool size and simultaneous leases; pending sessions wait for reuse       |
| `NPC_STATE_FILE`               | `~/.local/state/workingon/npcs.json` | Durable ownership metadata; keep it across restarts                              |

Run one service instance for your user on this machine, forwarding hooks from every repository to it. All checkouts must use the same user-level `NPC_STATE_FILE`; do not set a different file per repository or agent. Its exclusive lock refuses a second writer. At the pool limit, new sessions wait for an available slot. A slot awaiting cleanup or uncertain creation does not trigger extra NPC creation. Lowering the limit retains existing hidden characters but caps simultaneous leases; it does not delete NPCs. Session turnover alone never requires raising the pool limit. The personal activity lane continues independently.

### Character appearance

Leave `NPC_CHARACTER_CONFIG` empty to use the owner's appearance copied by SoWork when each NPC is created. To override it, paste one complete configuration as a single line of JSON in `.env`. The installed `sowork` library exports this shape:

```ts
interface NpcCharacterConfiguration {
  bodyType: string;
  slots: Record<string, string>; // Slot ID → asset ID
  version: 5;
}
```

The example below contains placeholders; replace them with real values from a complete character configuration. Use the inner character object, without a surrounding `character` property. Slot names and asset IDs depend on the body type and are not enumerated by the SDK. workingon validates the JSON shape at startup; SoWork validates the actual asset combinations.

```dotenv
NPC_CHARACTER_CONFIG={"bodyType":"BODY_TYPE_ID","slots":{"SLOT_ID":"ASSET_ID"},"version":5}
```

After editing `.env`, run `npm run build` if needed and `pm2 restart workingon`. The override applies to both new and reused NPCs as they become active. Startup hiding still completes before reuse. Appearance is sent only when it changes, so ordinary movement and status updates do not repeatedly submit it.

Before the first override, workingon durably saves each NPC's original appearance in the ownership ledger. New NPCs are created hidden with the owner's appearance first, then receive the override before becoming visible; the owner therefore needs an existing character even when an override is set. Clearing the setting restores the saved original on the next reuse, including after a crash or restart, without creating replacement NPCs. This is a snapshot, not automatic synchronization with later edits to the owner's avatar. Existing pool entries gain this optional metadata automatically; no ledger reset is needed.

## Storage and recovery

Activity and generated prose remain in memory. The state file stores installation identity, a hash binding it to the endpoint/credential, owner ID, hashed session keys, allocated numbers, NPC IDs, timestamps, pending creation markers, and original character configurations when overriding appearance. It contains no project names, prompts, tool output, descriptions, or speech. The file is written atomically with owner-only permissions. Dry runs do not read, lock, or write it.

Before a create request, the service saves an intent with a unique temporary name. It creates that NPC with `visible:false`, saves the returned ID, and only then gives it its display name and makes it visible. If a request times out after the server may have accepted it, recovery scans every page of the NPC list for that exact marker and owner. It never adopts characters just because their visible names look like `Jesse's Codex 1`.

If recovery finds no match after an ambiguous create, it continues searching periodically but **does not issue another create**. The API does not provide an idempotency key or a way to prove that an unanswered create never committed. This conservative case is exposed as `npc_create_uncertain_inspect_state`.

The version 2 ledger separates persistent pool slots from temporary session history and uses one global slot counter. Version 1 ledgers fail closed with `npc_legacy_state_requires_reset`; they require a deliberate reset after stopping the service, backing up the ledger, and verifying ownership of its exact NPC IDs and pending creation markers. Never discard a legacy ledger or delete characters by a display-name prefix.

On every launch, the service reads the persistent ledger and explicitly hides each recorded NPC, clearing its old status, speech, and animation after verifying ownership. A successful hide must precede reuse, even if fresh hooks arrive immediately or while the hide request is in flight. Failed hides retry with backoff; allocation waits until all restored NPCs have acknowledged cleanup. `npcs.startupHidesPending` in `/status` reports remaining startup cleanup.

Existing sessions appear on their next activity hook, borrowing the lowest available slot (which may differ from their previous one); there is no enumeration of already-open conversations. Explicitly ended sessions reject late tool/stop deliveries. Old turn IDs and duplicate tool IDs are ignored where the hooks provide them; without correlation IDs, arrival order is the available evidence. Permission hooks without tool IDs are matched by actor and tool name, which cannot perfectly distinguish simultaneous requests for the same tool.

Graceful shutdown attempts to hide recorded characters before releasing the file lock. The process retains its five-second shutdown deadline. The API exposes no NPC expiry: a hard kill, prolonged outage, or revoked credential can leave a visible NPC until the service recovers or you remove it manually.

## Diagnostics and troubleshooting

Authenticated `GET /status` includes `npcs`: initialization status, errors, presence state, active/hidden counts, dropped signals, pending/in-flight work, API/summary request counts, and each assigned session's name, project, phase, NPC ID, desired location, active review deadline (`reviewUntil`), latest state, and retry time. `npcs.pool` reports total, assigned, available, releasing, waiting, history, limit, and individual slot errors. Visibility and status describe the desired state; pending writes or errors can mean the office has not caught up. The personal `status` object is unchanged. Warnings and errors are in PM2's `workingon-error.log`.

`npcs.animationsEnabled` reports the reaction setting. Each session's `animation` reports the last possibly active clip, its deadline, whether expiry cleanup is due, an isolated error, and a skip reason such as `unsupported_body` or `unsupported_clip_or_mode`. This is command tracking, not confirmation that the viewer rendered the expression.

| Diagnostic                                                 | Action                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ready:false` with a retryable error                       | Check connectivity and the error log; initialization retries with backoff                                                       |
| `presenceError` with `error:null`                          | Presence reads are retrying automatically; session tracking continues using the last known availability                         |
| `npc_owner_changed` / HTTP 401 or 403 from identity checks | Verify the API identity and credentials, then restart; publishing is paused to preserve ownership safeguards                    |
| `npc_create_not_permitted` / `creationDenied:true`         | Check the role's Create characters permission, then restart; existing NPC updates may continue                                  |
| `not_npc_owner`                                            | Inspect the recorded ID and authenticated owner; the service refuses to mutate that character                                   |
| `npc_state_belongs_to_another_api_identity`                | Restore the original endpoint/key or select another state file; changing credentials is not treated as proof of the same office |
| `npc_state_unavailable_check_file_and_lock`                | Inspect the configured file and lock; preserve corrupt files for recovery                                                       |
| `npc_legacy_state_requires_reset`                          | Stop the service and preserve the v1 ledger for an ownership-verified reset                                                     |
| `npc_state_write_failed`                                   | Fix storage/permissions and restart; publishing pauses before further untracked changes                                         |
| `npc_create_uncertain_inspect_state`                       | Inspect the record's `createName` and the full SoWork NPC list; see below                                                       |
| `npc_creation_conflict`                                    | Multiple NPCs match one pending marker; inspect and resolve them manually                                                       |
| Increasing `dropped`                                       | Check session capacity and startup backlog                                                                                      |

A normal stale lock is reclaimed only when its PID is confirmed dead. An incomplete lock, reused PID, or leftover `.recovering` guard requires manual inspection. Confirm no process is using the state file before removing a lock or recovery guard. Do not erase the ledger as a troubleshooting shortcut: it is what distinguishes this integration's NPCs from other characters.

For unresolved creation, stop the service and preserve a copy of the ledger. Check every page of the office's NPC list for the exact `createName` and owner. If a matching NPC exists, keep the marker and restart so recovery can adopt it. If you have confirmed the request did not create a character, setting that record's `creationAttempted` to `false` permits a fresh attempt on resumed activity. Do not change that flag while a create request could still be in flight.

To disable NPCs, first shut down the enabled service cleanly and confirm its characters are hidden, then set `NPC_ENABLED=FALSE` and restart. Keep the state file. Starting with NPC mode disabled does not perform recovery or cleanup from an earlier hard crash.

API references: [NPC operations](https://api.sowork.com/public/documentation/reference/npcs.md), [OpenAPI schema](https://api.sowork.com/public/documentation/json), [Codex hooks](https://learn.chatgpt.com/docs/hooks), and [Claude hooks](https://code.claude.com/docs/en/hooks).
