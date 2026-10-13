import type { NpcAnimationCatalog, NpcCharacterConfiguration } from 'sowork';
import { sameNpcCharacterConfig } from './character.js';
import { npcError } from './client.js';
import { REACTION_MS } from './session.js';
import type { NpcClient, SessionReaction } from './types.js';

export interface AnimationTarget {
  id: string;
  character: NpcCharacterConfiguration;
  reaction?: SessionReaction;
  /** Normal appearance, lifecycle, movement and speech have been published. */
  ready: boolean;
}

/** Memory-only commands for one physical NPC. Call from its serialized worker. */
export class NpcAnimations {
  #catalog: NpcAnimationCatalog | undefined;
  #id: string | undefined;
  #character: NpcCharacterConfiguration | undefined;
  #attempted: SessionReaction | undefined;
  #active: SessionReaction | undefined;
  #retryAt = 0;
  #failures = 0;
  #error: string | undefined;
  #skipped: string | undefined;

  /** Appearance acknowledgments invalidate capabilities, including a cached error. */
  appearance(id: string, character: NpcCharacterConfiguration): void {
    if (this.#id === id && sameNpcCharacterConfig(this.#character, character)) {
      return;
    }
    this.#id = id;
    this.#character = structuredClone(character);
    this.#catalog = undefined;
    this.#retryAt = 0;
    this.#failures = 0;
    this.#error = undefined;
    this.#skipped = undefined;
  }

  /** Only after the server acknowledged a hide/clear. Never infer this locally. */
  cleared(): void {
    this.#active = undefined;
    this.#error = undefined;
    this.#retryAt = 0;
    this.#failures = 0;
  }

  #reaction(target: AnimationTarget, now: number): SessionReaction | undefined {
    const reaction = target.reaction;
    return reaction !== undefined && now < reaction.expiresAt
      ? reaction
      : undefined;
  }

  needsWork(target: AnimationTarget, now: number): boolean {
    if (now < this.#retryAt) {
      return false;
    }
    const reaction = this.#reaction(target, now);
    if (this.#active !== undefined && this.#active !== reaction) {
      return true;
    }
    return (
      target.ready && reaction !== undefined && reaction !== this.#attempted
    );
  }

  async publish(
    client: NpcClient['npcs'],
    target: () => AnimationTarget,
    now: () => number,
    request: <T>(action: () => Promise<T>) => Promise<T>,
    backoff: (failures: number, minimum: number) => number,
    failed: (error: ReturnType<typeof npcError>) => void,
  ): Promise<void> {
    const initial = target();
    try {
      const reaction = this.#reaction(initial, now());
      if (this.#active !== undefined && this.#active !== reaction) {
        await request(() => client.updateNpc(initial.id, { animation: null }));
        this.cleared();
        return;
      }
      if (
        !initial.ready ||
        reaction === undefined ||
        reaction === this.#attempted
      ) {
        return;
      }
      // The current API catalog is not yet body-specific. These expressions
      // have art only for characterA, even if another body advertises them.
      if (initial.character.bodyType !== 'characterA') {
        this.#attempted = reaction;
        this.#skipped = 'unsupported_body';
        return;
      }
      if (this.#catalog === undefined) {
        const { data } = await request(() =>
          client.getNpcAnimations(initial.id),
        );
        this.#catalog = data;
        this.#error = undefined;
        this.#failures = 0;
        this.#retryAt = 0;
      }
      const current = target();
      const durationSeconds = Math.min(
        REACTION_MS / 1000,
        Math.floor((reaction.expiresAt - now()) / 1000),
      );
      // Hooks, shutdown, or a deadline may supersede a slow capability lookup.
      if (
        !current.ready ||
        current.id !== initial.id ||
        current.reaction !== reaction ||
        durationSeconds < 1 ||
        !sameNpcCharacterConfig(initial.character, current.character)
      ) {
        return;
      }
      this.#attempted = reaction;
      if (
        !this.#catalog.animations.some(
          (animation) =>
            animation.id === reaction.clip && animation.modes.includes('loop'),
        )
      ) {
        this.#skipped = 'unsupported_clip_or_mode';
        return;
      }
      // Reserve before sending: a timeout may mean the server already played it.
      // Keep a possible active command so cancellation/expiry still clears it.
      this.#active = reaction;
      this.#skipped = undefined;
      await request(() =>
        client.updateNpc(initial.id, {
          animation: { clip: reaction.clip, mode: 'loop', durationSeconds },
        }),
      );
      this.#error = undefined;
      this.#failures = 0;
      this.#retryAt = 0;
    } catch (error) {
      const failure = npcError(error, now());
      this.#error = failure.code;
      this.#failures += 1;
      // Catalog denials stay isolated until appearance changes or restart.
      // Possible animations always retain a retryable clear, even after a 4xx.
      this.#retryAt =
        this.#active === undefined && !failure.retryable
          ? Infinity
          : now() + backoff(this.#failures, failure.retryAfterMs);
      failed(failure);
    }
  }

  describe(now: number): unknown {
    return {
      clip: this.#active?.clip ?? null,
      expiresAt:
        this.#active === undefined
          ? null
          : new Date(this.#active.expiresAt).toISOString(),
      clearing: this.#active !== undefined && now >= this.#active.expiresAt,
      error: this.#error ?? null,
      skipped: this.#skipped ?? null,
    };
  }
}
