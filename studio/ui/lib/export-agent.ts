import {
	agentModulePath,
	type CompiledStudio,
	type CompiledWorkspace,
	importSpecifier,
	type SourceFile,
	workspaceSource,
} from '../../mod.ts';

const PACKAGES = [
	'@theoremjs/agents',
	'@theoremjs/react',
	'zod',
	'react',
	'react-dom',
	'@astryxdesign/core',
	'@stylexjs/stylex',
];

const INSTALL = `npm install ${PACKAGES.join(' ')}`;

/** Where the host mounts `createTheoremHandler`; `TheoremChat`'s default endpoint. */
const ENDPOINT = '/api/theorem';

/** Where the host mounts `createTheoremDecisionHandler`; `TheoremDecision`'s default endpoint. */
const DECISION_ENDPOINT = '/api/decision';

/** Where the host mounts `createTheoremHostHandler`; `TheoremHost`'s default endpoint. */
const HOST_ENDPOINT = '/api/host';

/** Turn profiles run through `createTheoremHandler`; live profiles run through a relay. */
function servesTurns({ profile }: CompiledStudio): boolean {
	return profile.type !== 'live' && profile.type !== 'decision' && profile.type !== 'host';
}

/** The `keySlot` and `fallbackKeySlot` an object names, when they are strings. */
function slotsOn(value: unknown): string[] {
	if (!value || typeof value !== 'object') return [];
	const { keySlot, fallbackKeySlot } = value as { keySlot?: unknown; fallbackKeySlot?: unknown };
	return [keySlot, fallbackKeySlot].filter(
		(slot): slot is string => typeof slot === 'string' && slot !== '',
	);
}

/** Every vault slot an agent names, on the profile or on a model. */
function keySlots({ profile }: CompiledStudio): string[] {
	const models: unknown = 'models' in profile ? profile.models : {};
	const bindings = models && typeof models === 'object' ? (Object.values(models) as unknown[]) : [];
	return [profile, ...bindings].flatMap(slotsOn);
}

/** The vault the route reads: each slot any agent names, from `THEOREM_VAULT_<SLOT>`. The agents it calls spend keys too. */
function vaultSource(workspace: CompiledWorkspace): string {
	const slots = [...new Set(workspace.agents.flatMap(keySlots))];
	const entries = slots.map(
		(slot) =>
			`${JSON.stringify(slot)}: process.env.THEOREM_VAULT_${slot.toUpperCase().replaceAll('-', '_')}`,
	);
	return `{ ${entries.join(', ')} }`;
}

/** The provider options the route needs, each key read from the server's environment. */
function providerSource(workspace: CompiledWorkspace): string {
	const parts = [`vault: ${vaultSource(workspace)}`];

	return `{\n${parts.map((part) => `    ${part},`).join('\n')}\n  }`;
}

/** What the chatted agent adds: the route that runs it and the browser component that calls it. */
interface Entry {
	/** The route's file, server only. Live agents have none. */
	route?: SourceFile;
	/** The browser's file, and what it shows. */
	ui?: SourceFile & { what: string };
	/** Where the route mounts. */
	endpoint?: string;
}

