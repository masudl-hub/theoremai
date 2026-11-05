import {
  Field,
  type InputStatus,
  inputStatusBorderStyles,
  inputStatusFocusWithinStyles,
  inputWrapperStyles,
} from '@astryxdesign/core/Field';
import { HStack } from '@astryxdesign/core/Stack';
import type { StyleXStyles } from '@stylexjs/stylex';
import type * as Monaco from 'monaco-editor';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
import { useEffect, useId, useRef } from 'react';
import { tabFills } from '../lib/tab-fills.ts';
import { editor, serveMonacoWorkers, studioMonacoTheme } from './studio-monaco.ts';

const LINE_HEIGHT = 20;
const PADDING = 8;

// why: the kernel checks what a schema says; Monaco only says where the JSON breaks.
jsonDefaults.setDiagnosticsOptions({
  validate: true,
  allowComments: false,
  comments: 'error',
  trailingCommas: 'error',
  schemaValidation: 'ignore',
  schemaRequest: 'ignore',
});
jsonDefaults.setModeConfiguration({
  documentFormattingEdits: true,
  documentRangeFormattingEdits: true,
  diagnostics: true,
  foldingRanges: true,
  selectionRanges: true,
  tokens: true,
});
const workers = serveMonacoWorkers();

const FIELD_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  language: 'json',
  automaticLayout: true,
  // why: under EditContext a focused field took no Cmd+A.
  editContext: false,
  fixedOverflowWidgets: true,
  folding: true,
  fontFamily: 'var(--font-family-code)',
  fontSize: 12,
  formatOnPaste: true,
  glyphMargin: false,
  guides: { bracketPairs: false, indentation: false },
  hideCursorInOverviewRuler: true,
  lineDecorationsWidth: 0,
  lineHeight: LINE_HEIGHT,
  lineNumbers: 'off',
  lineNumbersMinChars: 0,
  links: false,
  minimap: { enabled: false },
  occurrencesHighlight: 'off',
  overviewRulerBorder: false,
  overviewRulerLanes: 0,
  padding: { top: PADDING, bottom: PADDING },
  quickSuggestions: false,
  renderLineHighlight: 'none',
  // why: the field is as tall as its text, so the wheel belongs to the panel around it.
  scrollbar: {
    alwaysConsumeMouseWheel: false,
    handleMouseWheel: false,
    horizontal: 'hidden',
    vertical: 'hidden',
  },
  scrollBeyondLastLine: false,
  selectionHighlight: false,
  showFoldingControls: 'mouseover',
  stickyScroll: { enabled: false },
  suggestOnTriggerCharacters: false,
  tabSize: 2,
  wordBasedSuggestions: 'off',
  wordWrap: 'on',
  wrappingIndent: 'indent',
};

export interface JsonCodeProps {
  label: string;
  value: string;
  placeholder: string | undefined;
  /** A placeholder that is a value, for Tab to take up. */
  fills: string | undefined;
  status: InputStatus | undefined;
  onChange: (next: string) => void;
}

/** JSON as code, in a field as tall as its text. */
export function JsonCode({ label, value, placeholder, fills, status, onChange }: JsonCodeProps) {
  const id = useId();
  const node = useRef<HTMLDivElement>(null);
  const code = useRef<Monaco.editor.IStandaloneCodeEditor>(undefined);
  const latest = useRef({ value, placeholder, fills, onChange });
  latest.current = { value, placeholder, fills, onChange };

  useEffect(() => {
    const host = node.current;
    if (!host) return;
    let disposed = false;
    void workers.then(() => {
      if (disposed) return;
      const field = editor.create(host, {
        ...FIELD_OPTIONS,
        ariaLabel: label,
        placeholder: latest.current.placeholder,
        theme: studioMonacoTheme(),
        value: latest.current.value,
      });
      code.current = field;
      const fit = () => {
        const shown = field.getValue() === '' ? latest.current.placeholder : undefined;
        const lines = shown?.split('\n').length ?? 1;
        const blank = lines * LINE_HEIGHT + 2 * PADDING;
        host.style.height = `${String(Math.max(field.getContentHeight(), blank))}px`;
      };
      field.onDidContentSizeChange(fit);
      field.onDidChangeModelContent(() => {
        const next = field.getValue();
        if (next !== latest.current.value) latest.current.onChange(next);
      });
      field.onKeyDown((event) => {
        const { value: text, fills: example, onChange: change } = latest.current;
        tabFills(text, example, change)(event.browserEvent);
      });
      fit();
    });
    return () => {
      disposed = true;
      code.current?.dispose();
      code.current = undefined;
    };
  }, [label]);

  useEffect(() => {
    if (code.current && code.current.getValue() !== value) code.current.setValue(value);
  }, [value]);

  return (
    <Field label={label} isLabelHidden inputID={id} status={status}>
      <HStack
        // why: Astryx's own input styles hold a media-query shadow its `xstyle` type refuses.
        xstyle={
          [
            inputWrapperStyles.base,
            status && inputStatusBorderStyles[status.type],
            status && inputStatusFocusWithinStyles[status.type],
          ] as unknown as StyleXStyles
        }
        className="json-code"
      >
        <div ref={node} id={id} className="json-code-host" />
      </HStack>
    </Field>
  );
}
