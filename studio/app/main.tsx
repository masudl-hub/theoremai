/**
 * The studio as a page of its own, opened on the project the local server holds. The same screen
 * in the same shell the website shows at `/studio`: this file only gives it a document, the theme
 * and the project. Every page but the studio opens on the website.
 */
import { AppShell } from '@astryxdesign/core/AppShell';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { Theme } from '@astryxdesign/core/theme';
import { type ReactNode, StrictMode, Suspense, use, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import kernel from '../../package.json' with { type: 'json' };
import { BootMark } from '../ui/boot-mark.tsx';
import { theoremStudioTheme } from '../ui/built/theorem-studio.js';
import { openStudioProject } from '../ui/lib/studio-open.ts';
import { openStudioRun } from '../ui/lib/studio-run-open.ts';
import { frameShape } from '../ui/shell-motion.ts';
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
import '../ui/shell-motion.css';

const HOST: StudioHost = { kernelVersion: kernel.version };
const PACKAGES = packageLinks(kernel.name, kernel.repository.url);

const RUN_PATH = '/studio/run';

/** An agent opened in a tab of its own sits on the shell's panel; the studio draws its own on the black base. */
const onBase = location.pathname !== RUN_PATH;

/** An agent opened in a tab of its own, or the studio on the project. */
async function page(): Promise<ReactNode> {
	if (!onBase) {
		const opened = openStudioRun(location.href, { project: true });
		if (opened) return <StudioRunScreen opened={opened} />;
		// The agent this tab ran is gone: back to the studio.
		location.replace('/studio/');
		return null;
	}
	try {
		const opened = await openStudioProject();
		return <StudioScreen opened={opened} host={HOST} />;
	} catch {
		return <StudioNoProject />;
	}
}

/** The page opens while the mark draws on the shell. */
const opening = page();

/** Settles once the page is in the shell, so the mark gives way to a page that is already there. */
let pageIsIn = () => {};
const shown = new Promise<void>((resolve) => {
	pageIsIn = resolve;
});

function Opened() {
	const here = use(opening);
	useEffect(pageIsIn, []);
	return here;
}

const root = document.getElementById('root');
if (root) {
	createRoot(root).render(
		<StrictMode>
			<Theme theme={theoremStudioTheme} mode="dark">
				<LayerProvider>
					<AppShell
						variant={onBase ? 'wash' : 'elevated'}
						sideNav={
							<StudioRail
								theme={theoremStudioTheme}
								pathname={location.pathname}
								packages={PACKAGES}
								site={THEOREM_SITE}
							/>
						}
					>
						<BootMark shape={frameShape} ready={shown} />
						<Suspense>
							<Opened />
						</Suspense>
						<ShellBounds />
					</AppShell>
				</LayerProvider>
			</Theme>
		</StrictMode>,
	);
}
