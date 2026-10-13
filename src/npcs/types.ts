import type {
  NpcAnimationCatalog,
  NpcCharacterConfiguration,
  SoWork,
} from 'sowork';
import type { ActivitySource } from '../activity/events.js';

export type SessionKind =
  | 'start'
  | 'prompt'
  | 'tool-start'
  | 'tool-end'
  | 'question'
  | 'permission'
  | 'stop'
  | 'interrupted'
  | 'failed'
  | 'end';

/** Sanitized input only. Identity fields are hashes, never transcript paths. */
export interface SessionSignal {
  key: string;
  source: ActivitySource;
  project: string;
  at: number;
  kind: SessionKind;
  actor?: string;
  turn?: string;
  tool?: string;
  toolName?: string;
  startReason?: string;
  detail: string;
  voice: 'person' | 'agent';
}

export interface SessionSink {
  /** Synchronous, bounded memory work. Must never perform I/O. */
  observe(signal: SessionSignal): boolean;
  describe(): unknown;
}

export type SessionPhase =
  | 'ready'
  | 'working'
  | 'waiting-input'
  | 'waiting-permission'
  | 'finished'
  | 'interrupted'
  | 'failed'
  | 'ended';

export interface NpcSummary {
  task: string;
  say: string | null;
}

export interface SessionSummarizer {
  summarize(digest: string): Promise<NpcSummary | undefined>;
}

export type NpcLocation = { type: 'desk' } | { type: 'user'; userId: string };

export type NpcAnimation = NonNullable<
  Parameters<SoWork['npcs']['updateNpc']>[1]['animation']
>;

export interface SessionReaction {
  clip: NpcAnimation['clip'];
  revision: number;
  expiresAt: number;
}

export interface Npc {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
  characterConfig: NpcCharacterConfiguration;
}

export interface NpcPatch {
  name?: string;
  characterConfig?: NpcCharacterConfiguration;
  visible?: boolean;
  location?: NpcLocation;
  textStatus?: string | null;
  say?: { text: string } | null;
  animation?: NpcAnimation | null;
}

/** The SDK satisfies this slice structurally; tests supply an in-memory client. */
export interface NpcClient {
  me: {
    getMe(): Promise<{
      data: {
        id: string;
        name?: string;
        presence: { availability: 'available' | 'busy' | 'away' | 'offline' };
      };
    }>;
  };
  npcs: {
    createNpc(data: { name: string; visible: boolean }): Promise<{ data: Npc }>;
    listNpcs(query?: { cursor?: string; limit?: number }): Promise<{
      data: { npcs: Npc[]; nextCursor?: string };
    }>;
    getNpc(id: string): Promise<{ data: Npc }>;
    getNpcAnimations(id: string): Promise<{ data: NpcAnimationCatalog }>;
    updateNpc(id: string, patch: NpcPatch): Promise<unknown>;
    deleteNpc(id: string): Promise<unknown>;
  };
}

/** Session history contains identity/lifecycle metadata only, never prose. */
export interface NpcRecord {
  key: string;
  source: ActivitySource;
  lastSeen: number;
  hiddenAt?: number;
  ended: boolean;
}

/** A persistent character, leased to at most one session at a time. */
export interface NpcSlot {
  number: number;
  sessionKey?: string;
  npcId?: string;
  /** Appearance saved before the first override; no activity or generated text. */
  originalCharacterConfig?: NpcCharacterConfiguration;
  createName?: string;
  creationAttempted?: boolean;
  lastSpokeAt: number;
}

export interface NpcState {
  version: 2;
  installation: string;
  account: string;
  ownerId: string;
  counter: number;
  records: NpcSlot[];
  sessions: NpcRecord[];
}

export interface NpcStateRepository {
  open(): Promise<NpcState | undefined>;
  save(state: NpcState): Promise<void>;
  close(): Promise<void>;
}
