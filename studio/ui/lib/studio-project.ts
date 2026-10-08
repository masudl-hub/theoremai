/**
 * A project open in the studio. A local server (`studio/server/serve.ts` in the package) hands
 * the page the project's registered profiles and tools as a workspace, and runs each profile's
 * own code.
 */
import type { StudioWorkspace } from '../../mod.ts';
import { createContext, useContext } from 'react';

/** Where the local server listens. Only this machine reaches it. */
const PROJECT_ENDPOINT = 'http://127.0.0.1:4983/api/studio';

export interface ProjectSession {
	endpoint: string;
	/** The project's name. */
	name: string;
	/** The profiles the page could not show or run, and why. */
	problems: { profile: string; message: string }[];
}

/** Set while the page has a project open; `null` on the website's own page. */
export const ProjectContext = createContext<ProjectSession | null>(null);

export function useProject(): ProjectSession | null {
	return useContext(ProjectContext);
}

/** The session for a project already open: the run page names it in its address. */
export function projectSession(name: string): ProjectSession {
	return { endpoint: PROJECT_ENDPOINT, name, problems: [] };
}

/** Where the local server runs the profile with this id. */
export function projectProfileEndpoint(project: ProjectSession, profileId: string): string {
	return `${project.endpoint}/profiles/${encodeURIComponent(profileId)}`;
}

/** The project the local server has open. Throws when no server answers. */
export async function openProject(): Promise<{
	project: ProjectSession;
	workspace: StudioWorkspace;
}> {
	const response = await fetch(PROJECT_ENDPOINT);
	if (!response.ok) throw new Error(`The studio server answered ${String(response.status)}.`);
	const opened: {
		project: string;
		workspace: StudioWorkspace;
		problems: ProjectSession['problems'];
	} = await response.json();
	return {
		project: { endpoint: PROJECT_ENDPOINT, name: opened.project, problems: opened.problems },
		workspace: opened.workspace,
	};
}
