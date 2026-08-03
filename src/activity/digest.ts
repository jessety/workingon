import { type ActivityEvent } from './events.js';
import { type PlanSummary } from './plans.js';

/** Longest digest we're willing to send to the model */
const MAX_DIGEST_CHARACTERS = 6000;
/** Most prompts to quote per project — these are the highest-signal lines */
const MAX_PROMPTS_PER_PROJECT = 8;
/** Most distinct tool subjects (files, commands) to list per project */
const MAX_SUBJECTS_PER_PROJECT = 12;
/** Most decisions to quote per project */
const MAX_DECISIONS_PER_PROJECT = 6;

/**
 * Activity for one project, split by who produced it.
 *
 * The split is the point: `prompts` are the person's own words about what they
 * are working on, everything else is what an agent did on their behalf. Keeping
 * the two apart is what stops the summary describing the agent's state instead
 * of the person's work.
 */
interface ProjectDigest {
  project: string;
  events: number;
  /** From the person */
  prompts: string[];
  decisions: string[];
  /** From their agent */
  toolCounts: Map<string, number>;
  subjects: string[];
  lastAssistantMessage?: string;
}

function groupByProject(events: readonly ActivityEvent[]): ProjectDigest[] {
  const projects = new Map<string, ProjectDigest>();

  for (const event of events) {
    let digest = projects.get(event.project);
    if (digest === undefined) {
      digest = {
        project: event.project,
        events: 0,
        prompts: [],
        decisions: [],
        toolCounts: new Map(),
        subjects: [],
      };
      projects.set(event.project, digest);
    }

    digest.events += 1;

    switch (event.kind) {
      case 'prompt':
        digest.prompts.push(event.detail);
        break;

      case 'decision':
        digest.decisions.push(event.detail);
        break;

      case 'tool': {
        // `detail` is "ToolName: subject" or just "ToolName"
        const separator = event.detail.indexOf(': ');
        const toolName =
          separator === -1 ? event.detail : event.detail.slice(0, separator);
        const subject =
          separator === -1 ? '' : event.detail.slice(separator + 2);

        digest.toolCounts.set(
          toolName,
          (digest.toolCounts.get(toolName) ?? 0) + 1,
        );

        if (subject !== '' && digest.subjects.includes(subject) === false) {
          digest.subjects.push(subject);
        }
        break;
      }

      case 'stop':
        digest.lastAssistantMessage = event.detail;
        break;

      // Recorded and buffered, but deliberately never summarized. These
      // describe the agent's state — whether it is blocked, what it is
      // permitted to do — which is not what the person is working on.
      case 'notification':
      case 'session-start':
      case 'session-end':
        break;
    }
  }

  // Busiest project first — that's what the user has mostly been doing
  return [...projects.values()].sort((a, b) => b.events - a.events);
}

/** Heading for the plan this work is being done against, when there is one */
export const PLAN_HEADING =
  '### The plan they are working from (agreed objective for this work)';
/** Heading for what the person themselves said */
export const PERSON_HEADING =
  "### The person's own words (what they say they are working on)";
/** Heading for what their agent did on their behalf */
export const AGENT_HEADING =
  "### Their coding agent's activity on their behalf (evidence of subject matter, not the person's state)";

function renderProject(
  digest: ProjectDigest,
  plan: PlanSummary | undefined,
): string {
  const lines: string[] = [`## Project: ${digest.project}`];

  // Optional. Most intervals have no plan, and when there isn't one everything below is
  // rendered exactly as it would have been before plans existed.
  if (plan !== undefined) {
    lines.push('', PLAN_HEADING, `Objective: ${plan.title}`);
    if (plan.context !== undefined) {
      lines.push(`Context: ${plan.context}`);
    }
  }

  if (digest.prompts.length > 0 || digest.decisions.length > 0) {
    lines.push('', PERSON_HEADING);
    for (const prompt of digest.prompts.slice(-MAX_PROMPTS_PER_PROJECT)) {
      lines.push(`- ${prompt}`);
    }
    // Answers to questions their agent put to them — their choice, in their voice
    for (const decision of digest.decisions.slice(-MAX_DECISIONS_PER_PROJECT)) {
      lines.push(`- Decided: ${decision}`);
    }
  }

  const agentLines: string[] = [];

  if (digest.toolCounts.size > 0) {
    const counts = [...digest.toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} x${count}`)
      .join(', ');
    agentLines.push(`Tools used: ${counts}`);
  }

  if (digest.subjects.length > 0) {
    const shown = digest.subjects.slice(-MAX_SUBJECTS_PER_PROJECT);
    const suffix = digest.subjects.length > shown.length ? ', …' : '';
    agentLines.push(`Touched: ${shown.join(', ')}${suffix}`);
  }

  if (digest.lastAssistantMessage !== undefined) {
    agentLines.push(`Agent's closing report: ${digest.lastAssistantMessage}`);
  }

  if (agentLines.length > 0) {
    lines.push('', AGENT_HEADING, ...agentLines);
  }

  return lines.join('\n');
}

/**
 * Render recent activity as compact text for the summarizing model.
 *
 * `plans` is optional enrichment. Omitting it, or passing a map with no entry for a project,
 * produces exactly the output this function produced before plans existed — a plan is never
 * required for a summary, and most intervals will not have one.
 *
 * Returns an empty string when there is nothing worth summarizing. A plan alone is not
 * enough: without activity there is nothing to say the person is doing right now.
 */
export function buildDigest(
  events: readonly ActivityEvent[],
  plans?: ReadonlyMap<string, PlanSummary>,
): string {
  if (events.length === 0) {
    return '';
  }

  const projects = groupByProject(events);
  const meaningful = projects.filter(
    (digest) =>
      digest.prompts.length > 0 ||
      digest.decisions.length > 0 ||
      digest.toolCounts.size > 0,
  );

  if (meaningful.length === 0) {
    return '';
  }

  const digest = meaningful
    .map((project) => renderProject(project, plans?.get(project.project)))
    .join('\n\n');

  return digest.length <= MAX_DIGEST_CHARACTERS
    ? digest
    : `${digest.slice(0, MAX_DIGEST_CHARACTERS)}\n…(truncated)`;
}
