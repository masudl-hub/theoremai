import type * as Monaco from 'monaco-editor';
import type { editor, languages, MarkerSeverity, Uri } from './studio-monaco';

export type MonacoApi = {
	editor: typeof editor;
	languages: typeof languages;
	MarkerSeverity: typeof MarkerSeverity;
	Uri: typeof Uri;
};

/**
 * Globals the package declarations mention. `lib.esnext.full` pulls in the DOM
 * library, which is about 1.9MB of types, so the checker loads `es2022` and
 * this file instead.
 */
const HOST_LIB = `interface AbortSignal {
	readonly aborted: boolean;
}
interface Headers {}
interface Request {}
interface RequestInit {
	method?: string;
	headers?: Headers;
	body?: unknown;
	signal?: AbortSignal;
}
interface Response {
	ok: boolean;
	status: number;
}
interface WebSocket {
	close(code?: number, reason?: string): void;
}
interface URL {
	href: string;
}
declare function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
`;

interface DisplayPart {
	text: string;
}

interface TextSpan {
	start: number;
	length: number;
}

interface Tag {
	name: string;
	text?: string | readonly DisplayPart[];
}

interface TypeWorker {
	getCompletionsAtPosition(
		fileName: string,
		position: number,
	): Promise<
		| {
				entries: {
					name: string;
					kind: string;
					sortText: string;
					kindModifiers?: string;
					replacementSpan?: TextSpan;
				}[];
		  }
		| undefined
	>;
	getCompletionEntryDetails(
		fileName: string,
		position: number,
		entry: string,
	): Promise<
		| {
				name: string;
				kind: string;
				displayParts?: DisplayPart[];
				documentation?: DisplayPart[];
				tags?: Tag[];
		  }
		| undefined
	>;
	getQuickInfoAtPosition(
		fileName: string,
		position: number,
	): Promise<
		| {
				displayParts?: DisplayPart[];
				documentation?: DisplayPart[];
				tags?: Tag[];
				textSpan: TextSpan;
		  }
		| undefined
	>;
	getSignatureHelpItems(
		fileName: string,
		position: number,
		options: { triggerReason: { kind: string; triggerCharacter?: string } },
	): Promise<
		| {
				selectedItemIndex: number;
				argumentIndex: number;
				items: {
					prefixDisplayParts: DisplayPart[];
					suffixDisplayParts: DisplayPart[];
					separatorDisplayParts: DisplayPart[];
					documentation?: DisplayPart[];
					parameters: { displayParts: DisplayPart[]; documentation?: DisplayPart[] }[];
				}[];
		  }
		| undefined
	>;
	getDefinitionAtPosition(
		fileName: string,
		position: number,
	): Promise<{ fileName: string; textSpan: TextSpan }[] | undefined>;
}

interface CompletionCarry {
	uri: Monaco.Uri;
	position: Monaco.IPosition;
	offset: number;
}

