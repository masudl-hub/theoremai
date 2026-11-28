import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { IntlMessageFormat } from 'intl-messageformat';
import { backgroundJobs } from '../../react/src/client/transcript-groups.ts';
import {
  assertLabelOverrides,
  fieldNameLabel,
  type LabelText,
  THEOREM_UI_CATALOG,
  type TheoremLabels,
  toolNameLabel,
} from '../../react/src/ui/labels.ts';
import { defaultLabels } from './default-labels.ts';

// why: Specifiers held in values keep the type check off the React tree, which has its own.
const load = (path: string) => import(path);
const react = '../../react/node_modules';
const React = await load(`${react}/react/index.js`);
const { renderToStaticMarkup } = await load(`${react}/react-dom/server.node.js`);
const { TheoremLabelsProvider } = await load('../../react/src/ui/labels-provider.tsx');
const { AuthChallengeCard } = await load('../../react/src/ui/ToolGateCard.tsx');
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
