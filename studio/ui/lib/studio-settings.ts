/**
 * Whether Settings is open, and on which section. The door to it sits in the shell's rail, away
 * from the screen that shows it, so both read the one place here.
 */
import { useSyncExternalStore } from 'react';

export const SETTINGS_SECTIONS = [
  'files',
  'confirmations',
  'keys',
  'people',
  'project',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsDoor {
  /** True once a screen that shows Settings is on the page: the door opens nothing before then. */
  ready: boolean;
  open: boolean;
  section: SettingsSection;
}

let door: SettingsDoor = { ready: false, open: false, section: 'files' };
const listeners = new Set<() => void>();

function move(next: Partial<SettingsDoor>): void {
  door = { ...door, ...next };
  for (const listener of listeners) listener();
}

/** Opens Settings, on `section` when one is named and where it was left otherwise. */
export function openSettings(section?: SettingsSection): void {
  if (door.ready) move({ open: true, ...(section ? { section } : {}) });
}

export function closeSettings(): void {
  move({ open: false });
}

export function showSettingsSection(section: SettingsSection): void {
  move({ section });
}

/** Says a screen that shows Settings is on the page; the answer says it left. */
export function settingsScreen(): () => void {
  move({ ready: true });
  return () => {
    move({ ready: false, open: false });
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => door;

export function useSettingsDoor(): SettingsDoor {
  return useSyncExternalStore(subscribe, read, read);
}
