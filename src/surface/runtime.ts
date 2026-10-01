import { z } from 'zod';
import { jsonSchemaFromZod } from '../kernel/tools/schema.ts';
import { knownSecrets, maskHeaders, maskUrl, scrubDeep, secretCard } from './formats.ts';
import type {
  Surface,
  SurfaceAction,
  SurfaceActionContext,
  SurfaceActionOutcome,
  SurfaceField,
  SurfaceIssue,
  SurfaceNode,
  SurfaceRejection,
} from './types.ts';

const LEDGER_SIZE = 100;
const INTENT_WINDOW_MS = 60_000;
const MOUNT_WAIT_MS = 5000;
const NODE_LIST_CAP = 80;
const RECENT_IN_STATE = 5;

/** One answered `act`, kept so a retried call replays instead of applying twice. */
export interface SurfaceLedgerEntry {
  callId: string;
  at: string;
  action: string;
  intent?: string;
  /** Whether it changed the surface, so a cancel or a lost answer after the fact can be told. */
  applied: boolean;
  result: unknown;
  time: number;
}

export interface SurfaceRuntimeOptions {
  now?: () => number;
  /** Opens a declared surface that isn't mounted (goes to its page). */
  open?: (surfaceId: string) => void;
  mountWaitMs?: number;
  /** A silent line for the agent: the person changed something, or a call's fate after the fact. */
  onNote?: (line: string) => void;
  /** Keeps the ledger across reloads; in memory when left out. */
  ledger?: {
    load(): readonly SurfaceLedgerEntry[];
    save(entries: readonly SurfaceLedgerEntry[]): void;
  };
}

export interface SurfaceRuntime {
  /** Mounts a surface until the returned function is called. */
  mount(surface: Surface): () => void;
  /** A surface the agent may open though it isn't mounted: `open` takes it there. */
  declare(id: string, title: string): void;
  isSurfaceTool(name: string): boolean;
  /** Answers a `look` or `act` call. Every answer is projected and scrubbed. */
  answer(tool: string, args: unknown, callId: string): Promise<unknown>;
  /** A call that changed the surface was cancelled, or its answer never got back: tells the agent once. */
  settled(callId: string, how: 'cancelled' | 'undelivered'): void;
  /** Where every mounted surface stands and what the agent last did; `null` when there is nothing. */
  stateLine(): string | null;
}

export const SURFACE_TOOL_NAMES = ['look', 'act'] as const;

const lookArgs = z.object({ at: z.string().optional() });
const actArgs = z.object({
  at: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  basedOn: z.number().int().optional(),
  intent: z.string().optional(),
});

const setInput = z.object({
  changes: z
    .record(z.string(), z.unknown())
    .describe('Field name (or a dotted path in one, "include.usage") to its new value'),
});
const pointInput = z.object({
  field: z.string().optional().describe('A field to focus; leave out to show the whole node'),
});

const BUILT_IN = {
  set: {
    description: 'Change fields. Each one refused comes back with why; the rest apply.',
    effect: 'write',
    input: setInput,
  },
  point: {
    description:
      'Show this node, or one of its fields, to the person: it is selected and focused. Use it to have them enter a secret.',
    effect: 'read',
    input: pointInput,
  },
} as const;

type Target = { surface: Surface; node: SurfaceNode; at: string };

function issueCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'issue' : 'issues'}`;
}

function rejectionsFrom(error: z.ZodError): SurfaceRejection[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || 'input',
    why: issue.message,
  }));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSurfaceRuntime(options: SurfaceRuntimeOptions = {}): SurfaceRuntime {
  const now = options.now ?? Date.now;
  const mounted = new Map<string, Surface>();
  const declared = new Map<string, string>();
  const mountWaiters = new Set<() => void>();
  let ledger: SurfaceLedgerEntry[] = [...(options.ledger?.load() ?? [])];

  const note = (line: string) => options.onNote?.(line);

  const remember = (entry: SurfaceLedgerEntry) => {
    ledger = [...ledger.filter((old) => old.callId !== entry.callId), entry].slice(-LEDGER_SIZE);
    options.ledger?.save(ledger);
  };

  const address = (surface: Surface, nodeId: string) =>
    nodeId ? `${surface.id}/${nodeId}` : surface.id;

  const nodeIssues = (surface: Surface, nodeId: string) =>
    (surface.issues?.() ?? []).filter((issue) => issue.node === nodeId);

  /** Every secret value showing on the page, by name: what the surface says, and every secret field. */
  const secretsOf = (surface: Surface) => {
    const found: Record<string, string> = { ...surface.secrets?.() };
    for (const node of surface.nodes()) {
      for (const [name, field] of Object.entries(node.fields?.() ?? {})) {
        if (field.format === 'secret' && typeof field.value === 'string') {
          found[`${address(surface, node.id)}.${name}`] = field.value;
        }
      }
    }
    return found;
  };

  const known = () =>
    knownSecrets(Object.assign({}, ...[...mounted.values()].map((surface) => secretsOf(surface))));

  const project = (surface: Surface, node: SurfaceNode, name: string, field: SurfaceField) => {
    if (field.format === 'secret') {
      const value = typeof field.value === 'string' ? field.value.trim() : '';
      const self = `${address(surface, node.id)}.${name}`;
      const sameAs = value
        ? Object.entries(secretsOf(surface))
            .filter(([other, otherValue]) => other !== self && otherValue.trim() === value)
            .map(([other]) => other)
        : [];
      return secretCard(field.value, { sameAs, usedBy: field.usedBy });
    }
    if (field.format === 'url' && typeof field.value === 'string') return maskUrl(field.value);
    if (field.format === 'headers') return maskHeaders(field.value);
    return field.value;
  };

  const actionsOf = (node: SurfaceNode): [string, Omit<SurfaceAction<never>, 'run'>][] => {
    const own = Object.entries(node.actions ?? {});
    const builtIn: [string, Omit<SurfaceAction<never>, 'run'>][] = [];
    if (node.set && node.fields) builtIn.push(['set', BUILT_IN.set as never]);
    if (node.point) builtIn.push(['point', BUILT_IN.point as never]);
    return [...builtIn, ...own];
  };

  const children = (surface: Surface, nodeId: string) =>
    surface
      .nodes()
      .filter((child) => child.id && (child.parent ?? '') === nodeId)
      .map((child) => {
        const count = nodeIssues(surface, child.id).length;
        return {
          at: address(surface, child.id),
          title: child.title,
          ...(count ? { issues: count } : {}),
        };
      });

  const nodeView = ({ surface, node, at }: Target) => {
    const fields = node.fields?.() ?? {};
    const about = Object.fromEntries(
      Object.entries(fields).flatMap(([name, field]) => {
        const info = {
          ...(field.type ? { type: field.type } : {}),
          ...(field.doc ? { doc: field.doc } : {}),
          ...(field.options?.length ? { options: field.options } : {}),
          ...(field.format && field.format !== 'text' ? { format: field.format } : {}),
          ...(field.readOnly ? { readOnly: field.readOnly } : {}),
        };
        return Object.keys(info).length ? [[name, info]] : [];
      }),
    );
    const issues = nodeIssues(surface, node.id).map(({ field, message }) => ({
      ...(field ? { field } : {}),
      message,
    }));
    const kids = children(surface, node.id);
    return {
      at,
      title: node.title,
      revision: surface.revision(),
      ...(node.summary ? { summary: node.summary } : {}),
      ...(Object.keys(fields).length
        ? {
            fields: Object.fromEntries(
              Object.entries(fields).map(([name, field]) => [
                name,
                project(surface, node, name, field),
              ]),
            ),
          }
        : {}),
      ...(Object.keys(about).length ? { about } : {}),
      ...(issues.length ? { issues } : {}),
      actions: actionsOf(node).map(([name, action]) => ({
        name,
        effect: action.effect,
        description: action.description,
        ...(action.input ? { input: jsonSchemaFromZod(action.input, 'input') } : {}),
      })),
      ...(kids.length ? { children: kids } : {}),
    };
  };

  const overview = () => ({
    surfaces: [...mounted.values()].map((surface) => {
      const issues = surface.issues?.() ?? [];
      return {
        at: surface.id,
        title: surface.title,
        revision: surface.revision(),
        summary: surface.summary(),
        ...(issues.length ? { issues: issues.length } : {}),
        nodes: surface
          .nodes()
          .filter((node) => node.id)
          .slice(0, NODE_LIST_CAP)
          .map((node) => {
            const count = issues.filter((issue) => issue.node === node.id).length;
            return {
              at: address(surface, node.id),
              title: node.title,
              ...(node.parent ? { parent: address(surface, node.parent) } : {}),
              ...(count ? { issues: count } : {}),
            };
          }),
      };
    }),
    ...([...declared.keys()].some((id) => !mounted.has(id))
      ? {
          closed: [...declared]
            .filter(([id]) => !mounted.has(id))
            .map(([id, title]) => ({ at: id, title, note: 'Look or act on it to open it.' })),
        }
      : {}),
  });

  const waitForMount = (id: string, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (mounted.has(id)) {
        resolve(true);
        return;
      }
      const check = () => {
        if (!mounted.has(id)) return;
        clearTimeout(timer);
        mountWaiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        mountWaiters.delete(check);
        resolve(false);
      }, ms);
      mountWaiters.add(check);
    });

  /** The node `at` names, opening its surface first when it is declared but not mounted. */
  const resolve = async (at: string): Promise<Target | { refused: string }> => {
    const slash = at.indexOf('/');
    const surfaceId = slash < 0 ? at : at.slice(0, slash);
    const nodeId = slash < 0 ? '' : at.slice(slash + 1);
    if (!mounted.has(surfaceId)) {
      if (!declared.has(surfaceId) || !options.open) {
        return { refused: `Nothing called ${surfaceId} is open. Look to see what is.` };
      }
      options.open(surfaceId);
      if (!(await waitForMount(surfaceId, options.mountWaitMs ?? MOUNT_WAIT_MS))) {
        return { refused: `${surfaceId} did not open. Look to see where the person is.` };
      }
    }
    const surface = mounted.get(surfaceId);
    const node = surface?.nodes().find((candidate) => candidate.id === nodeId);
    if (!surface || !node) {
      return { refused: `No ${at} here. Look at ${surfaceId} for what is.` };
    }
    return { surface, node, at: address(surface, node.id) };
  };

  const changedSince = (surface: Surface, revision: number) => [
    ...new Set(
      (surface.changesSince?.(revision) ?? []).flatMap((change) =>
        change.nodes.map((id) => address(surface, id)),
      ),
    ),
  ];

  const look = async (args: unknown) => {
    const parsed = lookArgs.safeParse(args ?? {});
    if (!parsed.success) return { status: 'refused', why: 'at must be text' };
    if (!parsed.data.at) return overview();
    const target = await resolve(parsed.data.at);
    if ('refused' in target) return { status: 'refused', why: target.refused };
    return nodeView(target);
  };

  const runBuiltIn = (
    target: Target,
    name: 'set' | 'point',
    input: Record<string, unknown>,
    ctx: SurfaceActionContext,
  ): SurfaceActionOutcome => {
    const { node } = target;
    if (name === 'point') {
      const field = typeof input.field === 'string' ? input.field : undefined;
      node.point?.(field);
      return { result: { shown: field ? `${target.at}.${field}` : target.at } };
    }
    const fields = node.fields?.() ?? {};
    const rejected: SurfaceRejection[] = [];
    const allowed: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(input.changes as Record<string, unknown>)) {
      const field = fields[path.split('.', 1)[0] ?? path];
      if (!field)
        rejected.push({ field: path, why: 'no such field; look at the node for its fields' });
      else if (field.format === 'secret') {
        rejected.push({
          field: path,
          why: 'only the person enters this: act point on it, then ask them to type it in',
        });
      } else if (field.readOnly) rejected.push({ field: path, why: field.readOnly });
      else allowed[path] = value;
    }
    if (Object.keys(allowed).length && node.set) {
      rejected.push(...node.set(allowed, ctx).rejected);
    }
    return { rejected, node: node.id };
  };

  const act = async (args: unknown, callId: string) => {
    const seen = ledger.find((entry) => entry.callId === callId);
    if (seen) return seen.result;
    const parsed = actArgs.safeParse(args ?? {});
    if (!parsed.success) {
      return { status: 'refused', why: 'Bad call.', rejected: rejectionsFrom(parsed.error) };
    }
    const { at, action: name, basedOn, intent } = parsed.data;
    const target = await resolve(at);
    if ('refused' in target) return { status: 'refused', why: target.refused };
    const { surface, node } = target;
    const action = actionsOf(node).find(([candidate]) => candidate === name)?.[1];
    if (!action) {
      return {
        status: 'refused',
        why: `${target.at} has no ${name}. It has: ${actionsOf(node)
          .map(([candidate]) => candidate)
          .join(', ')}.`,
      };
    }
    const checked = action.input
      ? action.input.safeParse(parsed.data.input ?? {})
      : { success: true as const, data: parsed.data.input ?? {} };
    if (!checked.success) {
      return { status: 'refused', why: 'Bad input.', rejected: rejectionsFrom(checked.error) };
    }
    const write = action.effect === 'write';
    if (write && basedOn === undefined) {
      return {
        status: 'refused',
        why: 'Pass basedOn: the revision from your last look.',
        revision: surface.revision(),
      };
    }
    if (write && action.intent && intent) {
      const repeat = ledger.find(
        (entry) =>
          entry.intent === intent &&
          entry.at === target.at &&
          now() - entry.time < INTENT_WINDOW_MS,
      );
      if (repeat) return repeat.result;
    }
    let result: unknown;
    let applied = false;
    if (write && basedOn !== surface.revision()) {
      result = {
        status: 'stale',
        why: 'The page changed since your look; nothing applied. Look again.',
        revision: surface.revision(),
        changed: changedSince(surface, basedOn ?? 0),
      };
    } else {
      const before = surface.revision();
      const ctx: SurfaceActionContext = { callId, by: 'agent' };
      try {
        const own = node.actions?.[name];
        const outcome =
          name in BUILT_IN && !own
            ? runBuiltIn(
                target,
                name as 'set' | 'point',
                checked.data as Record<string, unknown>,
                ctx,
              )
            : await (own as SurfaceAction<never>).run(checked.data as never, ctx);
        const after = surface.revision();
        applied = after !== before;
        const landed =
          outcome.node === undefined ? undefined : await resolve(address(surface, outcome.node));
        const issues = surface.issues?.() ?? [];
        result = {
          status: write ? (applied ? 'applied' : 'unchanged') : 'done',
          revision: after,
          ...(applied ? { changed: changedSince(surface, before) } : {}),
          ...(outcome.rejected?.length ? { rejected: outcome.rejected } : {}),
          ...(outcome.result === undefined ? {} : { result: outcome.result }),
          ...(landed && !('refused' in landed) ? { node: nodeView(landed) } : {}),
          ...(write ? { issues: issues.length } : {}),
        };
      } catch (err) {
        result = { status: 'failed', why: errorText(err), revision: surface.revision() };
      }
    }
    const scrubbed = scrubDeep(result, known());
    remember({
      callId,
      at: target.at,
      action: name,
      ...(intent ? { intent } : {}),
      applied,
      result: scrubbed,
      time: now(),
    });
    return scrubbed;
  };

  return {
    mount(surface) {
      mounted.set(surface.id, surface);
      for (const waiter of [...mountWaiters]) waiter();
      let seen = surface.revision();
      const titles = () => new Map(surface.nodes().map((node) => [node.id, node.title]));
      const stop = surface.subscribe?.(() => {
        const changes = surface.changesSince?.(seen) ?? [];
        seen = surface.revision();
        const nodes = [
          ...new Set(changes.filter((change) => change.by === 'person').flatMap((c) => c.nodes)),
        ];
        if (nodes.length === 0) return;
        const named = titles();
        const what = nodes.map((id) => named.get(id) ?? (id || surface.title)).join(', ');
        const count = surface.issues?.().length ?? 0;
        note(`${surface.id} r${String(seen)}: the person changed ${what}; ${issueCount(count)}`);
      });
      return () => {
        stop?.();
        if (mounted.get(surface.id) === surface) mounted.delete(surface.id);
      };
    },

    declare(id, title) {
      declared.set(id, title);
    },

    isSurfaceTool(name) {
      return (SURFACE_TOOL_NAMES as readonly string[]).includes(name);
    },

    async answer(tool, args, callId) {
      try {
        if (tool === 'look') return scrubDeep(await look(args), known());
        if (tool === 'act') return await act(args, callId);
        return { status: 'refused', why: `${tool} is not a surface tool.` };
      } catch (err) {
        return scrubDeep({ status: 'failed', why: errorText(err) }, known());
      }
    },

    settled(callId, how) {
      const entry = ledger.find((candidate) => candidate.callId === callId);
      if (!entry?.applied) return;
      note(
        `${entry.at} ${entry.action} applied, but ${
          how === 'cancelled' ? 'the call was cancelled after' : 'its answer never reached you'
        }`,
      );
    },

    stateLine() {
      const surfaces = [...mounted.values()].map(
        (surface) => `${surface.id} r${String(surface.revision())}: ${surface.summary()}`,
      );
      const recent = ledger
        .slice(-RECENT_IN_STATE)
        .map((entry) => `${entry.at} ${entry.action}`)
        .join(', ');
      if (!surfaces.length && !recent) return null;
      const line = [surfaces.join('; '), recent ? `last calls: ${recent}` : ''].filter(Boolean);
      return scrubDeep(`(state) ${line.join('; ')}`, known()) as string;
    },
  };
}

export type { SurfaceIssue };
