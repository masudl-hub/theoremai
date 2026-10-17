/**
 * What the studio command says while it reads a project, a line at a time, before it answers with
 * the project. Each file is named from the project's folder.
 */
export type ReadStep =
  /** A file was read. `from` is the file whose import led to it; the setup file has none. */
  | { file: string; from?: string }
  /** A profile or a tool was found in a file already read. `type` is the type the file writes for it. */
  | { found: 'profile' | 'tool'; name: string; file: string; type?: string }
  /** The files changed since the last load, so the project is loading again. */
  | { again: true };

/** The address that asks for the steps before the project. */
export const READ_STEPS = 'steps';
