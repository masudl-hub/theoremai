import { z } from 'zod';
import type { ToolDefinitionInput } from '../kernel/tools/types.ts';

const answer = z.record(z.string(), z.unknown());

const lookInput = z.object({
  at: z
    .string()
    .optional()
    .describe(
      'A surface ("playground") or a node in one ("playground/identity"); leave out to see every surface',
    ),
});

const actInput = z.object({
  at: z.string().describe('The node to act on, as look names it'),
  action: z.string().describe('One of the actions look lists for that node'),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The action's input, per its schema"),
  basedOn: z
    .number()
    .int()
    .optional()
    .describe(
      'For a write: the revision from your last look. If the page changed since, nothing applies.',
    ),
  intent: z
    .string()
    .optional()
    .describe(
      'A short key for what the person asked ("image-agent"), so a repeat of a starting-over action applies once',
    ),
});

/** Options for `surfaceTools`: the category the tools are registered under, `surface` by default. */
export interface SurfaceToolsOptions {
  category?: string;
}

/** `look` and `act`: the two tools an agent uses to see and work in every surface a client mounts. */
export function surfaceTools(options: SurfaceToolsOptions = {}): ToolDefinitionInput[] {
  const base = {
    type: 'function' as const,
    category: options.category ?? 'surface',
    paths: ['*'],
    loadTier: 'T0' as const,
    permission: 'auto' as const,
    output: answer,
    answeredBy: 'page' as const,
  };
  return [
    {
      ...base,
      name: 'look',
      description:
        "See what is on the person's screen. With no `at`: every surface, its revision, summary, nodes and issue counts. With `at`: that node's fields (secrets only as cards: set, what it looks like, problems), what each means, its issues, its actions with their input schemas, and its children.",
      access: 'read-only',
      input: lookInput,
    },
    {
      ...base,
      name: 'act',
      description:
        "Do one of a node's actions: `set` fields, `point` the person at something, or the node's own (test, send, launch…). Comes back applied, unchanged, done, stale (the page changed: look again), refused or failed, with what was rejected and why.",
      access: 'read-write',
      input: actInput,
    },
  ];
}

/** How to use `look` and `act`, for an agent's instructions. */
export const SURFACE_PROMPT = `You see and work in the person's screen through surfaces, with two tools.
- look: no \`at\` lists every surface. Look at a node before you act on it.
- act: do one of the actions look lists. Pass basedOn (the revision from your last look) for writes.
- Say a change is done only when act comes back applied. If it lists rejected fields, say which and why.
- stale means the person changed something: look again, then go on. After refused or failed, look before retrying; never retry blind.
- Secrets (keys, tokens, passwords) show only as cards: set or not, what they look like, their problems. You never see or type the value. To have the person enter one, act point on it and ask them to paste it. To find out whether it works, use the node's test action.
- When something isn't working, look for issues, test what can be tested, and tell the person what you found in plain words.
- A line starting "(state)" is a silent note about what changed on the page. It is background; never read it out. If it says something you did applied late or was cancelled, tell the person once, in a few words.`;
