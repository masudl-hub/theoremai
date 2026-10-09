import type { StudioSourceError, StudioSourceSpan } from '../../mod.ts';
import type { CodeIssue, StudioCodeProps } from '../studio-host.ts';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

/** What reading the file produced: errors at a spot, or the fields it read. */

const APPLY_MS = 300;
/** How long typing has to stay quiet before the typechecker worker is terminated. */
const TYPE_IDLE_MS = 2000;

interface MarkerHost {
	editor: typeof Monaco.editor;
	MarkerSeverity: typeof Monaco.MarkerSeverity;
	Uri: typeof Monaco.Uri;
}

interface Session {
	editor?: Monaco.editor.IStandaloneCodeEditor;
	monaco?: MarkerHost;
	spans: StudioSourceSpan[];
	errors: StudioSourceError[];
	setting: boolean;
	dirty: boolean;
}

/** Marks the text's own errors and the draft's issues on the lines they belong to. */
function paintMarkers({ editor, monaco, spans, errors }: Session, issues: readonly CodeIssue[]) {
	const model = editor?.getModel();
	if (!monaco || !model) return;
	monaco.editor.setModelMarkers(model, 'studio', [
		...errors.map((error) => marker(monaco, error.line, error.column, error.message)),
		...issueMarkers(monaco, spans, issues),
	]);
}

/**
 * The open agent's file. `text` is the latest print. While the visitor is
 * typing, the model keeps their text. `hold` means there is no new print,
 * so the text they have stays.
 */
