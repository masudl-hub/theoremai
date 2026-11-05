/**
 * The Monaco editor and the contributions this view uses, without the other
 * language grammars. `editor.api` is the widget. Typing, suggestions, hover,
 * and find are registered below.
 *
 * Semantic tokens, inlay hints, and inline completions are left out. They ask
 * the typechecker to walk the file continuously, which is the memory we are
 * keeping down.
 */
import { editor, languages, MarkerSeverity, Uri } from 'monaco-editor/editor/editor.api';

// Monaco's package exports append `.js`, so its icon sheets cannot be imported by specifier;
// the studio's Vite plugin resolves these two to the host's install.
import 'virtual:studio-codicons/codicon.css';
import 'virtual:studio-codicons/codicon-modifiers.css';
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget';
import 'monaco-editor/editor/common/standaloneStrings';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/comment/browser/comment';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution';
import 'monaco-editor/editor/contrib/indentation/browser/indentation';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations';
import 'monaco-editor/editor/contrib/links/browser/links';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints';
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations';
import 'monaco-editor/features/find/register';

/** `self` in the browser, which Monaco reads for its workers. */
interface MonacoHost {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}

/** Gives Monaco its workers: JSON's own, and the editor's for the rest. */
export async function serveMonacoWorkers() {
  const [{ default: EditorWorker }, { default: JsonWorker }] = await Promise.all([
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/languages/features/json/json.worker?worker'),
  ]);
  (self as MonacoHost).MonacoEnvironment = {
    getWorker(_id, label) {
      return label === 'json' ? new JsonWorker() : new EditorWorker();
    },
  };
}

/** The Monaco theme for the page's colour scheme. */
export function studioMonacoTheme() {
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'vs-dark' : 'vs';
}

export { editor, languages, MarkerSeverity, Uri };