/** The route file: `factory` from the server entry, built from the agent's module with `options`. */
function serverFile(
	agent: CompiledStudio,
	exportName: string,
	factory: string,
	mount: string,
	options: string[],
): SourceFile {
	const module = importSpecifier(agentModulePath(agent.agentId));
	return {
		path: 'route.ts',
		code: `${[
			`import { ${factory} } from '@theoremjs/react/server';`,
			"import './theorem';",
			`import { ${agent.profile.type === 'decision' ? 'profile, questions' : 'profile'} } from '${module}';`,
			'',
			`/** ${mount} */`,
			`export const ${exportName} = ${factory}({`,
			...options.map((option) => `  ${option},`),
			'});',
		].join('\n')}\n`,
	};
}

/** The browser file: one component that renders `component` pointed at `endpoint`. */
function browserFile(
	path: string,
	name: string,
	component: string,
	endpoint: string,
	what: string,
	props: readonly string[] = [],
): SourceFile & { what: string } {
	const element =
		props.length === 0
			? [`  return <${component} endpoint="${endpoint}" />;`]
			: [
					'  return (',
					`    <${component}`,
					`      endpoint="${endpoint}"`,
					...props.map((prop) => `      ${prop}`),
					'    />',
					'  );',
				];
	return {
		path,
		what,
		code: `${[
			`import { ${component} } from '@theoremjs/react/ui';`,
			'',
			`export function ${name}() {`,
			...element,
			'}',
		].join('\n')}\n`,
	};
}

/** What the agent takes from its page and its server: `inputs.slots` and `inputs.context`. */
function pageInputs({ profile }: CompiledStudio) {
	const inputs = 'inputs' in profile ? profile.inputs : undefined;
	const slots: Record<string, string[]> = inputs && 'slots' in inputs ? (inputs.slots ?? {}) : {};
	const context = inputs && 'context' in inputs ? inputs.context : undefined;
	return { slots: Object.entries(slots), from: context?.from ?? [] };
}

/** The chat's prop for the tools this page answers: a function per tool, returning its output. */
function pageToolsProp(agent: CompiledStudio): string[] {
	const names = agent.customTools.flatMap((tool) =>
		tool.type === 'function' && tool.answeredBy === 'page' ? [tool.name] : [],
	);
	if (names.length === 0) return [];
	return [
		'// What this page does for each tool it answers, and the output it returns.',
		'pageTools={{',
		...names.map((name) => `  ${JSON.stringify(name)}: (args) => ({ output: {} }),`),
		'}}',
	];
}

/** The chat's props for what the page supplies: a value per slot, and its context. */
function pageProps(agent: CompiledStudio): string[] {
	const { slots, from } = pageInputs(agent);
	const picked = slots.map(
		([name, allowed]) => `${JSON.stringify(name)}: ${JSON.stringify(allowed.at(0) ?? '')}`,
	);
	return [
		...slots.map(([name, allowed]) => `// ${name}: ${allowed.join(' | ')}`),
		...(slots.length > 0 ? [`slots={{ ${picked.join(', ')} }}`] : []),
		...(from.includes('client')
			? ['// What this page tells the agent: any JSON.', 'context={{}}']
			: []),
		...pageToolsProp(agent),
	];
}

/** The route's option for what the server tells the agent, when the profile takes it. */
function serverContext(agent: CompiledStudio): string[] {
	return pageInputs(agent).from.includes('server')
		? ['// What your server tells the agent with each request: any JSON.\n  context: () => ({})']
		: [];
}

/** A decision agent's route and its state-and-answers component. */
function decisionEntry(workspace: CompiledWorkspace, agent: CompiledStudio): Entry {
	return {
		endpoint: DECISION_ENDPOINT,
		route: serverFile(
			agent,
			'decision',
			'createTheoremDecisionHandler',
			`Mount at ${DECISION_ENDPOINT} and ${DECISION_ENDPOINT}/decide. The questions stay here; the browser sends only the state.`,
			['profile', 'questions', `vault: ${vaultSource(workspace)}`],
		),
		ui: browserFile(
			'AgentDecision.tsx',
			'AgentDecision',
			'TheoremDecision',
			DECISION_ENDPOINT,
			'the state field and the answers',
		),
	};
}

/** A host agent's route and its form-per-tool component. */
function hostEntry(agent: CompiledStudio): Entry {
	return {
		endpoint: HOST_ENDPOINT,
		route: serverFile(
			agent,
			'host',
			'createTheoremHostHandler',
			`Mount at ${HOST_ENDPOINT}/*: it describes the tools, and answers /call and /invoke. No model runs.`,
			['profile'],
		),
		ui: browserFile(
			'AgentHost.tsx',
			'AgentHost',
			'TheoremHost',
			HOST_ENDPOINT,
			'a form per tool and its result',
		),
	};
}

/** A turn agent's route and its chat. */
function turnEntry(workspace: CompiledWorkspace, agent: CompiledStudio): Entry {
	return {
		endpoint: ENDPOINT,
		route: serverFile(
			agent,
			'theorem',
			'createTheoremHandler',
			`Mount at ${ENDPOINT}/*: it answers /turn, /invoke and /steer.`,
			['profile', `provider: ${providerSource(workspace)}`, ...serverContext(agent)],
		),
		ui: browserFile(
			'AgentChat.tsx',
			'AgentChat',
			'TheoremChat',
			ENDPOINT,
			'the chat',
			pageProps(agent),
		),
	};
}

function entryFiles(workspace: CompiledWorkspace, agent: CompiledStudio): Entry {
	if (agent.profile.type === 'decision') return decisionEntry(workspace, agent);
	if (agent.profile.type === 'host') return hostEntry(agent);
	if (!servesTurns(agent)) return {};
	return turnEntry(workspace, agent);
}

/** The README: what each file is, which run only on the server, and what to install. */
function readme(files: readonly SourceFile[], agent: CompiledStudio, entry: Entry): string {
	const agents = files.filter((file) => file.path.startsWith('agents/'));
	const rows = [
		...(files.some((file) => file.path === 'tools.ts')
			? ['- `tools.ts` (server only): the tools the agents share.']
			: []),
		...agents.map(
			(file) => `- \`${file.path}\` (server only): one agent's profile. It registers nothing.`,
		),
		'- `theorem.ts` (server only): registers every tool and agent, each after the agents it names. Import it once.',
		...(entry.route
			? [
					`- \`route.ts\` (server only): runs \`${agent.agentId}\`, mounted at \`${entry.endpoint ?? ''}\`.`,
				]
			: []),
		...(entry.ui
			? [`- \`${entry.ui.path}\` (browser): ${entry.ui.what}, pointed at that route.`]
			: []),
	];
	return `${[
		`# ${agent.agentId}`,
		'',
		`Exported from the Theorem Studio: ${agents.length === 1 ? 'one agent' : `${String(agents.length)} agents`}${
			entry.route
				? `, and the route and ${entry.ui ? 'component' : 'files'} for \`${agent.agentId}\``
				: ''
		}.`,
		'',
		...rows,
		'',
		entry.route
			? 'The server-only files read your keys. Nothing in them may reach the browser.'
			: `\`${agent.agentId}\` is a ${agent.profile.type} agent: register it on your server, then run it through your own relay (see @theoremjs/react/live).`,
		'',
		'```bash',
		INSTALL,
		'```',
	].join('\n')}\n`;
}

/**
 * The workspace as files: the README, the tools, one module per agent and the
 * registration, then the route and component for `agent`, the one being chatted with.
 */
export function exportFiles(workspace: CompiledWorkspace, agent: CompiledStudio): SourceFile[] {
	const source = workspaceSource(workspace).map((file) =>
		file.path !== 'theorem.ts'
			? file
			: {
					...file,
					code: file.code.replace(
						"baseURL: 'http://localhost:11434/v1'",
						"baseURL: (process.env.LOCAL_MODEL_URL ?? 'http://127.0.0.1:11434').replace(/\\/$/, '') + '/v1'",
					),
				},
	);
	const entry = entryFiles(workspace, agent);
	return [
		{ path: 'README.md', code: readme(source, agent, entry) },
		...source,
		...(entry.route ? [entry.route] : []),
		...(entry.ui ? [{ path: entry.ui.path, code: entry.ui.code }] : []),
	];
}

/** The files as one text, each under its path, to paste or to hand to a coding agent. */
export function exportText(files: readonly SourceFile[]): string {
	return files.map((file) => `// ─── ${file.path} ───\n\n${file.code.trimEnd()}\n`).join('\n');
}