/** Package types for the open file. Call `stop` to terminate the worker. */
export function openTypeChecker(
	monaco: MonacoApi,
	codeEditor: Monaco.editor.IStandaloneCodeEditor,
	onReady: () => void,
): { stop(): void } {
	let stopped = false;
	const isStopped = () => stopped;
	const disposables: { dispose(): void }[] = [];
	const track = <T extends { dispose(): void }>(value: T): T => {
		if (stopped) value.dispose();
		else disposables.push(value);
		return value;
	};

	void boot();

	return {
		stop() {
			if (isStopped()) return;
			stopped = true;
			for (const item of disposables) item.dispose();
			disposables.length = 0;
		},
	};

	async function boot() {
		const [{ default: TsWorker }, { typeSources }] = await Promise.all([
			import('./studio-ts.worker?worker'),
			import('virtual:studio-type-sources'),
		]);
		const model = codeEditor.getModel();
		if (stopped || !model) return;

		const libs: Record<string, string> = { 'lib.host.d.ts': HOST_LIB, ...typeSources };
		const extraLibs: Record<string, { content: string; version: number }> = {};
		for (const [file, content] of Object.entries(libs)) {
			extraLibs[file] = { content, version: 1 };
		}

		const client = track(
			monaco.editor.createWebWorker<TypeWorker>({
				// The first message only wakes the worker. The second is its compiler options.
				worker: Promise.resolve(new TsWorker()).then((worker) => {
					worker.postMessage('ignore');
					worker.postMessage({
						compilerOptions: {
							allowNonTsExtensions: true,
							// ESNext selects `lib.esnext.full.d.ts`, which includes the DOM library.
							target: 7,
							lib: ['es2022', 'host'],
							module: 99,
							// Bundler. The public enum only lists Classic and NodeJs.
							moduleResolution: 100,
							strict: true,
							noEmit: true,
							skipLibCheck: true,
							allowImportingTsExtensions: true,
							paths: {
								'@theoremjs/agents': ['file:///node_modules/@theoremjs/agents/mod.d.ts'],
								'@theoremjs/agents/guardrails/compile': [
									'file:///node_modules/@theoremjs/agents/src/guardrails/compile-egress.d.ts',
								],
								zod: ['file:///node_modules/zod/index.d.ts'],
							},
						},
						extraLibs,
						inlayHintsOptions: {},
					});
					return worker;
				}),
				keepIdleModels: true,
			}),
		);
		if (isStopped()) return;

		const proxy = () => client.withSyncedResources([model.uri]);
		const { languages } = monaco;

		track(
			languages.registerCompletionItemProvider('typescript', {
				triggerCharacters: ['.'],
				provideCompletionItems: (textModel, position) =>
					completions(languages, proxy, textModel, position),
				resolveCompletionItem: (item) => resolveCompletion(languages, proxy, item),
			}),
		);
		track(
			languages.registerHoverProvider('typescript', {
				provideHover: (textModel, position) => hover(proxy, textModel, position),
			}),
		);
		track(
			languages.registerSignatureHelpProvider('typescript', {
				signatureHelpTriggerCharacters: ['(', ','],
				provideSignatureHelp: (textModel, position) => signatureHelp(proxy, textModel, position),
			}),
		);
		track(
			languages.registerDefinitionProvider('typescript', {
				provideDefinition: (textModel, position) =>
					definition(monaco, libs, track, proxy, textModel, position),
			}),
		);
		if (isStopped()) return;
		if (codeEditor.hasTextFocus()) {
			codeEditor.trigger('studio', 'editor.action.triggerSuggest', {});
		}
		onReady();
	}
}

async function completions(
	languages: MonacoApi['languages'],
	proxy: () => Promise<TypeWorker>,
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): Promise<Monaco.languages.CompletionList | undefined> {
	try {
		const word = model.getWordUntilPosition(position);
		const offset = model.getOffsetAt(position);
		const info = await (await proxy()).getCompletionsAtPosition(model.uri.toString(), offset);
		if (!info) return;
		const suggestions = info.entries.map((entry) => {
			const range = entry.replacementSpan
				? spanToRange(model, entry.replacementSpan)
				: {
						startLineNumber: position.lineNumber,
						startColumn: word.startColumn,
						endLineNumber: position.lineNumber,
						endColumn: word.endColumn,
					};
			const carry: CompletionCarry = { uri: model.uri, position, offset };
			return {
				...carry,
				label: entry.name,
				insertText: entry.name,
				sortText: entry.sortText,
				kind: completionKind(languages, entry.kind),
				range,
				tags:
					entry.kindModifiers?.includes('deprecated') === true
						? [languages.CompletionItemTag.Deprecated]
						: [],
			};
		});
		return { suggestions };
	} catch {
		return;
	}
}

async function resolveCompletion(
	languages: MonacoApi['languages'],
	proxy: () => Promise<TypeWorker>,
	item: Monaco.languages.CompletionItem,
): Promise<Monaco.languages.CompletionItem> {
	const carry = item as Monaco.languages.CompletionItem & Partial<CompletionCarry>;
	if (!carry.uri || !carry.position || carry.offset === undefined) return item;
	try {
		const details = await (await proxy()).getCompletionEntryDetails(
			carry.uri.toString(),
			carry.offset,
			item.label as string,
		);
		if (!details) return item;
		return {
			...item,
			detail: parts(details.displayParts),
			documentation: { value: documentation(details) },
			kind: completionKind(languages, details.kind),
		};
	} catch {
		return item;
	}
}

async function hover(
	proxy: () => Promise<TypeWorker>,
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): Promise<Monaco.languages.Hover | undefined> {
	try {
		const info = await (await proxy()).getQuickInfoAtPosition(
			model.uri.toString(),
			model.getOffsetAt(position),
		);
		if (!info) return;
		const docs = documentation(info);
		return {
			range: spanToRange(model, info.textSpan),
			contents: [
				{ value: `\`\`\`typescript\n${parts(info.displayParts)}\n\`\`\`` },
				...(docs ? [{ value: docs }] : []),
			],
		};
	} catch {
		return;
	}
}

