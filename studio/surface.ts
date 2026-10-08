/**
 * The studio as a surface: the draft's sections as nodes an agent can look at and set, its
 * key slots as secret nodes it can point at and test, and the page's own actions (a new agent,
 * a try in the preview, launch, export). The page supplies a host; the runtime does the rest.
 */
import { fieldMeta, profileGraphFacet } from '../src/kernel/schema.ts';
import type { TranscriptBlock } from '../src/interface/mod.ts';
import { secretCard } from '../src/surface/formats.ts';
import {
  defineAction,
  type Surface,
  type SurfaceAction,
  type SurfaceActionOutcome,
  type SurfaceAuthor,
  type SurfaceField,
  type SurfaceFieldFormat,
  type SurfaceIssue,
  type SurfaceNode,
  type SurfaceRejection,
} from '../src/surface/types.ts';
import { z } from 'zod';
import { compileStudio } from './compile.ts';
import {
  createBlankDraft,
  defaultModelBinding,
  defaultToolSpec,
  draftFacets,
  excludeFacet,
  includableFacets,
  includeFacet,
  newModelBinding,
  newToolSpec,
  STUDIO_PROFILE_TYPES,
  type StudioDraft,
  type StudioProfileType,
  removeModelBinding,
  setProfileType,
  updateModelBinding,
} from './draft.ts';
import {
  createConsoleExampleDraft,
  createDecisionExampleDraft,
  createExampleDraft,
  createLiveExampleDraft,
  createNarratorExampleDraft,
} from './example.ts';
import { type StudioConnectionMode, modelBindingViolation } from './policy.ts';
import { studioNodeRef, studioTree, type StudioTreeNode } from './tree.ts';

export type StudioExportFormat = 'zip' | 'copy' | 'llm';

/** One change to the draft: the top-level draft keys it touched, and who made it. */
export interface StudioDraftChange {
  revision: number;
  by: SurfaceAuthor;
  sections: readonly string[];
}

/** What the surface needs from the page; the route supplies it, a test fakes it. */
export interface StudioSurfaceHost {
  getDraft(): StudioDraft;
  getRevision(): number;
  getMode(): StudioConnectionMode;
  /** Replaces the draft as the agent's edit: the revision moves, and the person's undo stays. */
  update(next: StudioDraft): void;
  /** A whole new agent: draft, selection and conversation start over, with an Undo. */
  replaceDraft(next: StudioDraft, message: string): void;
  /** Selects a section in the editor, focusing one field when named. */
  select(nodeId: string, field?: string): void;
  changesSince(revision: number): readonly StudioDraftChange[];
  subscribe(listener: () => void): () => void;
  /** The key in a vault slot, `''` when empty. Read per answer and never kept. */
  key(slot: string): string;
  /** Opens the keys panel, on one slot when named. */
  openKeys(slot?: string): void;
  /** Tries the key in a slot against its provider; what it found, with no key in it. */
  testKey?(slot: string): Promise<unknown>;
  /** The credential typed into a tool's test, `''` when none. In memory only, never saved. */
  toolCredential?(key: string): string;
  /** Calls a custom tool once with sample input (and its test credential); what came back. */
  testTool?(key: string, input?: unknown): Promise<unknown>;
  /** Sends into the preview and waits for the reply; `null` when it can't take a message. */
  send(text: string): Promise<{ blocks: readonly TranscriptBlock[] } | null>;
  newConversation(): void;
  launch(): void;
  exportAgent(format: StudioExportFormat): Promise<boolean>;
}

const SEND_CAP_MS = 60_000;
const KEY_NODE = 'key:';

const FACET_KEY: Record<string, keyof StudioDraft> = {
  identity: 'identity',
  models: 'models',
  tools: 'tools',
  inputs: 'inputs',
  outputs: 'outputs',
  turnBehaviour: 'turnBehaviour',
  guardrails: 'guardrails',
  observability: 'observability',
  image: 'image',
  speech: 'speech',
  live: 'live',
  decision: 'decision',
  wording: 'wording',
};

/** Draft keys a change touched, as the nodes an agent knows. */
const SECTION_NODE: Record<string, string> = {
  modelBindings: 'models',
  toolSpecs: 'tools',
  included: '',
};

