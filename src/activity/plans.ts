import { type ActivityEvent } from './events.js';
import { clean } from './sanitize.js';
import { describeError, log } from '../logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** A plan file is markdown; anything larger than this is not one we want to read. */
const MAX_PLAN_BYTES = 262_144;

/** Tool details that indicate a markdown file was written — `Edit: some-plan.md` */
const MARKDOWN_WRITE = /^(?:Write|Edit|NotebookEdit):\s*(.+\.md)$/;

/**
 * The part of a plan worth putting in a status: what the work is, and why.
 */
export interface PlanSummary {
  /** The plan's `# ` title */
  title: string;
  /** Excerpt of the plan's `## Context` section, if it has one */
  context?: string;
}

export interface PlanIndexOptions {
  /** Directory to look for plan files in. Empty disables the feature entirely. */
  directory: string;
  /** Forget a plan this long after last seeing it touched */
  maxAgeHours: number;
  /** Cap on the context excerpt */
  contextChars: number;
}

interface Remembered {
  filename: string;
  seenAt: number;
}

/** Pull the `# ` title out of a plan */
export function extractTitle(markdown: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(markdown);
  const title = match?.[1]?.trim();
  return title === undefined || title === '' ? undefined : title;
}

/**
 * Pull the body of the `## Context` section, up to the next heading.
 *
 * Sliced by index rather than matched with a single regex: expressing "up to the next
 * heading or the end of the file" as a lookahead needs an end-of-input anchor, and
 * JavaScript has no `\z` — writing one silently matches a literal "z" instead, which
 * truncates any plan whose Context is the final section.
 */
export function extractContext(
  markdown: string,
  maxChars: number,
): string | undefined {
  const heading = /^##\s+Context\s*$/m.exec(markdown);

  if (heading === null) {
    return undefined;
  }

  const rest = markdown.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s/m.exec(rest);
  const body = nextHeading === null ? rest : rest.slice(0, nextHeading.index);

  if (body.trim() === '') {
    return undefined;
  }

  // `clean` already collapses whitespace, redacts anything credential-shaped, and truncates
  const excerpt = clean(body, maxChars);
  return excerpt === '' ? undefined : excerpt;
}

/**
 * Finds the plan file each project is currently working from.
 *
 * Deliberately does all of its work at summary time rather than on the hook path:
 *
 * - A plan is rewritten many times while it is being drafted, so reading it when the summary
 *   is built gets the settled version rather than a half-finished one.
 * - Nothing here trusts a path from a hook payload. Candidate filenames are matched against
 *   a directory listing this service produces itself, so a forged hook event naming
 *   `/etc/passwd` matches nothing and is ignored.
 *
 * A plan is an enrichment. Every failure path — no directory, no match, a deleted file, an
 * unreadable file — resolves to "no plan", and the summary is built exactly as it is today.
 */
export class PlanIndex {
  readonly #options: PlanIndexOptions;
  /** project -> the plan file it was last seen working on */
  readonly #memory = new Map<string, Remembered>();

  constructor(options: PlanIndexOptions) {
    this.#options = options;
  }

  get enabled(): boolean {
    return this.#options.directory !== '';
  }

  /**
   * Learn from this window's activity, then resolve the current plan for each project.
   *
   * Returns an empty map when the feature is disabled or nothing matches — callers treat
   * that as "no plan", which is the common case.
   */
  async plansFor(
    events: readonly ActivityEvent[],
  ): Promise<Map<string, PlanSummary>> {
    const resolved = new Map<string, PlanSummary>();

    if (this.enabled === false) {
      return resolved;
    }

    const available = await this.#list();

    if (available.size > 0) {
      this.#remember(events, available);
    }

    this.#forgetStale();

    const wanted: Array<{ project: string; filename: string }> = [];

    for (const [project, remembered] of this.#memory) {
      // The file may have been deleted or superseded since we last saw it
      if (available.has(remembered.filename) === false) {
        log.debug(
          `Plan ${remembered.filename} no longer exists; dropping it for ${project}`,
        );
        this.#memory.delete(project);
        continue;
      }
      wanted.push({ project, filename: remembered.filename });
    }

    const summaries = await Promise.all(
      wanted.map(({ filename }) => this.#read(filename)),
    );

    wanted.forEach(({ project }, position) => {
      const summary = summaries[position];
      if (summary !== undefined) {
        resolved.set(project, summary);
      }
    });

    return resolved;
  }

  /** Filenames of the markdown files currently in the plans directory */
  async #list(): Promise<Set<string>> {
    try {
      const entries = await fs.readdir(this.#options.directory);
      return new Set(entries.filter((entry) => entry.endsWith('.md')));
    } catch (error) {
      log.debug(
        `Could not read plan directory ${this.#options.directory}`,
        describeError(error),
      );
      return new Set();
    }
  }

  /**
   * Note which plan file each project touched.
   *
   * The project comes from the activity event, which is what keeps concurrent sessions in
   * different repositories from stealing each other's plans.
   */
  #remember(
    events: readonly ActivityEvent[],
    available: ReadonlySet<string>,
  ): void {
    for (const event of events) {
      if (event.kind !== 'tool') {
        continue;
      }

      const filename = MARKDOWN_WRITE.exec(event.detail)?.[1]?.trim();

      if (filename === undefined || available.has(filename) === false) {
        continue;
      }

      const existing = this.#memory.get(event.project);
      if (existing === undefined || event.at >= existing.seenAt) {
        this.#memory.set(event.project, { filename, seenAt: event.at });
        log.debug(`Plan for ${event.project} is now ${filename}`);
      }
    }
  }

  /** A plan stops describing the work eventually, even if the file still exists */
  #forgetStale(): void {
    const cutoff = Date.now() - this.#options.maxAgeHours * 3_600_000;

    for (const [project, remembered] of this.#memory) {
      if (remembered.seenAt < cutoff) {
        log.debug(`Plan for ${project} is stale; forgetting it`);
        this.#memory.delete(project);
      }
    }
  }

  /** Read and summarize a plan, refusing anything that resolves outside the plans directory */
  async #read(filename: string): Promise<PlanSummary | undefined> {
    try {
      const directory = await fs.realpath(this.#options.directory);
      const candidate = await fs.realpath(path.join(directory, filename));

      // Defense in depth. `filename` came from our own listing, so this should never fire —
      // but a symlink out of the directory would otherwise be followed.
      const relative = path.relative(directory, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        log.warn(
          `Refusing to read ${filename}: resolves outside the plan directory`,
        );
        return undefined;
      }

      const stats = await fs.stat(candidate);
      if (stats.isFile() === false || stats.size > MAX_PLAN_BYTES) {
        return undefined;
      }

      const markdown = await fs.readFile(candidate, 'utf8');
      const title = extractTitle(markdown);

      if (title === undefined) {
        return undefined;
      }

      return {
        title: clean(title, 200),
        context: extractContext(markdown, this.#options.contextChars),
      };
    } catch (error) {
      log.debug(`Could not read plan ${filename}`, describeError(error));
      return undefined;
    }
  }
}
