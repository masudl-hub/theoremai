/**
 * A project open in the studio. A local server (`studio/server/serve.ts` in the package) hands
 * the page the project's registered profiles and tools as a workspace, and runs each profile's
 * own code.
 */
import type { StudioWorkspace } from '../../mod.ts';
import type {
	OpenAnswer,
	OpenRequest,
	ProjectOrigins,
	SaveDone,
	SaveRefusal,
	SaveReview,
	SharedSetting,
} from '../../server/save-wire.ts';
import { createContext, useContext } from 'react';

/** Where the local server listens. Only this machine reaches it. */
const PROJECT_ENDPOINT = 'http://127.0.0.1:4983/api/studio';

export interface ProjectSession {
	endpoint: string;
	/** The project's name. */
	name: string;
	/** The profiles the page could not show or run, and why. */
	problems: { profile: string; message: string }[];
	/** The settings several profiles share, as the project's files set them. */
	shared: SharedSetting[];
	/** The settings the project's files set in code, by profile id and tool name. */
	origins: ProjectOrigins;
	/** The tools that ask before each run here and would not in the application, by name. */
	asks: string[];
}

const NO_ORIGINS: ProjectOrigins = { profiles: {}, tools: {} };

/** Set while the page has a project open; `null` on the website's own page. */
export const ProjectContext = createContext<ProjectSession | null>(null);

export function useProject(): ProjectSession | null {
	return useContext(ProjectContext);
}

/** The session for a project already open: the run page names it in its address. */
export function projectSession(name: string): ProjectSession {
	return {
		endpoint: PROJECT_ENDPOINT,
		name,
		problems: [],
		shared: [],
		origins: NO_ORIGINS,
		asks: [],
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

/** Shows a line of one of the project's files in the builder's editor. */
export function openInEditor(project: ProjectSession, place: OpenRequest): Promise<OpenAnswer> {
	return post(project, '/open', place);
}

/** What the local server says the project is now. */
interface Opened {
	project: string;
	workspace: StudioWorkspace;
	problems: ProjectSession['problems'];
	shared?: SharedSetting[];
	origins?: ProjectOrigins;
	asks?: string[];
}

async function describe(): Promise<Opened> {
	const response = await fetch(PROJECT_ENDPOINT);
	if (!response.ok) throw new Error(`The studio server answered ${String(response.status)}.`);
	return response.json();
}

/**
 * What the project's files say now that the page does not hold as edits: the settings they set in
 * code, whose lines a Save moves, and the tools the studio makes ask.
 */
export async function readFiles(): Promise<Pick<ProjectSession, 'origins' | 'asks'>> {
	const { origins = NO_ORIGINS, asks = [] } = await describe();
	return { origins, asks };
}

/** The project the local server has open. Throws when no server answers. */
export async function openProject(): Promise<{
	project: ProjectSession;
	workspace: StudioWorkspace;
}> {
	const opened = await describe();
	return {
		project: {
			endpoint: PROJECT_ENDPOINT,
			name: opened.project,
			problems: opened.problems,
			shared: opened.shared ?? [],
			origins: opened.origins ?? NO_ORIGINS,
			asks: opened.asks ?? [],
		},
		workspace: opened.workspace,
	};
}