/** What the brief asks before code, by the chatted agent's type. */
function briefQuestions(agent: CompiledStudio, tools: string[]): string[] {
	const type = agent.profile.type;
	if (type === 'decision') {
		return [
			'- Where the state comes from: typed by a person in `TheoremDecision` (`AgentDecision.tsx`), or built by my own code, which then calls `runDecision` from `@theoremjs/agents` on the server and drops `route.ts` and `AgentDecision.tsx`.',
			`- Which framework this app uses, and where server routes live (so the handler mounts at \`${DECISION_ENDPOINT}\`, or the path you pick).`,
			'- Where the model keys come from: environment variables or a secrets manager.',
			'- Who may call the route, and how many decisions each caller may make: every decision spends a key.',
		];
	}
	if (type === 'host') {
		return [
			'- Who calls the tools: a person in `TheoremHost` (`AgentHost.tsx`), an MCP client, or my own code, which then drops `AgentHost.tsx`.',
			`- Which framework this app uses, and where server routes live (so the handler mounts at \`${HOST_ENDPOINT}\`, or the path you pick).`,
			"- Where each tool's keys come from, if any need them.",
			'- Who may call the route, and how often.',
		];
	}
	const turns = servesTurns(agent);
	return [
		...(turns
			? [
					'- Whether I want a UI at all, since the answer decides what you install and build:',
					'  - The package-prepared user interface (`TheoremChat`, in `AgentChat.tsx`);',
					'  - my own UI on `useTheoremChat` from `@theoremjs/react`, which gives the conversation state without the styling;',
					'  - or none: my server code calls `runTurn` from `@theoremjs/agents` directly, and `route.ts` and `AgentChat.tsx` are dropped.',
				]
			: []),
		`- Which framework this app uses, and where server routes live (so the handler mounts at \`${ENDPOINT}\`, or the path you pick).`,
		"- Where model keys come from: environment variables, a secrets manager, or each user's own key.",
		'- Who may use the agents: anyone, or only signed-in users (the handler takes a `session` resolver).',
		'- Whether sessions must survive restarts or span several instances (then pass a shared `sessionStore`).',
		...(tools.length
			? [
					`- What each tool should really do: ${tools.join(', ')} return stand-in data today. Where does the real data come from, and what credentials does each need?`,
				]
			: []),
		'- If I want a UI: where it should appear, and whether it should match an existing theme.',
	];
}

