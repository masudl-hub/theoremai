/**
 * What the builder chose about how the studio behaves, kept in this browser and nowhere else:
 * nothing is written to the project or sent to a server. A choice the builder never made, or one
 * this version does not know, reads as the studio's own default.
 */
import { useSyncExternalStore } from 'react';
import { studioEditor } from '../../editors.ts';

export interface StudioPrefs {
	/** The editor files open in, by its command. Empty leaves it to the studio command. */
	editor: string;
	/** Whether the studio takes in what the builder's editor saves, as it saves. */
	watch: 'on' | 'off';
	/** Whether a toast says so when the files changed a setting. */
	filesToast: 'on' | 'off';
	/** Whether changing a value several agents share is asked about first. */
	askShared: 'always' | 'never';
	/** Which tools that write ask before a run: all of them, or only the destructive ones. */
	askWrites: 'always' | 'destructive';
}

export type StudioPref = keyof StudioPrefs;

export const PREF_DEFAULTS: StudioPrefs = {
	editor: '',
	watch: 'on',
	filesToast: 'on',
	askShared: 'always',
	askWrites: 'always',
};

const PREF_KEYS: Record<StudioPref, string> = {
	editor: 'theorem.studio.editor',
	watch: 'theorem.studio.watch',
	filesToast: 'theorem.studio.files-toast',
	askShared: 'theorem.studio.ask-shared',
	askWrites: 'theorem.studio.ask-writes',
};

/** Whether a kept text is a value the preference takes. */
const PREF_TAKES: { [K in StudioPref]: (kept: string) => boolean } = {
	editor: (kept) => studioEditor(kept) !== undefined,
	watch: (kept) => kept === 'off',
	filesToast: (kept) => kept === 'off',
	askShared: (kept) => kept === 'never',
	askWrites: (kept) => kept === 'destructive',
};

/** Where preferences are kept: the part of `Storage` they use. */
export type PrefStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A preference as `storage` keeps it, or its default. */
export function readPref<K extends StudioPref>(storage: PrefStorage | null, name: K): StudioPrefs[K] {
	try {
		const kept = storage?.getItem(PREF_KEYS[name]);
		if (typeof kept === 'string' && PREF_TAKES[name](kept)) return kept as StudioPrefs[K];
	} catch {
		// A browser that keeps nothing has the defaults.
	}
	return PREF_DEFAULTS[name];
}

/** Keeps a preference. The default is kept as nothing, so a later default reaches the builder. */
export function writePref<K extends StudioPref>(
	storage: PrefStorage | null,
	name: K,
	value: StudioPrefs[K],
): void {
	try {
		if (value === PREF_DEFAULTS[name] || !PREF_TAKES[name](value)) storage?.removeItem(PREF_KEYS[name]);
		else storage?.setItem(PREF_KEYS[name], value);
	} catch {
		// A browser that keeps nothing holds the choice until the page is closed.
	}
}

function local(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

const listeners = new Set<() => void>();

export function getPref<K extends StudioPref>(name: K): StudioPrefs[K] {
	return readPref(local(), name);
}

export function setPref<K extends StudioPref>(name: K, value: StudioPrefs[K]): void {
	writePref(local(), name, value);
	for (const listener of listeners) listener();
}

/** Hears a preference change, from this tab or another one of this browser. */
function subscribePrefs(listener: () => void): () => void {
	listeners.add(listener);
	globalThis.addEventListener?.('storage', listener);
	return () => {
		listeners.delete(listener);
		globalThis.removeEventListener?.('storage', listener);
	};
}

/** A preference, and the screen drawn again when it changes. */
export function usePref<K extends StudioPref>(name: K): StudioPrefs[K] {
	return useSyncExternalStore(
		subscribePrefs,
		() => getPref(name),
		() => PREF_DEFAULTS[name],
	);
}

/** Whether a run of a tool that writes asks first: a destructive one always, another unless the builder said not to. */
export function writeAsks(access: string): boolean {
	return access === 'destructive' || getPref('askWrites') === 'always';
}
