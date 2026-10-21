import { TextArea } from '@astryxdesign/core/TextArea';
import { base64Bytes, type EmbeddingInput } from '@theoremjs/agents';
import {
  checkInputs,
  type EmbeddingFields,
  encodeFiles,
  fieldsInput,
  inputFields,
  readEmbeddingInput,
} from '@theoremjs/web/client';
import { useState } from 'react';
import { type ConsoleView, JsonRequest, RequestCard, RunBar, useBytes } from './ConsoleFrame.tsx';
import {
  EmbeddingFileDrop,
  FileTile,
  inputIssue,
  type Rules,
  TextBesideFile,
} from './EmbeddingDocuments.tsx';
import type { LabelText } from './labels.ts';
import { useLabels } from './labels-provider.tsx';
import { textRows } from './StateFields.tsx';

/** Where the embedded documents stand for a search: as embedded, or changed since. */
export type IndexState = 'fresh' | 'stale' | 'model';

/** The query, held as the JSON of the one input it sends, and the view it is edited in. */
export function useEmbeddingQuery(defaultQuery: string, rules: Rules) {
  const t = useLabels();
  const [json, setJson] = useState(() => JSON.stringify(defaultQuery));
  const input = readEmbeddingInput(json);
  const fields = input === undefined ? null : inputFields(input);
  const [view, setView] = useState<ConsoleView>('fields');
  const issue =
    input === undefined
      ? t('@theorem.embedding.query_invalid_json')
      : inputIssue(t, checkInputs([input], rules), t('@theorem.embedding.query'));
  return {
    json,
    setJson,
    input,
    fields,
    issue,
    shown: fields === null ? ('json' as const) : view,
    setView,
    setFields: (next: EmbeddingFields) => {
      setJson(JSON.stringify(fieldsInput(next), null, 2));
    },
  };
}

export type EmbeddingQueryForm = ReturnType<typeof useEmbeddingQuery>;

/** The query's one file, or a drop for it when the profile takes files. */
function QueryFile({
  fields,
  accept,
  onChange,
}: {
  fields: EmbeddingFields;
  accept: readonly string[] | undefined;
  onChange: (next: EmbeddingFields) => void;
}) {
  const t = useLabels();
  const bytes = useBytes();
  const part = fields.media[0];
  if (part) {
    const size =
      part.type === 'media' ? bytes(base64Bytes(part.data)) : t('@theorem.embedding.held_file');
    return (
      <FileTile
        part={part}
        label={[part.mimeType, size].join(' · ')}
        onRemove={() => {
          onChange({ ...fields, media: [] });
        }}
      />
    );
  }
  if (!accept) return null;
  return (
    <EmbeddingFileDrop
      label={t('@theorem.embedding.query_file')}
      placeholder={t('@theorem.embedding.query_file')}
      accept={accept}
      onFiles={async (files) => {
        const encoded = await encodeFiles(files);
        onChange({
          ...fields,
          media: encoded.map(({ mimeType, data }) => ({
            type: 'media' as const,
            mimeType,
            data,
          })),
        });
      }}
    />
  );
}

/** The query's words, and one file to search with when the profile takes files. */
function QueryFields({
  fields,
  rules,
  onChange,
}: {
  fields: EmbeddingFields;
  rules: Rules;
  onChange: (next: EmbeddingFields) => void;
}) {
  const t = useLabels();
  const accept = rules.attachments?.accept;
  const text = rules.text ? (
    <TextArea
      label={t('@theorem.embedding.query')}
      isLabelHidden
      value={fields.text}
      placeholder={t('@theorem.embedding.query_placeholder')}
      rows={textRows(fields.text, 2, 6)}
      onChange={(next) => {
        onChange({ ...fields, text: next });
      }}
    />
  ) : null;
  const hasFile = fields.media.length > 0 || accept !== undefined;
  const file = hasFile ? <QueryFile fields={fields} accept={accept} onChange={onChange} /> : null;
  return <TextBesideFile text={text} file={file} />;
}

/** What stands between the query and a search, once someone has tried one. */
function queryNote(
  t: LabelText,
  form: EmbeddingQueryForm,
  index: IndexState,
  tried: boolean,
): string | null {
  if (!tried) return null;
  if (form.issue) return form.issue;
  if (index === 'stale') return t('@theorem.embedding.stale');
  if (index === 'model') return t('@theorem.embedding.remodelled');
  return null;
}

/** The query card: its words and file, or its input as JSON, and Search. */
export function EmbeddingQuery({
  form,
  rules,
  index,
  isRunning,
  onRun,
  onStop,
}: {
  form: EmbeddingQueryForm;
  rules: Rules;
  index: IndexState;
  isRunning: boolean;
  onRun: (input: EmbeddingInput) => void;
  onStop: () => void;
}) {
  const t = useLabels();
  const { input } = form;
  const isReady = form.issue === null && index === 'fresh' && input !== undefined;
  // why: What blocks a search is said only once someone tries one, not before they have started.
  const [tried, setTried] = useState(false);
  const run = () => {
    setTried(true);
    if (isReady) onRun(input);
  };
  return (
    <RequestCard
      title={t('@theorem.embedding.query')}
      view={form.shown}
      hasFields={form.fields !== null}
      onView={form.setView}
      onRun={run}
    >
      {form.shown === 'fields' && form.fields !== null ? (
        <QueryFields fields={form.fields} rules={rules} onChange={form.setFields} />
      ) : (
        <JsonRequest
          label={t('@theorem.embedding.query')}
          text={form.json}
          isInvalid={input === undefined}
          onChange={form.setJson}
        />
      )}
      <RunBar
        note={queryNote(t, form, index, tried)}
        isReady={isReady || !tried}
        isRunning={isRunning}
        runLabel={t('@theorem.embedding.search')}
        runningLabel={t('@theorem.embedding.searching')}
        stopLabel={t('@theorem.embedding.stop')}
        onRun={run}
        onStop={onStop}
      />
    </RequestCard>
  );
}
