import Anthropic from '@anthropic-ai/sdk';
import { describeError, log } from './logger.js';

const SYSTEM_PROMPT = `You write one-line presence statuses for a software engineer's virtual office profile. Teammates read it to know what this person is working on.

Write it in the present continuous, as a teammate glancing at their desk would describe it — "Refactoring the auth middleware", not "The user asked Claude to refactor the auth middleware".

THE RIGHT ALTITUDE — THE MOST IMPORTANT THING TO GET RIGHT

Your audience is coworkers who are curious what this person is working on. They are not reviewing the work and will not open the code. They want to know what is being achieved, not what is being typed.

So describe what the person is trying to accomplish, not the mechanics of accomplishing it. "Making status updates describe the goal instead of the busywork" tells a coworker something real. "Editing plans.ts and digest.ts" tells them nothing they could care about, even though both describe the same half hour.

Never put any of these in a status: filenames, file extensions, directory or repository names, function, class or variable names, tool names, command text, counts of anything, or test results. They appear in the digest so that you can work out what the person is doing — they are raw material for your inference, not vocabulary for your output.

The test to apply before answering: would this sentence mean something to a colleague who has never opened this repository? If it only makes sense to someone looking at the same files, it is pitched too low — go up a level and say what the work is for.

A second test: if your sentence has a trailing clause explaining *how* the work is being done, cut it. "Fixing feed scroll jank on older Android phones" is the status; "by moving image decoding off the main thread" is the implementation detail underneath it, and a curious coworker does not need it.

WHO THE DIGEST IS ABOUT

The digest separates two very different kinds of input, under two headings:

1. The person's own words — prompts they wrote. This is the most reliable statement of what they are working on.
2. Their coding agent's activity — tools it ran, files it touched, and its own closing report. This is an agent working on their behalf. Treat it as evidence of the subject matter, and nothing more.

The person is always the subject of the status. The agent is a tool they are using; it is never the subject. Do not adopt the agent's voice, relay its report, or narrate its process.

IF THERE IS A PLAN SECTION

Some digests — not most — begin with a plan the person is working from. If and only if that section is present, its objective is what they are working on: describe that, and use the activity sections to say where they have got to with it.

Most intervals have no plan section. When there is none, work from the activity alone exactly as described below. Never go looking for an objective that was not supplied, and never invent one.

NEVER DESCRIBE THE AGENT'S STATE

Never write that anything is blocked, waiting on input, awaiting a decision, needs permission, is idle, or ran some number of tools. That describes software, not a person, and a teammate cannot act on it.

A person waiting on their agent is still working on the thing. Describe the thing.

Rules:
- Lead with the kind of work being done — debugging, refactoring, upgrading dependencies, writing tests, reviewing a PR, chasing a flaky build, drafting docs. That is what a teammate actually wants to know.
- Then say what that work is in service of. Being concrete means naming a recognizable goal or problem, never a specific file. A status that could describe any engineer on any day is useless, but so is one only its author can decode.
- Name a system, product area, or feature only if a coworker would recognize it — "the auth flow", "the billing emails", "the onboarding tour". Never name a repository, directory, or file.
- If several things happened, lead with the one that took the most activity.
- No first person, no "Claude", no trailing period, no emoji, no quotes, no hashtags.
- Plain sentence case.

Good: "debugging why prompt hooks get dropped before they're recorded"
Good: "upgrading a stale TypeScript toolchain to ESLint 10 and Jest 30"
Bad: "working in acme-api" — names the repo, says nothing about the work
Bad: "debugging why userpromptsubmit hooks get dropped in workingon" — the repo name is dead weight

Altitude, on the same half hour of work:
Bad:  "wiring plan-file objectives into status generation across plans.ts and digest.ts"
Bad:  "adding a new module and running the test suite"
Good: "making status updates describe the goal instead of the busywork"
Bad:  "editing the presence updater and adding retries around the API call"
Good: "making presence updates survive a flaky network"

These are real statuses this system got wrong, and the fix in each case:
Bad:  "blocked, waiting on input about the transcriber agent's design direction"
Good: "working through the transcriber agent's design direction"
Bad:  "drafting docs explaining design choices, waiting on you for input"
Good: "drafting docs explaining design choices"
Bad:  "tracing deterministic event ids through webhook publish logic — waiting on input"
Good: "tracing deterministic event ids through webhook publish logic"

Hard limit: the status must be under {{MAX_LENGTH}} characters. Shorter is better — aim for 40 to 70.`;

