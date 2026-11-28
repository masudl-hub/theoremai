import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { IntlMessageFormat } from 'intl-messageformat';
import { backgroundJobs, toolCallLabel } from '../../react/src/client/transcript-groups.ts';
import { approvalHeading } from '../../react/src/ui/approval-heading.ts';
import {
  assertLabelOverrides,
  fieldNameLabel,
  keyNamer,
  type LabelText,
  liveStateLabel,
  THEOREM_UI_CATALOG,
  type TheoremLabels,
  toolNameLabel,
} from '../../react/src/ui/labels.ts';
import {
  layoutResult,
  missingFields,
  schemaFields,
  splitFields,
} from '../../web/src/client/index.ts';
import { defaultLabels } from './default-labels.ts';

// why: Specifiers held in values keep the type check off the React tree, which has its own.
const load = (path: string) => import(path);
const react = '../../react/node_modules';
const React = await load(`${react}/react/index.js`);
const { renderToStaticMarkup } = await load(`${react}/react-dom/server.node.js`);
const { TheoremLabelsProvider } = await load('../../react/src/ui/labels-provider.tsx');
const { AuthChallengeCard } = await load('../../react/src/ui/ToolGateCard.tsx');
const { StateFields } = await load('../../react/src/ui/StateFields.tsx');
const { createElement } = React.default ?? React;
// why: `deno coverage` loses files when deno.json sets a JSX runtime, so the .tsx under test
// transpiles to the classic one, which reads this global.
Object.assign(globalThis, { React: React.default ?? React });

const HOST_NAMES = {
  '@theorem.tool.name': '{tool, select, search_web {web search} other {{words}}}',
  '@theorem.data.field': '{field, select, due_at {Deadline} other {{words}}}',
};

const hostLabels = ((key: keyof typeof THEOREM_UI_CATALOG, values: Record<string, string>) => {
  const host: Readonly<Record<string, string>> = HOST_NAMES;
  const message = host[key] ?? THEOREM_UI_CATALOG[key].defaultMessage;
  return String(new IntlMessageFormat(message, 'en').format(values));
}) as LabelText;

Deno.test("a tool and a data field take the host's name for them, else their name in words", () => {
  assertLabelOverrides({ en: HOST_NAMES }, true);
  assertEquals(toolNameLabel(defaultLabels, 'search-web'), 'Search web');
  assertEquals(toolNameLabel(hostLabels, 'search-web'), 'web search');
  assertEquals(toolNameLabel(hostLabels, 'read_file'), 'Read file');
  assertEquals(fieldNameLabel(hostLabels, 'due.at'), 'Deadline');
  assertEquals(fieldNameLabel(defaultLabels, 'due_at'), 'Due at');
});

Deno.test('a background call says whether its words are its tool name', () => {
  const jobs = backgroundJobs([
    {
      id: 'a',
      kind: 'tool',
      tool: { callId: 'a', name: 'render_page', state: { phase: 'background' } },
    },
  ] as unknown as Parameters<typeof backgroundJobs>[0]);
  assertEquals(jobs, [{ callId: 'a', label: 'Render page', unlabelledTool: 'render_page' }]);
});

Deno.test("the sign-in card words why in the host's labels, never in the challenge's detail", () => {
  const labels: TheoremLabels = {
    en: { ...HOST_NAMES, '@theorem.gate.auth.detail': 'Connect {service} first.' },
  };
  const html = renderToStaticMarkup(
    createElement(TheoremLabelsProvider, {
      labels,
      children: createElement(AuthChallengeCard, {
        toolName: 'search_web',
        gate: {
          kind: 'auth',
          tool: 'search_web',
          authChallenge: {
            slot: 'docs',
            authType: 'bearer',
            service: 'Docs',
            message: "Authentication required for 'search_web' (auth slot: 'docs').",
          },
        },
      }),
    }),
  );
  assertStringIncludes(html, 'Sign in to use web search');
  assertStringIncludes(html, 'Connect Docs first.');
  assert(!html.includes('auth slot'));
});

Deno.test("an approval heading, a calling status and a cancelled call take the host's tool name", () => {
  const gate = { kind: 'approval' } as unknown as Parameters<typeof approvalHeading>[1];
  assertStringIncludes(approvalHeading(hostLabels, gate, 'search_web'), 'web search');
  assertStringIncludes(
    liveStateLabel(hostLabels, 'calling_tool', { name: 'search_web' } as Parameters<
      typeof liveStateLabel
    >[2]),
    'web search',
  );
  const cancelled = { name: 'search_web', activity: 'Searching', state: { phase: 'cancel' } };
  assertEquals(
    toolCallLabel(cancelled as unknown as Parameters<typeof toolCallLabel>[0], (name) =>
      toolNameLabel(hostLabels, name),
    ),
    'web search',
  );
});

Deno.test("every data key the client words takes the host's field name", () => {
  const nameOf = keyNamer(hostLabels);
  const { sections } = splitFields({ due_at: { note: 'x' } }, nameOf);
  assertEquals(
    sections.map((section) => section.title),
    ['Deadline'],
  );
  assertEquals(
    layoutResult({ due_at: 3 }, nameOf).figures.map((f) => f.label),
    ['Deadline'],
  );
  const schema = {
    type: 'object',
    properties: { due_at: { type: 'string' }, titled: { type: 'string', title: 'Name' } },
    required: ['due_at'],
  };
  assertEquals(
    schemaFields(schema, nameOf).map((f) => f.label),
    ['Deadline', 'Name'],
  );
  assertEquals(missingFields(schema, {}, '', nameOf), ['Deadline']);
});

Deno.test("a state form's fields take the host's field name", () => {
  const html = renderToStaticMarkup(
    createElement(TheoremLabelsProvider, {
      labels: { en: HOST_NAMES },
      children: createElement(StateFields, {
        label: 'State',
        value: { due_at: 'Friday' },
        onChange: () => {},
      }),
    }),
  );
  assertStringIncludes(html, 'Deadline');
});