async function signatureHelp(
	proxy: () => Promise<TypeWorker>,
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): Promise<Monaco.languages.SignatureHelpResult | undefined> {
	try {
		const info = await (await proxy()).getSignatureHelpItems(
			model.uri.toString(),
			model.getOffsetAt(position),
			{
				triggerReason: { kind: 'invoked' },
			},
		);
		if (!info) return;
		return {
			value: {
				activeSignature: info.selectedItemIndex,
				activeParameter: info.argumentIndex,
				signatures: info.items.map((item) => {
					let label = parts(item.prefixDisplayParts);
					const parameters = item.parameters.map((parameter, index) => {
						const name = parts(parameter.displayParts);
						label += name;
						if (index < item.parameters.length - 1) label += parts(item.separatorDisplayParts);
						return {
							label: name,
							documentation: { value: parts(parameter.documentation) },
						};
					});
					label += parts(item.suffixDisplayParts);
					return { label, parameters, documentation: { value: parts(item.documentation) } };
				}),
			},
			dispose() {},
		};
	} catch {
		return;
	}
}

async function definition(
	monaco: MonacoApi,
	libs: Record<string, string>,
	track: <T extends { dispose(): void }>(value: T) => T,
	proxy: () => Promise<TypeWorker>,
	model: Monaco.editor.ITextModel,
	position: Monaco.Position,
): Promise<Monaco.languages.Location[] | undefined> {
	try {
		const entries = await (await proxy()).getDefinitionAtPosition(
			model.uri.toString(),
			model.getOffsetAt(position),
		);
		if (!entries) return;
		const locations: Monaco.languages.Location[] = [];
		for (const entry of entries) {
			const target = modelFor(monaco, libs, track, entry.fileName);
			if (!target) continue;
			locations.push({ uri: target.uri, range: spanToRange(target, entry.textSpan) });
		}
		return locations;
	} catch {
		return;
	}
}

function modelFor(
	monaco: MonacoApi,
	libs: Record<string, string>,
	track: <T extends { dispose(): void }>(value: T) => T,
	fileName: string,
): Monaco.editor.ITextModel | undefined {
	let uri: Monaco.Uri;
	try {
		uri = monaco.Uri.parse(fileName);
	} catch {
		return;
	}
	const existing = monaco.editor.getModel(uri);
	if (existing) return existing;
	if (!(fileName in libs)) return;
	return track(monaco.editor.createModel(libs[fileName], 'typescript', uri));
}

function spanToRange(model: Monaco.editor.ITextModel, span: TextSpan): Monaco.IRange {
	const start = model.getPositionAt(span.start);
	const end = model.getPositionAt(span.start + span.length);
	return {
		startLineNumber: start.lineNumber,
		startColumn: start.column,
		endLineNumber: end.lineNumber,
		endColumn: end.column,
	};
}

function parts(value: readonly DisplayPart[] | undefined): string {
	return value?.map((part) => part.text).join('') ?? '';
}

function documentation(info: {
	documentation?: readonly DisplayPart[];
	tags?: readonly Tag[];
}): string {
	let text = parts(info.documentation);
	for (const tag of info.tags ?? []) {
		const body = typeof tag.text === 'string' ? tag.text : parts(tag.text);
		text += `\n\n*@${tag.name}*${body ? ` — ${body}` : ''}`;
	}
	return text;
}

/** The editor's kind for each kind the language service names; anything else is a property. */
const COMPLETION_KINDS = new Map<string, keyof typeof Monaco.languages.CompletionItemKind>([
	['keyword', 'Keyword'],
	['primitive type', 'Keyword'],
	['var', 'Variable'],
	['local var', 'Variable'],
	['const', 'Variable'],
	['let', 'Variable'],
	['property', 'Field'],
	['getter', 'Field'],
	['setter', 'Field'],
	['function', 'Function'],
	['method', 'Function'],
	['constructor', 'Function'],
	['call', 'Function'],
	['construct', 'Function'],
	['index', 'Function'],
	['enum', 'Enum'],
	['module', 'Module'],
	['class', 'Class'],
	['interface', 'Interface'],
]);

function completionKind(
	languages: MonacoApi['languages'],
	kind: string,
): Monaco.languages.CompletionItemKind {
	return languages.CompletionItemKind[COMPLETION_KINDS.get(kind) ?? 'Property'];
}
