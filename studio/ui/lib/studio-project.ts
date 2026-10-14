/**
 * A project open in the studio. A local server (`studio/server/serve.ts` in the package) hands
 * the page the project's registered profiles and tools as a workspace, and runs each profile's
 * own code.
 */
import {
	filesPrint,
	type ProjectCode,
	providersAtStart,
	type StudioAsks,
	type StudioWorkspace,
} from '../../mod.ts';
import type {
	EditedAnswer,
	OpenAnswer,
	OpenRequest,
	ProjectOrigins,
	ProviderPlace,
	SaveDone,
	SaveRefusal,
	SaveReview,
	SharedSetting,
	Unregistered,
} from '../../server/save-wire.ts';
import { createContext, useContext } from 'react';
import { getPref } from './studio-prefs.ts';

import { READ_STEPS, type ReadStep } from '../../read-steps.ts';
import { projectEndpoint } from './project-address.ts';

export interface ProjectSession {
	endpoint: string;
	/** The project's name. */
	name: string;
	/** The ids of the profiles the files held when the page opened them. */
	profiles: string[];
	/** The ids of the providers the files held when the page opened them. */
	providers: string[];
	/** The profiles the page could not show or run, and why. */
	problems: { profile: string; message: string }[];
	/** The settings the studio holds differently from the files, by profile and provider. None is the rule. */
	differences: { kind: 'profile' | 'provider'; of: string; settings: string[] }[];
	/** What the files hold that the studio cannot, which stops it comparing any profile. */
	unheld: string[];
	/** The settings several profiles share, as the project's files set them. */
	shared: SharedSetting[];
	/** The profiles and tools the files define that the project did not register. */
	unregistered: Unregistered[];
	/** The settings the project's files set in code, by profile id, tool name and provider id. */
	origins: ProjectOrigins;
	/** Where the files define each provider the project registered. */
	providerPlaces: ProviderPlace[];
	/** The tools that write: the ones the studio makes ask, and the ones it cannot. */
	asks: StudioAsks;
	/** The files as the server read them, as a short text that changes when they do. */
	print: string;
	/** What the project printed when its files stopped loading; the page shows the last load that did. */
	unloaded?: string;
	/** The editor the studio command opens files in when the builder chose none, by its command. */
	editor?: string;
	/** The setup file the studio command was started on, from the folder it ran in. */
	setup?: string;
}

/**
 * What the project's files hold that exported code names and does not write again. A provider the
 * builder changed is left out, so the code writes it as the studio holds it.
 */
export function projectCode(
	project: ProjectSession | null,
	workspace: StudioWorkspace,
): ProjectCode | undefined {
	if (!project) return undefined;
	const kept = new Set(providersAtStart(workspace));
	return {
		providers: project.providerPlaces.filter((place) => kept.has(place.id)),
		origins: project.origins.profiles,
	};
}

export const NO_ASKS: StudioAsks = { asked: [], inside: [] };
const NO_ORIGINS: ProjectOrigins = { profiles: {}, tools: {}, providers: {} };

/** Set while the page has a project open; `null` on the website's own page. */
export const ProjectContext = createContext<ProjectSession | null>(null);

export function useProject(): ProjectSession | null {
	return useContext(ProjectContext);
}

/** The session for a project already open: the run page names it in its address. */
export function projectSession(name: string): ProjectSession {
	return {
		endpoint: projectEndpoint(),
		name,
		profiles: [],
		providers: [],
		problems: [],
		differences: [],
		unheld: [],
		shared: [],
		unregistered: [],
		origins: NO_ORIGINS,
		providerPlaces: [],
		asks: NO_ASKS,
		print: '',
	};
}

/** Where the local server runs the profile with this id. */
export function projectProfileEndpoint(project: ProjectSession, profileId: string): string {
	return `${project.endpoint}/profiles/${encodeURIComponent(profileId)}`;
}

