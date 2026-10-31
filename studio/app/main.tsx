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
import { BootMark, holdBoot } from '../ui/boot-mark.tsx';
import { theoremStudioTheme } from '../ui/built/theorem-studio.js';
import { errorText, reportPageErrors, tellServer } from '../ui/lib/page-errors.ts';
import { projectEndpoint } from '../ui/lib/project-address.ts';
import { onceAnswering } from '../ui/lib/project-starting.ts';
import { createReading } from '../ui/lib/read-progress.ts';
import { openStudioProject } from '../ui/lib/studio-open.ts';
import { openStudioRun } from '../ui/lib/studio-run-open.ts';
import { frameShape } from '../ui/shell-motion.ts';
import type { StudioHost } from '../ui/studio-host.ts';
import { packageLinks, THEOREM_SITE } from '../ui/studio-nav.ts';
import { StudioNoProject } from '../ui/studio-no-project.tsx';
import { StudioRunScreen } from '../ui/studio-run.tsx';
import { StudioScreen } from '../ui/studio-screen.tsx';
import { SettingsRailButton } from '../ui/studio-settings.tsx';
import { ShellBounds, StudioRail } from '../ui/studio-shell.tsx';
import '../ui/figtree.css';
// Astryx's documented order: reset → components → theme.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '../ui/built/theme.css';
// After the theme: motion Astryx's theme API can't express.
import '../ui/motion.css';
import '../ui/shell-motion.css';

const HOST: StudioHost = { kernelVersion: kernel.version, hasSettings: true };
const PACKAGES = packageLinks(kernel.name, kernel.repository.url);

/** Toasts sit a step inside the shell's frame, which is itself a step inside the window. */
const TOASTS = { inset: { bottom: 32, end: 32 } };

const RUN_PATH = '/studio/run';

/** An agent opened in a tab of its own sits on the shell's panel; the studio draws its own on the black base. */
const onBase = location.pathname !== RUN_PATH;

/** The local server's read of the project, which the loader draws as a map. */
const reading = createReading();

/** An agent opened in a tab of its own, or the studio on the project. */
async function page(): Promise<ReactNode> {
  if (!onBase) {
    const opened = await openStudioRun(location.href, { project: true });
    if (opened) return <StudioRunScreen opened={opened} />;
    // The agent this tab ran is gone: back to the studio.
    location.replace('/studio/');
    return null;
  }
  try {
    const opened = await onceAnswering(() => openStudioProject(reading.say)).finally(
      reading.finish,
    );
    return <StudioScreen opened={opened} host={HOST} />;
  } catch {
    // This page and the server start and stop together, so the command has stopped or is stopping.
    return (
      <StudioNoProject
        title="The studio has stopped"
        description="Run the studio command in your project again, then reload."
      />
    );
  }
}

/** The page opens while the mark draws on the shell. */
const opening = page();

/** The mark is held until the page is in the shell, so it gives way to a page that is already there. */
let pageIsIn = () => {};
holdBoot(
  new Promise<void>((resolve) => {
    pageIsIn = resolve;
  }),
);

function Opened() {
  const here = use(opening);
  useEffect(pageIsIn, []);
  return here;
}

reportPageErrors(projectEndpoint());

const root = document.getElementById('root');
if (root) {
  // why: an error boundary catches what a component throws, so the window never sees it; the
  // terminal should. One React does not catch reaches the window's own listener.
  const caught = (error: unknown) => {
    console.error(error);
    tellServer(projectEndpoint(), errorText(error));
  };
  createRoot(root, { onCaughtError: caught }).render(
    <StrictMode>
      <Theme theme={theoremStudioTheme} mode="dark">
        <LayerProvider toast={TOASTS}>
          <AppShell
            variant={onBase ? 'wash' : 'elevated'}
            sideNav={
              <StudioRail
                theme={theoremStudioTheme}
                pathname={location.pathname}
                packages={PACKAGES}
                site={THEOREM_SITE}
                footerIcons={onBase ? <SettingsRailButton /> : undefined}
              />
            }
          >
            <BootMark shape={frameShape} reading={onBase ? reading : undefined} />
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