const BLOCKED_FIELDS: Record<string, string> = {
  'identity.profileType': 'act setType on the studio',
  'modelBinding.key': 'a model keeps its own key',
  'toolSpec.key': 'a tool keeps its own key',
  'image.references': 'pinned images are added by the person',
};

/** How a tool's settings leave the page. */
const TOOL_FORMATS: Record<string, SurfaceFieldFormat> = {
  endpoint: 'url',
  serverUrl: 'url',
  authRedirectUri: 'url',
  headersJson: 'headers',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const facetOf = (nodeId: string) => nodeId.split(':', 1)[0] ?? nodeId;

/** The optional sections a type brings that the old one lacked, switched on. */
function withNewSections(before: StudioDraft, after: StudioDraft): StudioDraft {
  const had = new Set(includableFacets(before));
  return includableFacets(after)
    .filter((facet) => !had.has(facet))
    .reduce(includeFacet, after);
}

/** A node's own values, which `set` can change. */
function nodeValues(draft: StudioDraft, nodeId: string): Record<string, unknown> | undefined {
  const ref = studioNodeRef(draft, nodeId);
  if (!ref) return undefined;
  if (ref.facet === 'modelBinding') {
    return { ...draft.modelBindings.find((binding) => binding.key === ref.key) };
  }
  if (ref.facet === 'toolSpec') return { ...draft.toolSpecs.find((tool) => tool.key === ref.key) };
  return { ...(draft[FACET_KEY[ref.facet] ?? 'identity'] as unknown as Record<string, unknown>) };
}

/** Where a value may be set: its kind must match the one there; a number field may also be null. */
function kindProblem(current: unknown, blank: unknown, value: unknown): string | undefined {
  if (value === null) return current === null || blank === null ? undefined : 'cannot be empty';
  if (current === null || current === undefined) {
    return isRecord(value) ? 'must be a single value' : undefined;
  }
  if (Array.isArray(current)) return Array.isArray(value) ? undefined : 'must be a list';
  if (isRecord(current)) return 'is a group; set its fields one by one, like "include.usage"';
  return typeof current === typeof value ? undefined : `must be ${typeof current}`;
}

function setAtPath(
  target: Record<string, unknown>,
  blank: Record<string, unknown> | undefined,
  path: string,
  value: unknown,
): { next: Record<string, unknown> } | { why: string } {
  const [head = '', ...rest] = path.split('.');
  if (!Object.hasOwn(target, head)) return { why: 'no such setting' };
  if (rest.length === 0) {
    const problem = kindProblem(target[head], blank?.[head], value);
    return problem ? { why: problem } : { next: { ...target, [head]: value } };
  }
  const inner = target[head];
  if (!isRecord(inner)) return { why: 'no such setting' };
  const innerBlank = blank?.[head];
  const set = setAtPath(inner, isRecord(innerBlank) ? innerBlank : undefined, rest.join('.'), value);
  return 'why' in set ? set : { next: { ...target, [head]: set.next } };
}

function editNode(
  draft: StudioDraft,
  nodeId: string,
  changes: Record<string, unknown>,
): { next: StudioDraft; rejected: SurfaceRejection[] } {
  const ref = studioNodeRef(draft, nodeId);
  const rejected: SurfaceRejection[] = [];
  if (!ref) return { next: draft, rejected };
  const facet = ref.facet;
  let current = nodeValues(draft, nodeId) ?? {};
  const blank: Record<string, unknown> | undefined =
    facet === 'modelBinding'
      ? { ...defaultModelBinding() }
      : facet === 'toolSpec'
        ? { ...defaultToolSpec() }
        : (createBlankDraft()[FACET_KEY[facet] ?? 'identity'] as unknown as
            | Record<string, unknown>
            | undefined);
  for (const [path, value] of Object.entries(changes)) {
    const blocked = BLOCKED_FIELDS[`${facet}.${path}`];
    if (blocked) {
      rejected.push({ field: path, why: blocked });
      continue;
    }
    if (facet === 'wording') {
      if (!fieldMeta(`lexicon.${path}`)) rejected.push({ field: path, why: 'no such line' });
      else if (typeof value !== 'string') rejected.push({ field: path, why: 'must be text' });
      else current = { ...current, [path]: value };
      continue;
    }
    const set = setAtPath(current, blank, path, value);
    if ('why' in set) rejected.push({ field: path, why: set.why });
    else current = set.next;
  }
  if (rejected.length === Object.keys(changes).length) return { next: draft, rejected };
  if (ref.facet === 'modelBinding') {
    const { key: _key, ...rest } = current;
    return { next: updateModelBinding(draft, ref.key, rest), rejected };
  }
  if (ref.facet === 'toolSpec') {
    return {
      next: {
        ...draft,
        toolSpecs: draft.toolSpecs.map((tool) =>
          tool.key === ref.key ? { ...tool, ...current } : tool,
        ),
      },
      rejected,
    };
  }
  return { next: { ...draft, [FACET_KEY[ref.facet] ?? 'identity']: current }, rejected };
}

function describeReply(blocks: readonly TranscriptBlock[]) {
  const reply: string[] = [];
  const media: { mimeType: string }[] = [];
  const tools: { name: string; state?: string }[] = [];
  const errors: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') reply.push(block.text);
    else if (block.kind === 'structured') reply.push(JSON.stringify(block.value));
    else if (block.kind === 'media') media.push({ mimeType: block.mimeType });
    else if (block.kind === 'tool') tools.push({ name: block.tool.name, state: block.tool.state?.phase });
    else if (block.kind === 'error') errors.push(block.message);
  }
  return { reply: reply.join('\n'), media, tools, errors };
}