/** The files with a brief for a coding agent: what to ask, what to install, where each file goes. */
export function llmBrief(workspace: CompiledWorkspace, agent: CompiledStudio): string {
	const files = exportFiles(workspace, agent);
	const stubs = [
		...new Set(
			workspace.agents.flatMap((each) =>
				each.customTools
					.filter((tool) => tool.type === 'function')
					.map((tool) => `\`${tool.name}\``),
			),
		),
	];
	const turns = servesTurns(agent);
	return `# Add the Theorem agents to this app

The files below were exported from the Theorem Studio: ${workspace.agents.map((each) => `\`${each.agentId}\``).join(', ')}, the tools they share, the registration that wires them together${
		files.some((file) => file.path === 'route.ts')
			? `, and a server route and package-prepared user interface for \`${agent.agentId}\``
			: ''
	}. The README says what each file is. Wire them into this codebase.

## Before you write code, ask me
${briefQuestions(agent, stubs).join('\n')}

## Install
${
	turns
		? `Install only what my answer about the UI needs:
- No UI: \`npm install @theoremjs/agents zod\`
- My own UI: \`npm install @theoremjs/agents @theoremjs/react zod react react-dom\`
- The package-prepared user interface: \`${INSTALL}\``
		: `\`\`\`bash
${INSTALL}
\`\`\``
}

## Organise it
- Keep the layout: \`tools.ts\`, \`agents/\` and \`theorem.ts\` together in one server-only folder. Each agent has one module, so its profile has one source of truth.
- Import \`theorem.ts\` once, before anything runs an agent. Keep its order: an agent is registered after the agents it calls or that summarise for it, and an agent tool after the agent it runs.

## Do
- Read model keys on the server only, from the environment or a secrets manager.
- Keep \`registerProfile\`, \`registerTool\` and the handler in server-only modules; the browser imports only \`@theoremjs/react\`, \`/ui\` or \`/live\`.
- Replace each function tool's stand-in handler with the real call; its input is already checked against the Zod schema given.
- Change an agent's settings in its own module, or in the studio and export again.

## Don't
- Don't import \`tools.ts\`, \`agents/\`, \`theorem.ts\` or \`route.ts\` from browser code, or put a key in a \`VITE_\`, \`NEXT_PUBLIC_\` or other client variable.
- Don't log request bodies or tool credentials; the handler keeps credentials per session, off the wire.
- Don't copy a profile into several places.
- Don't turn off an agent's guardrails to make a test pass.

## The files
\`\`\`tsx
${exportText(files).trimEnd()}
\`\`\`
`;
}
