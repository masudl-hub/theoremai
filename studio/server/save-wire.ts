/**
 * What the page and the studio's server say to each other about Save. Types
 * only: the page imports this without the server's code.
 *
 * @module
 */

import type { StudioWorkspace } from '../workspace.ts';

/**
 * What happens to one changed value.
 * - `written`: Save rewrites it in the file.
 * - `constant`: a named constant holds it, and something else reads that constant too.
 * - `code`: code computes it, or the file sets it in a way the studio cannot follow.
 * - `changed`: the file no longer holds the value the studio opened.
 * - `unfound`: no place in the project's files sets it.
 * - `new`, `removed`: a profile or tool the studio added or took away.
 */
export type SaveStatus = 'written' | 'constant' | 'code' | 'changed' | 'unfound' | 'new' | 'removed';

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
  /** The other profiles and tools that read the constant, by id and name. */
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
