import type { z } from 'zod';

/**
 * How a field's value leaves the page. The runtime projects every value through
 * its format before an agent sees it, so a page cannot forget to.
 * - `secret`: only a card (set, what it looks like, what is wrong with it), never the value.
 * - `url`: credential query parameters and `user:pass@` masked.
 * - `headers`: a JSON object of headers, credential-named values masked.
 * - `text` (the default): as is, then scrubbed with every other answer.
 */
export type SurfaceFieldFormat = 'secret' | 'url' | 'headers' | 'text';

export interface SurfaceField {
  value: unknown;
  /** The kind of value, as the agent should read it ("boolean", "one of …"). */
  type?: string;
  /** What the setting means. */
  doc?: string;
  options?: readonly unknown[];
  format?: SurfaceFieldFormat;
  /** Why the agent may not `set` it; the person still can. */
  readOnly?: string;
  /** For a secret: what uses it, so its card can say. */
  usedBy?: readonly string[];
}

/** Something wrong on a node, or on one of its fields. */
export interface SurfaceIssue {
  node: string;
  field?: string;
  message: string;
}

/** A change that was not made, and why. */
export interface SurfaceRejection {
  field: string;
  why: string;
}

/**
 * - `read`: changes nothing.
 * - `run`: does something outside the surface (tests a key, sends a message, exports).
 * - `write`: changes the surface; it needs the revision the agent last saw.
 */
export type SurfaceEffect = 'read' | 'run' | 'write';

/** Who a change is by, for the surface to record: notes are told only about the person's. */
export type SurfaceAuthor = 'person' | 'agent';

export interface SurfaceActionContext {
  callId: string;
  by: SurfaceAuthor;
}

export interface SurfaceActionOutcome {
  rejected?: SurfaceRejection[];
  /** What the action found or made; scrubbed like everything else. */
  result?: unknown;
  /** The node the change landed on (local id), shown back to the agent. */
  node?: string;
}

export interface SurfaceAction<Input = Record<string, unknown>> {
  description: string;
  effect: SurfaceEffect;
  /** Checked before `run`; each issue comes back as a rejection. */
  input?: z.ZodType<Input>;
  /** A write that starts something over: the same `intent` again within a minute replays. */
  intent?: boolean;
  run(
    input: Input,
    ctx: SurfaceActionContext,
  ): SurfaceActionOutcome | Promise<SurfaceActionOutcome>;
}

export interface SurfaceNode {
  /** Unique in its surface. The root's is `''`, addressed by the surface id alone. */
  id: string;
  title: string;
  /** The parent's id; the root has none. */
  parent?: string;
  summary?: string;
  fields?(): Record<string, SurfaceField>;
  /**
   * Applies field changes the runtime has checked: each names a field (or a dotted path in one),
   * and none is a secret or read-only.
   */
  set?(
    changes: Record<string, unknown>,
    ctx: SurfaceActionContext,
  ): { rejected: SurfaceRejection[] };
  /** Shows the node, or one of its fields, to the person: selects it, scrolls to it, focuses it. */
  point?(field?: string): void;
  actions?: Record<string, SurfaceAction<never>>;
}

export interface SurfaceChange {
  revision: number;
  by: SurfaceAuthor;
  /** Local ids of the nodes it touched. */
  nodes: readonly string[];
}

/** What a page mounts so an agent can see it and work in it. */
export interface Surface {
  id: string;
  title: string;
  revision(): number;
  /** One line: what is here and where it stands. */
  summary(): string;
  /** Read fresh on every call. The first is the root. */
  nodes(): readonly SurfaceNode[];
  issues?(): readonly SurfaceIssue[];
  changesSince?(revision: number): readonly SurfaceChange[];
  subscribe?(listener: () => void): () => void;
  /** Secret values by name, so any answer that carries one is scrubbed. Read per answer, never kept. */
  secrets?(): Record<string, string>;
}

/** Defines an action with its input type inferred, then erased for `SurfaceNode.actions`. */
export function defineAction<Input>(action: SurfaceAction<Input>): SurfaceAction<never> {
  return action as unknown as SurfaceAction<never>;
}
