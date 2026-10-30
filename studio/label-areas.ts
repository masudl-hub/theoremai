import { HOST_LABEL_KEYS, LABEL_KEYS, type LabelKey } from '@theoremjs/agents/guardrails';

/** Who reads a line: the visitor, in the chat, or the model, in its context. */
export type LabelAudience = 'visitor' | 'model';

/** A labels area: the keys under one prefix, on the studio's Labels page. */
export type LabelArea = {
  prefix: string;
  title: string;
  note: string;
  audience: LabelAudience;
};

/** Labels' areas, by labels key prefix: what visitors read first, then what the model reads. */
export const LABEL_AREAS = [
  {
    prefix: 'error',
    title: 'Errors',
    note: 'When a turn fails.',
    audience: 'visitor',
  },
  {
    prefix: 'attachments',
    title: 'Attachments',
    note: "When a file can't be sent.",
    audience: 'visitor',
  },
  {
    prefix: 'voice',
    title: 'Voice',
    note: "When a voice note can't be recorded or used.",
    audience: 'visitor',
  },
  {
    prefix: 'session',
    title: 'Session',
    note: 'Waits, approvals, and signing in.',
    audience: 'visitor',
  },
  {
    prefix: 'stop',
    title: 'Stops',
    note: 'Why a reply ended short.',
    audience: 'visitor',
  },
  {
    prefix: 'composer',
    title: 'Composer',
    note: 'The model and effort pickers.',
    audience: 'visitor',
  },
  {
    prefix: 'detect.blocked',
    title: 'Blocked messages',
    note: "When a detector stops the visitor's message.",
    audience: 'visitor',
  },
  {
    prefix: 'thought',
    title: 'Thoughts',
    note: 'What stands in for what a thought leaves out.',
    audience: 'visitor',
  },
  {
    prefix: 'live',
    title: 'Live',
    note: 'When a live session ends.',
    audience: 'visitor',
  },
  {
    prefix: 'quota',
    title: 'Quota',
    note: 'When the daily limit is reached.',
    audience: 'visitor',
  },
  {
    prefix: 'tool',
    title: 'Tools',
    note: "When a tool call can't run.",
    audience: 'model',
  },
  {
    prefix: 'repair',
    title: 'Repair',
    note: 'Fixing a reply that failed its schema.',
    audience: 'model',
  },
  {
    prefix: 'egress',
    title: 'Egress',
    note: 'A reply that fails its check, sent back or refused.',
    audience: 'model',
  },
  {
    prefix: 'continue',
    title: 'Resumption',
    note: 'Picking up a reply that stopped short.',
    audience: 'model',
  },
  {
    prefix: 'canary',
    title: 'Canary',
    note: "The note that binds each turn's canary.",
    audience: 'model',
  },
  {
    prefix: 'taint',
    title: 'Untrusted content',
    note: 'Why a tool call was refused after reading it.',
    audience: 'model',
  },
  {
    prefix: 'advisory',
    title: 'Advisories',
    note: 'Notes beside content that tries to direct it.',
    audience: 'model',
  },
  {
    prefix: 'detect',
    title: 'Detectors',
    note: 'When a detector stops a call or a result, and what it asks the model to leave out.',
    audience: 'model',
  },
  {
    prefix: 'sign_in',
    title: 'Sign-in',
    note: 'Where a tool waits for the person to sign in to a service.',
    audience: 'model',
  },
  {
    prefix: 'user_data',
    title: 'User data',
    note: "The note on the fence around the user's message.",
    audience: 'model',
  },
  {
    prefix: 'context',
    title: 'Turn context',
    note: 'The note on the fence around what the app or the host adds.',
    audience: 'model',
  },
  {
    prefix: 'structured',
    title: 'Structured replies',
    note: 'Asking for the final answer as JSON or as an answer tool call.',
    audience: 'model',
  },
  {
    prefix: 'compaction',
    title: 'Compaction',
    note: 'Asking for the summary that replaces earlier turns.',
    audience: 'model',
  },
] as const satisfies readonly LabelArea[];

/** One of {@linkcode LABEL_AREAS}' prefixes. */
export type LabelAreaPrefix = (typeof LABEL_AREAS)[number]['prefix'];

/** The area a label key is under: the one with the longest prefix that holds it. */
export function labelAreaOf(key: string): (typeof LABEL_AREAS)[number] | undefined {
  let found: (typeof LABEL_AREAS)[number] | undefined;
  for (const area of LABEL_AREAS) {
    const holds = key === area.prefix || key.startsWith(`${area.prefix}.`);
    if (holds && (!found || area.prefix.length > found.prefix.length)) found = area;
  }
  return found;
}

/** The keys a profile's `labels` can change, which the Labels page shows. */
export const PROFILE_LABEL_KEYS: readonly LabelKey[] = LABEL_KEYS.filter(
  (key) => !HOST_LABEL_KEYS.includes(key),
);