/** Each key slot the draft uses, and what uses it. */
function keySlots(draft: StudioDraft): Map<string, string[]> {
  const slots = new Map<string, string[]>();
  const use = (slot: string | undefined, by: string) => {
    if (!slot) return;
    slots.set(slot, [...(slots.get(slot) ?? []), by]);
  };
  use(draft.models.key, 'every model, by default');
  use(draft.models.fallbackKey, 'every model, as fallback');
  for (const binding of draft.modelBindings) {
    const name = binding.modelId || 'a model';
    use(binding.keySlot, `model ${name}`);
    use(binding.fallbackKeySlot, `model ${name}, as fallback`);
  }
  for (const tool of draft.toolSpecs) use(tool.authSlot, `tool ${tool.toolName || 'unnamed'}`);
  return slots;
}

const typeInput = z.enum(STUDIO_PROFILE_TYPES as unknown as [StudioProfileType]);

/** The worked examples one draft holds. The code architect is two agents, so the page loads it. */
const EXAMPLE_DRAFTS = {
  travel: createExampleDraft,
  live: createLiveExampleDraft,
  narrator: createNarratorExampleDraft,
  console: createConsoleExampleDraft,
  decision: createDecisionExampleDraft,
} satisfies Record<string, () => StudioDraft>;

const exampleInput = z.enum(Object.keys(EXAMPLE_DRAFTS) as [keyof typeof EXAMPLE_DRAFTS]);

