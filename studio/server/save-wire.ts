/**
 * What the page and the studio's server say to each other about the project's
 * files: its shared settings, and Save. Types only: the page imports this
 * without the server's code.
 *
 * @module
 */

import type { StudioWorkspace } from '../workspace.ts';

/** A constant that more than one profile or tool reads: one value, set in one place. */
export interface SharedSetting {
  /** The constant's name where it is declared. */
  name: string;
  /** The name as words: `STANDARD_GUARDRAILS` is "Standard guardrails". */
  label: string;
  /** Where it is declared: the path and the one-based line. */
  file: string;
  line: number;
  /**
   * The profile key it fills, when every profile reads it as the whole of that key and no tool
   * reads it. The studio opens these at that key; any other is edited where a profile or tool shows it.
   */
  key?: string;
  /** The profiles it reaches, by id, and the tools, by name. */
  profiles: string[];
  tools: string[];
  /** Code that is not a profile or a tool reads it too. */
  readByCode: boolean;
}

/**
 * A setting the project's files do not write out as a plain value, so the studio shows it and
 * does not change it.
 * - `code`: code computes it: a call, a name the studio cannot follow, a method.
 * - `constant`: a named constant holds an id (the profile's, a provider's), and code that is not a profile or a tool reads the constant too.
 * - `spread`: the object spreads another into itself, so the studio writes only the keys in `written`.
 * - `twice`: the files define the profile or tool more than once.
 * - `unfound`: no place in the project's files defines the profile or tool.
 */
export interface SettingOrigin {
  /** The keys that lead to the setting: `['models', 'fast', 'apiId']`. Empty for the whole profile or tool. */
  path: string[];
  kind: 'code' | 'constant' | 'spread' | 'twice' | 'unfound';
  /** What the file says there, on one line: `bonsaiInputs()`. */
  text?: string;
  /** Where it says it: the path and the one-based line. */
  file?: string;
  line?: number;
  /** For a `spread`: the keys written after it, which the studio still writes. */
  written?: string[];
}

/**
 * Where the files write one setting's value. Two settings with the same `site` are one value in
 * the files: a constant several profiles read, what a function they all call returns, the call a
 * function makes for each of them.
 */
export interface SettingSite {
  /** The keys that lead to the setting. Empty for the whole profile or tool. */
  path: string[];
  /** The place, as a number the project gives it for this read. */
  site: number;
  /** Another setting has the same site. False for a value a profile sets apart inside a shared one. */
  shared: boolean;
  /** The constant or function that holds the place. */
  name?: string;
  /** Where it is: the path and the one-based line. */
  file: string;
  line: number;
  /** Set when code that is not a profile or a tool reads the place too: each line that reads it. */
  readBy?: SourcePlace[];
}

/** A line of one of the project's files. */
export interface SourcePlace {
  file: string;
  line: number;
}

/** Each profile's and tool's settings that are set in code, by profile id and tool name. */
export interface ProjectOrigins {
  profiles: Record<string, SettingOrigin[]>;
  tools: Record<string, SettingOrigin[]>;
  /** Where each value others read too is written, by profile id and tool name. Only those that hold one are listed. */
  sites?: { profiles: Record<string, SettingSite[]>; tools: Record<string, SettingSite[]> };
}

/** What the page asks to see in the builder's editor: a project file, from the project's folder. */
export interface OpenRequest {
  file: string;
  line?: number;
}

/**
 * Whether the builder's editor was started on the line. `byDefault` is the machine's own default
 * editor, started on the file when the named one did not start; it opens at the top.
 * - `file`: the project's setup does not read that file.
 * - `editor`: the studio does not know how to start the editor on a line.
 * - `failed`: the editor did not start.
 */
export type OpenAnswer =
  | { ok: true; editor: string; byDefault?: true }
  | { ok: false; reason: 'file' | 'editor' | 'failed'; editor?: string; place?: string };

/**
 * What happens to one changed value.
 * - `written`: Save rewrites it in the file.
 * - `constant`: a named constant holds it, and something else that reads the constant does not make this change.
 * - `code`: code computes it, or the file sets it in a way the studio cannot follow.
 * - `changed`: the file no longer holds the value the studio opened.
 * - `unfound`: no place in the project's files sets it.
 * - `unused`: a tool the studio added that no agent allows, so it was never run.
 * - `taken`: the file a new profile or tool would be written to is already there.
 * - `setup`: the studio cannot tell how the project's setup registers things, so it cannot add one.
 * - `removed`: a profile or tool the studio took away, registered in a way the studio cannot follow.
 */
export type SaveStatus =
  | 'written'
  | 'constant'
  | 'code'
  | 'changed'
  | 'unfound'
  | 'unused'
  | 'taken'
  | 'setup'
  | 'removed';

export interface SaveChange {
  kind: 'profile' | 'tool';
  /** The profile's id or the tool's name, as the project has it. */
  of: string;
  /** The setting, as a path: `tools.allow`. Empty for the whole profile or tool. */
  setting: string;
  status: SaveStatus;
  /** Where the value is set: the absolute path and the one-based line. */
  file?: string;
  line?: number;
  /** The constant that holds it. */
  name?: string;
  /** The other profiles and tools that read the constant, by id and name. Save writes it when each makes the same change. */
  sharedWith?: string[];
  /** Code that is not a profile or a tool reads the constant too. */
  readByCode?: boolean;
}

/** A run of changed lines in one file, with the lines around it. */
export interface DiffHunk {
  /** The one-based line the removed lines start on. */
  line: number;
  lead: string[];
  removed: string[];
  added: string[];
  trail: string[];
}

/** The page's workspace, and for a write the stamp of the review the builder read. */
export interface SaveRequest {
  workspace: StudioWorkspace;
  /** Present to write. It must match the review's, so what is written is what was read. */
  stamp?: string;
}

/** One file Save changes, with its path from the project's folder. */
export interface SaveFile {
  file: string;
  hunks: DiffHunk[];
  /** Save creates the file: its one hunk is the whole of it. */
  created?: true;
  /** Save takes the file away: nothing of its own is left in it. Its one hunk is the whole of it. */
  removed?: true;
}

/** The review before a write: every change, where it lands, and whether Save can write them all. */
export interface SaveReview {
  ok: true;
  /** Each change, with `file` from the project's folder. */
  changes: SaveChange[];
  files: SaveFile[];
  stamp: string;
  /** True when there is something to write and every change can be written. */
  writable: boolean;
}

/** Files written, or put back by an undo. */
export interface SaveDone {
  ok: true;
  written: string[];
}

/**
 * The load that runs the builder's unsaved edits is up, and which edits it holds: `stamp` changes
 * when they do. A refusal says why there is none: the edits have `issues`, the project did not
 * `load` with them, or it loaded as something that `differs` from them. Either way, `saved` is the
 * ids of the profiles the files hold: the ones the files' own load can run beside it.
 */
export type EditedAnswer = ({ ok: true; stamp: string } | SaveRefusal) & { saved: string[] };

/**
 * Why nothing was written, or why a write was taken back.
 * - `issues`: the workspace does not compile.
 * - `stale`: the files changed after the review was read.
 * - `unwritable`: a change cannot be written.
 * - `check`: the project did not type-check with the change.
 * - `load`: the project did not load with the change.
 * - `differs`: the project loaded, but not as the builder tested it.
 * - `nothing`: there is no Save to undo.
 */
export interface SaveRefusal {
  ok: false;
  reason: 'issues' | 'stale' | 'unwritable' | 'check' | 'load' | 'differs' | 'nothing';
  detail: string[];
}
