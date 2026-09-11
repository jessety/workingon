import type { NpcCharacterConfiguration } from 'sowork';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compare JSON values without depending on property order or object prototypes. */
export function sameNpcCharacterConfig(
  left: NpcCharacterConfiguration | undefined,
  right: NpcCharacterConfiguration | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.version === right.version &&
    left.bodyType === right.bodyType &&
    Object.keys(left.slots).length === Object.keys(right.slots).length &&
    Object.entries(left.slots).every(
      ([slot, asset]) =>
        Object.hasOwn(right.slots, slot) && right.slots[slot] === asset,
    )
  );
}

/** Structural validation only; SoWork validates IDs against its asset catalog. */
export function parseNpcCharacterConfig(
  raw: string,
): NpcCharacterConfiguration | undefined {
  let json = raw.trim();
  if (json === '') {
    return undefined;
  }
  // env-smart removes outer double quotes, but retains single quotes in .env.
  if (json.startsWith("'") && json.endsWith("'")) {
    json = json.slice(1, -1);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // JSON parser errors can echo the input. Report only the setting name.
    throw new Error('NPC_CHARACTER_CONFIG must contain valid JSON');
  }
  return readNpcCharacterConfig(value);
}

/** Rebuild only appearance fields when retaining an original config in the ledger. */
export function readNpcCharacterConfig(
  value: unknown,
): NpcCharacterConfiguration {
  if (
    !record(value) ||
    value.version !== 5 ||
    typeof value.bodyType !== 'string' ||
    value.bodyType.trim() === '' ||
    !record(value.slots) ||
    Object.entries(value.slots).some(
      ([slot, asset]) => slot.trim() === '' || typeof asset !== 'string',
    ) ||
    Object.keys(value).some(
      (key) => !['version', 'bodyType', 'slots'].includes(key),
    )
  ) {
    throw new Error(
      'NPC_CHARACTER_CONFIG requires version: 5, a non-empty bodyType string, and slots mapping slot names to asset ID strings; no other top-level fields are supported',
    );
  }
  return {
    version: 5,
    bodyType: value.bodyType,
    slots: Object.fromEntries(
      Object.entries(value.slots).sort(([a], [b]) => a.localeCompare(b)),
    ) as Record<string, string>,
  };
}
