/**
 * What the page that shows the studio gives it: the pieces that belong to the host's build rather
 * than to the screen.
 */
import { createContext, useContext } from 'react';
import type {
  LentKeys,
  StudioSourceError,
  StudioSourceSpan,
  StudioToolHandlers,
  StudioWorkspace,
} from '../mod.ts';
import type { studioSurface } from '../surface.ts';
import type { ProjectSession } from './lib/studio-project.ts';
import type { RestoredStudio } from './lib/studio-session.ts';

/** What the studio opens on: the workspace, and what arriving set aside. */
export interface StudioOpened {
  start: RestoredStudio;
  /** A question the chat opens with. */
  question: string | undefined;
  /** A kept workspace this arrival replaced, offered back behind Undo. */
  displaced: StudioWorkspace | undefined;
  /** True when a kept workspace could not be read back. */
  discarded: boolean;
  /** The local project the studio is open on, when it is. */
  project?: ProjectSession;
}

/** What reading the code view's text back found: its errors, and where each node sits in it. */
export interface CodeApply {
  errors: StudioSourceError[];
  spans: StudioSourceSpan[];
}

/** An issue the code view marks on the node it belongs to. */
export interface CodeIssue {
  nodeId: string;
  field?: string;
  message: string;
}

/**
 * The code view. `text` is the latest print; while the visitor is typing the view keeps their
 * text. `hold` means there is no new print, so the text they have stays. `isReadOnly` shows the
 * text and takes no edit.
 */
export interface StudioCodeProps {
  text: string;
  hold: boolean;
  isReadOnly?: boolean;
  issues: readonly CodeIssue[];
  onApply: (text: string) => CodeApply;
}

/** What the screen shows of the draft, for a host that follows along. */
export interface StudioReport {
  agent: string;
  type: string;
  issues: number;
  section: string | undefined;
}

export interface StudioHost {
  /** The `@theoremjs/agents` version the studio runs, shown under its title. */
  kernelVersion: string;
  /** Mounts the screen's surface while the screen is open; returns the unmount. */
  mountSurface?: (surface: ReturnType<typeof studioSurface>) => () => void;
  /** Called as what is on screen changes, and with null when the screen closes. */
  onReport?: (report: StudioReport | null) => void;
  /**
   * True when the host's page has a door to Settings (`SettingsRailButton`). The screen then
   * shows Settings when asked, and Keys are there and not in the editor's header.
   */
  hasSettings?: boolean;
  /**
   * Keys the page lends to whoever opens the studio, and what runs on them. Without them the
   * studio runs only on the builder's own keys or machine.
   */
  lentKeys?: LentKeys;
  /**
   * Handlers for the page's own function tools, by name, as its examples use them. A tool with
   * none answers with its sample reply or a stub.
   */
  toolHandlers?: StudioToolHandlers;
}

/** What a page gives every studio it opens, the run tab's too. */
export type StudioSupplies = Pick<StudioHost, 'lentKeys' | 'toolHandlers'>;

export const StudioHostContext = createContext<StudioHost | null>(null);

export function useStudioHost(): StudioHost {
  const host = useContext(StudioHostContext);
  if (!host) throw new Error('The studio screen needs a host.');
  return host;
}
