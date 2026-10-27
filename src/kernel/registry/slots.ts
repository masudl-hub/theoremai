/**
 * Slot declaration helpers: normalize authoring forms and read choice values for
 * validation and fillSlots. Descriptions and labels are UI-only.
 */
import type { ProfileInputsSpec, SlotDecl, SlotDeclInput } from '../types.ts';

/** The allowed values of one slot declaration (legacy list or labeled form). */
export function slotValues(decl: SlotDeclInput): string[] {
  return Array.isArray(decl) ? [...decl] : decl.choices.map((choice) => choice.value);
}

/** Canonical slot declaration: always `{ choices }`, optional `label`. */
export function normalizeSlotDecl(decl: SlotDeclInput): SlotDecl {
  if (Array.isArray(decl)) {
    return { choices: decl.map((value) => ({ value })) };
  }
  return {
    ...(decl.label !== undefined && decl.label !== '' ? { label: decl.label } : {}),
    choices: decl.choices.map((choice) => ({
      value: choice.value,
      ...(choice.description !== undefined && choice.description !== ''
        ? { description: choice.description }
        : {}),
    })),
  };
}

/** Canonical `inputs.slots`, or undefined when none. */
export function normalizeSlots(
  slots: Record<string, SlotDeclInput> | undefined,
): Record<string, SlotDecl> | undefined {
  if (!slots) return undefined;
  return Object.fromEntries(
    Object.entries(slots).map(([name, decl]) => [name, normalizeSlotDecl(decl)]),
  );
}

/** Profile inputs with every slot normalized (labels/descriptions preserved). */
export function normalizeProfileInputsSlots<T extends ProfileInputsSpec | undefined>(inputs: T): T {
  if (!inputs?.slots) return inputs;
  return { ...inputs, slots: normalizeSlots(inputs.slots) };
}