/** The studio's surface, over a host the page (or a test) provides. */
export function studioSurface(host: StudioSurfaceHost): Surface {
  const draft = () => host.getDraft();
  const revision = () => host.getRevision();

  const compileIssues = () => {
    const compiled = compileStudio(draft(), host.getMode());
    return compiled.ok ? [] : compiled.issues;
  };

  const keyIssues = (): SurfaceIssue[] =>
    [...keySlots(draft())].flatMap(([slot]): SurfaceIssue[] => {
      const card = secretCard(host.key(slot));
      if (!card.set) {
        return [{ node: `${KEY_NODE}${slot}`, field: 'value', message: `No key in ${slot}` }];
      }
      return card.problems.length
        ? [{ node: `${KEY_NODE}${slot}`, field: 'value', message: `The key has ${card.problems.join(', ')}` }]
        : [];
    });

  const issues = (): SurfaceIssue[] => [
    ...compileIssues().map(({ nodeId, field, message }) => ({
      node: nodeId,
      ...(field ? { field } : {}),
      message,
    })),
    ...keyIssues(),
  ];

  /** Selects a node so the person sees what the agent changed. */
  const apply = (next: StudioDraft, nodeId?: string) => {
    if (next !== draft()) host.update(next);
    if (nodeId && studioNodeRef(draft(), nodeId)) host.select(nodeId);
  };

  const refuse = (field: string, why: string): SurfaceActionOutcome => ({ rejected: [{ field, why }] });

  const blocked = (): SurfaceActionOutcome | undefined => {
    const found = compileIssues();
    return found.length
      ? { result: { ok: false, why: `${String(found.length)} issues to fix first; look at the studio` } }
      : undefined;
  };

  const rootActions: Record<string, SurfaceAction<never>> = {
    newAgent: defineAction({
      description:
        'Start a new agent, replacing the draft (the person can undo). Ask first if they changed the current one.',
      effect: 'write',
      intent: true,
      input: z.object({
        type: typeInput.describe('The agent type'),
        example: exampleInput.optional().describe('Start from a worked example'),
      }),
      run: ({ type, example }) => {
        const blank = createBlankDraft();
        const next = example ? EXAMPLE_DRAFTS[example]() : withNewSections(blank, setProfileType(blank, type));
        host.replaceDraft(next, 'th30 started a new agent.');
        return { node: 'identity' };
      },
    }),
    setType: defineAction({
      description: "Change the agent's type; sections the new type adds are turned on.",
      effect: 'write',
      input: z.object({ type: typeInput }),
      run: ({ type }) => {
        const before = draft();
        apply(withNewSections(before, setProfileType(before, type)), 'identity');
        return { node: 'identity' };
      },
    }),
    include: defineAction({
      description: 'Turn on an optional section.',
      effect: 'write',
      input: z.object({ section: z.string() }),
      run: ({ section }) => {
        const can = includableFacets(draft()) as string[];
        if (!profileGraphFacet(section as never) || !can.includes(section)) {
          return refuse('section', `can add: ${can.join(', ') || 'nothing for this type'}`);
        }
        apply(includeFacet(draft(), section as never), section);
        return { node: section };
      },
    }),
    exclude: defineAction({
      description: 'Turn off an optional section.',
      effect: 'write',
      input: z.object({ section: z.string() }),
      run: ({ section }) => {
        const has = draft().included as string[];
        if (!has.includes(section)) return refuse('section', `can remove: ${has.join(', ') || 'nothing'}`);
        apply(excludeFacet(draft(), section as never));
        return {};
      },
    }),
    addModel: defineAction({
      description: 'Add a model; the first becomes the default.',
      effect: 'write',
      input: z.object({
        modelId: z.string().optional().describe('Your name for it'),
        provider: z.string().optional(),
        apiId: z.string().optional().describe("The provider's model id"),
      }),
      run: (input) => {
        const current = draft();
        if (!current.identity.profileType) return refuse('type', 'act setType first');
        const binding = {
          ...newModelBinding(current),
          ...Object.fromEntries(Object.entries(input).filter(([, value]) => value)),
        } as ReturnType<typeof newModelBinding>;
        const node = `modelBinding:${binding.key}`;
        apply(
          {
            ...current,
            models: { ...current.models, defaultModel: current.models.defaultModel || binding.modelId },
            modelBindings: [...current.modelBindings, binding],
          },
          node,
        );
        const violation = modelBindingViolation(binding, host.getMode());
        return {
          node,
          rejected: violation ? [{ field: violation.field, why: violation.message }] : [],
        };
      },
    }),
    addTool: defineAction({
      description: 'Add a custom tool.',
      effect: 'write',
      input: z.object({ toolName: z.string().optional(), description: z.string().optional() }),
      run: ({ toolName, description }) => {
        const current = draft();
        if (!current.identity.profileType) return refuse('type', 'act setType first');
        if (!(draftFacets(current) as string[]).includes('tools')) {
          return refuse('tools', 'this agent type takes no tools');
        }
        const spec = {
          ...newToolSpec(current),
          ...(toolName ? { toolName } : {}),
          ...(description ? { description } : {}),
        };
        const node = `toolSpec:${spec.key}`;
        apply({ ...current, toolSpecs: [...current.toolSpecs, spec] }, node);
        return { node };
      },
    }),
    try: defineAction({
      description:
        "Send a message to the agent in the preview and read its reply. It runs on the person's keys.",
      effect: 'run',
      input: z.object({ message: z.string().min(1) }),
      run: async ({ message }) => {
        const stop = blocked();
        if (stop) return stop;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), SEND_CAP_MS);
        });
        const result = await Promise.race([host.send(message), timeout]);
        clearTimeout(timer);
        if (result === 'timeout') {
          return { result: { sent: true, note: 'Still running; the reply will show in the preview.' } };
        }
        if (!result) {
          return {
            result: {
              sent: false,
              why: 'The preview cannot take a message: it is busy, or a key is missing. Look at the key nodes.',
            },
          };
        }
        return { result: { sent: true, ...describeReply(result.blocks) } };
      },
    }),
    newConversation: defineAction({
      description: 'Clear the preview conversation.',
      effect: 'run',
      run: () => {
        host.newConversation();
        return { result: { cleared: true } };
      },
    }),
    launch: defineAction({
      description: 'Open the agent on its own page in a new tab.',
      effect: 'run',
      run: () => {
        const stop = blocked();
        if (stop) return stop;
        host.launch();
        return { result: { launched: true } };
      },
    }),
    export: defineAction({
      description:
        'Download every agent as a .zip of source files, copy the files, or copy them with a brief for an LLM.',
      effect: 'run',
      input: z.object({ format: z.enum(['zip', 'copy', 'llm']) }),
      run: async ({ format }) => {
        const stop = blocked();
        if (stop) return stop;
        return { result: { done: await host.exportAgent(format), format } };
      },
    }),
  };

  /** A tool that sends a credential gets the one typed into its test, as a secret. */
  const credentialField = (nodeId: string): Record<string, SurfaceField> => {
    const ref = studioNodeRef(draft(), nodeId);
    if (ref?.facet !== 'toolSpec' || !host.toolCredential) return {};
    const tool = draft().toolSpecs.find((candidate) => candidate.key === ref.key);
    if (!tool || (tool.authType ?? 'none') === 'none') return {};
    return {
      credential: {
        value: host.toolCredential(ref.key),
        format: 'secret',
        doc: "The credential the person typed into this tool's test. Used for tests only, never saved.",
        usedBy: [`tool ${tool.toolName || 'unnamed'}, when tested`],
      },
    };
  };

  const sectionFields = (nodeId: string): Record<string, SurfaceField> => {
    const values = nodeValues(draft(), nodeId) ?? {};
    const facet = facetOf(nodeId);
    const fields = Object.fromEntries(
      Object.entries(values).map(([name, value]) => {
        const meta = fieldMeta(facet === 'wording' ? `lexicon.${name}` : `${facet}.${name}`);
        const why = BLOCKED_FIELDS[`${facet}.${name}`];
        const format = facet === 'toolSpec' ? TOOL_FORMATS[name] : undefined;
        return [
          name,
          {
            value,
            ...(meta ? { type: meta.type, doc: meta.doc } : {}),
            ...(meta?.options ? { options: meta.options } : {}),
            ...(format ? { format } : {}),
            ...(why ? { readOnly: why } : {}),
          },
        ];
      }),
    );
    return { ...fields, ...credentialField(nodeId) };
  };

  const sectionNode = (tree: StudioTreeNode, parent: string): SurfaceNode => {
    const id = tree.id;
    const facet = facetOf(id);
    const own: Record<string, SurfaceAction<never>> = {};
    if (facet === 'modelBinding') {
      own.remove = defineAction({
        description: 'Remove this model.',
        effect: 'write',
        run: () => {
          const ref = studioNodeRef(draft(), id);
          if (ref?.facet !== 'modelBinding') return refuse('at', 'gone already');
          apply(removeModelBinding(draft(), ref.key), 'models');
          return { node: 'models' };
        },
      });
    }
    if (facet === 'toolSpec') {
      const key = id.slice('toolSpec:'.length);
      own.remove = defineAction({
        description: 'Remove this tool.',
        effect: 'write',
        run: () => {
          apply({ ...draft(), toolSpecs: draft().toolSpecs.filter((tool) => tool.key !== key) }, 'tools');
          return { node: 'tools' };
        },
      });
      const testTool = host.testTool;
      if (testTool) {
        own.test = defineAction({
          description:
            'Call this tool once for real, with sample input (or yours), and see what came back: status, errors, the reply.',
          effect: 'run',
          input: z.object({ input: z.record(z.string(), z.unknown()).optional() }),
          run: async ({ input }) => ({ result: await testTool(key, input) }),
        });
      }
    }
    return {
      id,
      title: tree.label,
      parent,
      fields: () => sectionFields(id),
      set: (changes) => {
        const before = draft();
        if (!studioNodeRef(before, id)) return { rejected: [{ field: 'at', why: 'gone' }] };
        const { next, rejected } = editNode(before, id, changes);
        apply(next, id);
        if (facet === 'modelBinding') {
          const binding = draft().modelBindings.find((candidate) => id === `modelBinding:${candidate.key}`);
          const violation = binding ? modelBindingViolation(binding, host.getMode()) : null;
          if (violation) rejected.push({ field: violation.field, why: violation.message });
        }
        return { rejected };
      },
      point: (field) => host.select(id, field),
      ...(Object.keys(own).length ? { actions: own } : {}),
    };
  };

  const keyNode = (slot: string, usedBy: string[]): SurfaceNode => {
    const testKey = host.testKey;
    return {
      id: `${KEY_NODE}${slot}`,
      title: `Key ${slot}`,
      parent: 'models',
      summary: `Used by ${usedBy.join('; ')}`,
      fields: () => ({
        value: {
          value: host.key(slot),
          format: 'secret',
          doc: 'An API key the person pastes into the Keys panel. Kept only in this tab.',
          usedBy,
        },
      }),
      point: () => host.openKeys(slot),
      ...(testKey
        ? {
            actions: {
              test: defineAction({
                description: "Ask the key's provider whether it accepts the key.",
                effect: 'run',
                run: async () => ({ result: await testKey(slot) }),
              }),
            },
          }
        : {}),
    };
  };

  const nodes = (): SurfaceNode[] => {
    const current = draft();
    const tree = studioTree(current);
    const found: SurfaceNode[] = [
      {
        id: '',
        title: 'Studio',
        summary: 'The agent the person is building, its sections, keys and preview.',
        fields: () => ({
          type: {
            value: draft().identity.profileType || null,
            options: STUDIO_PROFILE_TYPES,
            readOnly: 'act setType',
          },
          canAdd: { value: includableFacets(draft()), readOnly: 'act include' },
          included: { value: draft().included, readOnly: 'act exclude' },
        }),
        actions: rootActions,
      },
      sectionNode(tree, ''),
    ];
    const walk = (node: StudioTreeNode, parent: string) => {
      found.push(sectionNode(node, parent));
      for (const child of node.children) walk(child, node.id);
    };
    for (const child of tree.children) walk(child, '');
    for (const [slot, usedBy] of keySlots(current)) found.push(keyNode(slot, usedBy));
    return found;
  };

  return {
    id: 'studio',
    title: 'Studio',
    revision,
    summary: () => {
      const current = draft();
      const count = issues().length;
      return `${current.identity.profileType || 'no type'} agent ${current.identity.handle || current.identity.agentId || 'unnamed'}; ${String(count)} ${count === 1 ? 'issue' : 'issues'}`;
    },
    nodes,
    issues,
    changesSince: (since) =>
      host.changesSince(since).map((change) => ({
        revision: change.revision,
        by: change.by,
        nodes: [...new Set(change.sections.map((section) => SECTION_NODE[section] ?? section))],
      })),
    subscribe: (listener) => host.subscribe(listener),
    secrets: () => ({
      ...Object.fromEntries([...keySlots(draft()).keys()].map((slot) => [`key ${slot}`, host.key(slot)])),
      ...Object.fromEntries(
        draft().toolSpecs.map((tool) => [
          `credential ${tool.toolName || tool.key}`,
          host.toolCredential?.(tool.key) ?? '',
        ]),
      ),
    }),
  };
}
