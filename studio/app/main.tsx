/**
 * The studio as a page of its own, opened on the project the local server holds. The same screen
 * in the same shell the website shows at `/studio`: this file only gives it a document, the theme
 * and the project. Every page but the studio opens on the website.
 */
import { AppShell } from '@astryxdesign/core/AppShell';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import kernel from '../../package.json' with { type: 'json' };
import { theoremStudioTheme } from '../ui/built/theorem-studio.js';
import { openStudioProject } from '../ui/lib/studio-open.ts';
import { openStudioRun } from '../ui/lib/studio-run-open.ts';
import type { StudioHost } from '../ui/studio-host.ts';
import { packageLinks, THEOREM_SITE } from '../ui/studio-nav.ts';
import { StudioNoProject } from '../ui/studio-no-project.tsx';
import { StudioRunScreen } from '../ui/studio-run.tsx';
import { StudioScreen } from '../ui/studio-screen.tsx';
import { ShellBounds, StudioRail } from '../ui/studio-shell.tsx';
import '../ui/figtree.css';
// Astryx's documented order: reset → components → theme.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '../ui/built/theme.css';
// After the theme: motion Astryx's theme API can't express.
import '../ui/motion.css';

const HOST: StudioHost = { kernelVersion: kernel.version };
const PACKAGES = packageLinks(kernel.name, kernel.repository.url);

/** What this tab shows, and whether it sits on the black base and draws its own panels. */
interface Page {
	shown: ReactNode;
	onBase: boolean;
}

/** An agent opened in a tab of its own, or the studio on the project. */
async function page(): Promise<Page | null> {
	if (location.pathname === '/studio/run') {
		const opened = openStudioRun(location.href, { project: true });
		if (opened) return { shown: <StudioRunScreen opened={opened} />, onBase: false };
		// The agent this tab ran is gone: back to the studio.
		location.replace('/studio/');
		return null;
	}
	try {
		const opened = await openStudioProject();
		return { shown: <StudioScreen opened={opened} host={HOST} />, onBase: true };
	} catch {
		return { shown: <StudioNoProject />, onBase: true };
	}
}

const root = document.getElementById('root');
const here = root ? await page() : null;
if (root && here) {
	createRoot(root).render(
		<StrictMode>
			<Theme theme={theoremStudioTheme} mode="dark">
				<LayerProvider>
					<AppShell
						variant={here.onBase ? 'wash' : 'elevated'}
						sideNav={
							<StudioRail
								theme={theoremStudioTheme}
								pathname={location.pathname}
								packages={PACKAGES}
								site={THEOREM_SITE}
							/>
						}
					>
						{here.shown}
						<ShellBounds />
					</AppShell>
				</LayerProvider>
			</Theme>
		</StrictMode>,
	);
}