export function StudioCode({ text, hold, issues, onApply }: StudioCodeProps) {
	const node = useRef<HTMLDivElement>(null);
	const apply = useRef(onApply);
	const printed = useRef(text);
	const issuesRef = useRef(issues);
	const session = useRef<Session>({ spans: [], errors: [], setting: false, dirty: false });
	apply.current = onApply;
	printed.current = text;
	issuesRef.current = issues;

	useEffect(() => {
		const host = node.current;
		if (!host) return;
		const life = { disposed: false };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let typeToken = 0;
		let typeSession: { stop(): void } | undefined;
		let typeStarting = false;
		let typeReady = false;
		const stopTypes = () => {
			typeToken += 1;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = undefined;
			typeSession?.stop();
			typeSession = undefined;
			typeStarting = false;
			typeReady = false;
		};
		const inTypeUi = (node: Node) => {
			if (host.contains(node)) return true;
			return (
				node instanceof Element &&
				!!node.closest(
					'.suggest-widget, .parameter-hints-widget, .monaco-hover, .monaco-menu-container, .context-view',
				)
			);
		};
		const typeUiOpen = () =>
			!!document.querySelector('.suggest-widget.visible, .parameter-hints-widget.visible');
		let removeLeave: (() => void) | undefined;
		const paint = () => {
			paintMarkers(session.current, issuesRef.current);
		};
		void (async () => {
			const monaco = await import('./studio-monaco');
			// Colour only, until the visitor types. The typechecker is a compiler in
			// a worker, so it stays out of this import.
			await import('monaco-editor/languages/definitions/typescript/register');
			const editorWorker = (await import('monaco-editor/editor/editor.worker?worker')).default;
			(self as MonacoHost).MonacoEnvironment = {
				getWorker() {
					return new editorWorker();
				},
			};
			if (life.disposed || !host.isConnected) return;
			const dark =
				document.documentElement.dataset.theme === 'dark' ||
				globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
			const uri = monaco.Uri.parse('file:///agent.ts');
			monaco.editor.getModel(uri)?.dispose();
			const model = monaco.editor.createModel(printed.current, 'typescript', uri);
			const editor = monaco.editor.create(host, {
				model,
				language: 'typescript',
				theme: dark ? 'vs-dark' : 'vs',
				minimap: { enabled: false },
				fontSize: 13,
				wordWrap: 'on',
				wrappingIndent: 'indent',
				scrollBeyondLastLine: false,
				automaticLayout: true,
				fixedOverflowWidgets: true,
				tabSize: 2,
				padding: { top: 12 },
				quickSuggestions: { other: true, comments: false, strings: true },
				suggestOnTriggerCharacters: true,
				acceptSuggestionOnEnter: 'on',
				tabCompletion: 'on',
				wordBasedSuggestions: 'currentDocument',
				parameterHints: { enabled: true },
				suggest: { preview: true, showIcons: true },
			});
			session.current.editor = editor;
			session.current.monaco = monaco;
			const scheduleTypeStop = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					if (life.disposed) return;
					if (typeUiOpen()) {
						scheduleTypeStop();
						return;
					}
					stopTypes();
				}, TYPE_IDLE_MS);
			};
			const ensureTypes = () => {
				if (typeSession) {
					if (typeReady) scheduleTypeStop();
					return;
				}
				if (typeStarting) return;
				const mine = typeToken;
				const isStale = () => life.disposed || mine !== typeToken;
				typeStarting = true;
				void import('./studio-type-checker')
					.then(({ openTypeChecker }) => {
						if (isStale()) return;
						const checker = openTypeChecker(monaco, editor, () => {
							if (life.disposed || mine !== typeToken) return;
							typeReady = true;
							scheduleTypeStop();
						});
						if (isStale()) {
							checker.stop();
							return;
						}
						typeSession = checker;
					})
					.catch(() => {})
					.finally(() => {
						if (mine === typeToken) typeStarting = false;
					});
			};
			editor.onKeyDown((event) => {
				const native = event.browserEvent;
				if (native.metaKey || native.ctrlKey || native.altKey) return;
				if (typeReady) scheduleTypeStop();
			});
			// A pointer outside the editor kills the checker in that event. The
			// suggestion list is part of typing, so a press on it does not count.
			const onLeave = (event: Event) => {
				const target = event.target;
				if (!(target instanceof Node) || inTypeUi(target)) return;
				stopTypes();
			};
			document.addEventListener('pointerdown', onLeave, true);
			removeLeave = () => {
				document.removeEventListener('pointerdown', onLeave, true);
			};
			editor.onDidBlurEditorText(() => {
				queueMicrotask(() => {
					if (life.disposed || editor.hasTextFocus()) return;
					const next = document.activeElement;
					if (next && inTypeUi(next)) return;
					stopTypes();
				});
			});
			editor.onDidChangeModelContent(() => {
				if (session.current.setting) return;
				ensureTypes();
				const value = editor.getValue();
				session.current.dirty = value !== printed.current;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					const applied = apply.current(value);
					session.current.spans = applied.spans;
					session.current.errors = applied.errors;
					paint();
				}, APPLY_MS);
			});
			paint();
		})();
		return () => {
			life.disposed = true;
			removeLeave?.();
			stopTypes();
			if (timer) clearTimeout(timer);
			const model = session.current.editor?.getModel();
			session.current.editor?.dispose();
			model?.dispose();
			session.current.editor = undefined;
		};
	}, []);

	useEffect(() => {
		const { editor } = session.current;
		if (!editor || hold) return;
		if (session.current.dirty && editor.getValue() !== text) return;
		if (editor.getValue() === text) {
			session.current.dirty = false;
			return;
		}
		session.current.setting = true;
		editor.setValue(text);
		session.current.setting = false;
		session.current.dirty = false;
	}, [text, hold]);

	useEffect(() => {
		paintMarkers(session.current, issues);
	}, [issues]);

	return <div ref={node} className="fill" />;
}

/** `self` in the browser, which Monaco reads for its workers. */
interface MonacoHost {
	MonacoEnvironment?: {
		getWorker(workerId: string, label: string): Worker;
	};
}

function marker(
	monaco: MarkerHost,
	line: number,
	column: number,
	message: string,
): Monaco.editor.IMarkerData {
	return {
		startLineNumber: line,
		startColumn: column,
		endLineNumber: line,
		endColumn: column + 1,
		message,
		severity: monaco.MarkerSeverity.Error,
	};
}

function issueMarkers(
	monaco: MarkerHost,
	spans: readonly StudioSourceSpan[],
	issues: readonly CodeIssue[],
): Monaco.editor.IMarkerData[] {
	return issues.flatMap((issue) => {
		const exact = issue.field ? `${issue.nodeId}.${issue.field}` : issue.nodeId;
		const span =
			spans.find((item) => item.path === exact) ??
			(issue.field ? spans.find((item) => item.path === issue.field) : undefined);
		if (!span) return [];
		return [marker(monaco, span.line, span.column, issue.message)];
	});
}