async function post<T>(project: ProjectSession, path: string, body: unknown): Promise<T> {
	const response = await fetch(`${project.endpoint}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`The studio server answered ${String(response.status)}.`);
	return response.json();
}

/** What Save would write for this workspace: each change, and the lines of each file. Writes nothing. */
export function reviewSave(
	project: ProjectSession,
	workspace: StudioWorkspace,
): Promise<SaveReview | SaveRefusal> {
	return post(project, '/save', { workspace });
}

/** Writes the changes of a review the builder read. The server checks the project and reloads it. */
export function writeSave(
	project: ProjectSession,
	workspace: StudioWorkspace,
	stamp: string,
): Promise<SaveDone | SaveRefusal> {
	return post(project, '/save', { workspace, stamp });
}

/** Puts the files of the last Save back. */
export function undoSave(project: ProjectSession): Promise<SaveDone | SaveRefusal> {
	return post(project, '/save/undo', {});
}

/**
 * Starts the load that runs this workspace's edits over the project's files, when it is not the
 * one running. Writes nothing.
 */
export function openEdited(
	project: ProjectSession,
	workspace: StudioWorkspace,
): Promise<EditedAnswer> {
	return post(project, '/edited', { workspace });
}

/** Where the local server runs the profile with this id as the builder's edits make it. */
export function editedProfileEndpoint(project: ProjectSession, profileId: string): string {
	return `${project.endpoint}/edited/profiles/${encodeURIComponent(profileId)}`;
}

/** Shows a line of one of the project's files in the editor the builder chose, or the studio command's. */
export function openInEditor(project: ProjectSession, place: OpenRequest): Promise<OpenAnswer> {
	const editor = getPref('editor');
	return post(project, '/open', editor ? { ...place, editor } : place);
}

/** What the local server says the project is now. */
interface Opened {
	project: string;
	workspace: StudioWorkspace;
	problems: ProjectSession['problems'];
	differences?: ProjectSession['differences'];
	unheld?: string[];
	shared?: SharedSetting[];
	unregistered?: Unregistered[];
	origins?: ProjectOrigins;
	providerPlaces?: ProviderPlace[];
	asks?: StudioAsks;
	unloaded?: string;
	editor?: string;
	setup?: string;
}

async function describe(): Promise<Opened> {
	const response = await fetch(projectEndpoint());
	if (!response.ok) throw new Error(`The studio server answered ${String(response.status)}.`);
	return response.json();
}

/**
 * The project as the server describes it, after each step of its read of the files: `said` hears
 * each as it happens. The server sends a line of JSON for each, then one holding the project.
 */
async function describeSaying(said: (step: ReadStep) => void): Promise<Opened> {
	const response = await fetch(`${projectEndpoint()}?${READ_STEPS}`);
	if (!response.ok || !response.body) {
		throw new Error(`The studio server answered ${String(response.status)}.`);
	}
	const lines = response.body.pipeThrough(new TextDecoderStream()).getReader();
	let kept = '';
	let opened: Opened | undefined;
	const take = (line: string) => {
		if (!line) return;
		const read = JSON.parse(line) as ReadStep | { opened: Opened };
		if ('opened' in read) opened = read.opened;
		else said(read);
	};
	for (let next = await lines.read(); !next.done; next = await lines.read()) {
		const whole = (kept + next.value).split('\n');
		kept = whole.pop() ?? '';
		whole.forEach(take);
	}
	take(kept);
	if (!opened) throw new Error('The studio server stopped before it sent the project.');
	return opened;
}

/** What a project's files say, which a Save or an edit in the builder's editor changes. */
export type ProjectFiles = Pick<
	ProjectSession,
	| 'profiles'
	| 'providers'
	| 'problems'
	| 'differences'
	| 'unheld'
	| 'origins'
	| 'providerPlaces'
	| 'asks'
	| 'print'
	| 'unloaded'
>;

/** What the files say, of a project as the server describes it. */
function filesOf(opened: Opened): ProjectFiles {
	return {
		profiles: opened.workspace.agents.map((agent) => agent.identity.agentId),
		providers: opened.workspace.providers.map((provider) => provider.id),
		problems: opened.problems,
		differences: opened.differences ?? [],
		unheld: opened.unheld ?? [],
		origins: opened.origins ?? NO_ORIGINS,
		providerPlaces: opened.providerPlaces ?? [],
		asks: opened.asks ?? NO_ASKS,
		print: filesPrint(opened.workspace),
		...(opened.unloaded === undefined ? {} : { unloaded: opened.unloaded }),
	};
}

/**
 * What the project's files say now that the page does not hold as edits: the profiles they hold
 * and the ones the studio cannot run, the settings they set in code, whose lines a Save moves,
 * and the tools the studio makes ask. With them, the workspace the files open as.
 */
export async function readFiles(): Promise<{ files: ProjectFiles; workspace: StudioWorkspace }> {
	const opened = await describe();
	return { files: filesOf(opened), workspace: opened.workspace };
}

/**
 * The project the local server has open. `said` hears each step of the server's read of the
 * files. Throws when no server answers.
 */
export async function openProject(said?: (step: ReadStep) => void): Promise<{
	project: ProjectSession;
	workspace: StudioWorkspace;
}> {
	const opened = await (said ? describeSaying(said) : describe());
	return {
		project: {
			endpoint: projectEndpoint(),
			name: opened.project,
			shared: opened.shared ?? [],
			unregistered: opened.unregistered ?? [],
			...(opened.editor === undefined ? {} : { editor: opened.editor }),
			...(opened.setup === undefined ? {} : { setup: opened.setup }),
			...filesOf(opened),
		},
		workspace: opened.workspace,
	};
}
