/** Side-effect registers. Monaco ships these as JavaScript with no declarations. */
declare module 'monaco-editor/editor/browser/coreCommands';
declare module 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget';
declare module 'monaco-editor/editor/common/standaloneStrings';
declare module 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
declare module 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations';
declare module 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
declare module 'monaco-editor/editor/contrib/comment/browser/comment';
declare module 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
declare module 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
declare module 'monaco-editor/editor/contrib/find/browser/findController';
declare module 'monaco-editor/editor/contrib/folding/browser/folding';
declare module 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
declare module 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus';
declare module 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
declare module 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
declare module 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
declare module 'monaco-editor/editor/contrib/indentation/browser/indentation';
declare module 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
declare module 'monaco-editor/editor/contrib/links/browser/links';
declare module 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
declare module 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints';
declare module 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution';
declare module 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution';
declare module 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';
declare module 'monaco-editor/editor/contrib/snippet/browser/snippetController2';
declare module 'monaco-editor/editor/contrib/suggest/browser/suggestController';
declare module 'monaco-editor/editor/contrib/tokenization/browser/tokenization';
declare module 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter';
declare module 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators';
declare module 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
declare module 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
declare module 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations';
declare module 'monaco-editor/features/find/register';

declare module 'monaco-editor/languages/features/typescript/tsWorker' {
	export class TypeScriptWorker {
		constructor(ctx: unknown, createData: unknown);
		getScriptFileNames(): string[];
	}
}

declare module 'monaco-editor/internal/common/initialize' {
	export function initialize(callback: (ctx: unknown, createData: unknown) => object): void;
}