/** The model must return exactly this shape */
const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      description: 'The presence status line',
    },
  },
  required: ['status'],
  additionalProperties: false,
} as const;

export interface SummarizerOptions {
  apiKey: string;
  model: string;
  maxLength: number;
}

export class Summarizer {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxLength: number;

  constructor(options: SummarizerOptions) {
    // Timeout is milliseconds in the TS SDK. A one-line status at low effort returns in
    // seconds; the SDK's 10-minute default would let one hung request stall the whole
    // summary loop, since the scheduler skips ticks while a run is in flight.
    this.#client = new Anthropic({ apiKey: options.apiKey, timeout: 60_000 });
    this.#model = options.model;
    this.#maxLength = options.maxLength;
  }

  /**
   * Turn an activity digest into a status line.
   *
   * Returns `undefined` if the model produced nothing usable — the caller
   * should leave the existing status alone rather than push something wrong.
   */
  async summarize(digest: string): Promise<string | undefined> {
    if (digest.trim() === '') {
      return undefined;
    }

    let response;
    try {
      response = await this.#client.messages.create({
        model: this.#model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT.replace(
          '{{MAX_LENGTH}}',
          String(this.#maxLength),
        ),
        // Thinking is on by default on current models; keep effort low — this is
        // a small, well-specified task and it runs on a timer.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: STATUS_SCHEMA },
        },
        messages: [
          {
            role: 'user',
            content: `Here is what happened over the last stretch of work:\n\n${digest}`,
          },
        ],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        log.warn(
          'Anthropic rate limited the summary request; skipping this interval',
        );
      } else if (error instanceof Anthropic.APIError) {
        log.error(`Anthropic API error ${error.status}`, error.message);
      } else {
        log.error('Failed to reach the Anthropic API', describeError(error));
      }
      return undefined;
    }

    if (response.stop_reason === 'refusal') {
      log.warn('Anthropic declined to summarize this activity');
      return undefined;
    }

    return this.#extract(response);
  }

  #extract(response: Anthropic.Message): string | undefined {
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (text === '') {
      log.warn('Anthropic returned no text for the summary');
      return undefined;
    }

    let status: unknown;
    try {
      status = (JSON.parse(text) as { status?: unknown }).status;
    } catch {
      log.warn('Anthropic returned a non-JSON summary', text.slice(0, 200));
      return undefined;
    }

    if (typeof status !== 'string' || status.trim() === '') {
      log.warn('Anthropic returned an empty summary');
      return undefined;
    }

    return clamp(status.trim(), this.#maxLength);
  }
}

/**
 * Enforce the length limit ourselves.
 *
 * JSON Schema string constraints like `maxLength` are not supported by
 * structured outputs, so the model's limit is a prompt instruction, not a
 * guarantee. SoWork rejects anything over 256 characters.
 */
export function clamp(status: string, maxLength: number): string {
  const collapsed = status.replace(/\s+/g, ' ').trim();

  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  // Prefer cutting at a word boundary so the truncation reads deliberately
  const hardCut = collapsed.slice(0, maxLength - 1);
  const lastSpace = hardCut.lastIndexOf(' ');
  const body =
    lastSpace > maxLength * 0.6 ? hardCut.slice(0, lastSpace) : hardCut;

  return `${body}…`;
}
