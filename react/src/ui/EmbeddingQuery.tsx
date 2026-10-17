import { FileInput } from '@astryxdesign/core/FileInput';
import { HStack } from '@astryxdesign/core/HStack';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { base64Bytes, type EmbeddingInput } from '@theoremjs/agents';
import { useState } from 'react';
import {
  checkInputs,
  type EmbeddingFields,
  fieldsInput,
  inputFields,
  readEmbeddingInput,
} from '../client/embedding-input.ts';
import type { EmbeddingInterface } from '../client/embedding-transport.ts';
import { encodeFiles } from '../client/encode-files.ts';
import { type ConsoleView, JsonRequest, RequestCard, RunBar, useBytes } from './ConsoleFrame.tsx';
import { inputIssue } from './EmbeddingDocuments.tsx';
import type { LabelText } from './labels.ts';
import { useLabels } from './labels-provider.tsx';
import { textRows } from './StateFields.tsx';

type Rules = EmbeddingInterface['inputs'];

/** Where the documents stand for a search: none embedded, embedded, or changed since. */
export type IndexState = 'none' | 'fresh' | 'stale';

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
  const bytes = useBytes();
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const accept = rules.attachments?.accept;
  return (
    <VStack gap={2}>
      {rules.text ? (
        <TextArea
          label={t('@theorem.embedding.query')}
          isLabelHidden
          value={fields.text}
          placeholder={t('@theorem.embedding.query_placeholder')}
          rows={textRows(fields.text, 2, 6)}
          onChange={(text) => {
            onChange({ ...fields, text });
          }}
        />
      ) : null}
      {fields.media.length > 0 ? (
        <HStack gap={2} wrap="wrap">
          {fields.media.map((part, at) => (
            <Token
              // why: A file has no name in the request; its place on the query is its identity.
              key={`${String(at)}:${part.mimeType}`}
              label={part.mimeType}
              size="sm"
              description={
                part.type === 'media'
                  ? bytes(base64Bytes(part.data))
                  : t('@theorem.embedding.held_file')
              }
              onRemove={() => {
                onChange({ ...fields, media: fields.media.filter((_, other) => other !== at) });
              }}
            />
          ))}
        </HStack>
      ) : accept ? (
        <FileInput
          label={t('@theorem.embedding.query_file')}
          isLabelHidden
          mode="input"
          accept={accept.join(',')}
          value={null}
          placeholder={t('@theorem.embedding.query_file')}
          status={unreadable ? { type: 'error', message: unreadable } : undefined}
          onChange={(files) => {
            const list = files === null ? [] : Array.isArray(files) ? files : [files];
            if (list.length === 0) return;
            setUnreadable(null);
            encodeFiles(list).then(
              (encoded) => {
                onChange({
                  ...fields,
                  media: encoded.map(({ mimeType, data }) => ({
                    type: 'media' as const,
                    mimeType,
                    data,
                  })),
                });
              },
              () => {
                setUnreadable(
                  t('@theorem.embedding.unreadable', {
                    name: list.map((file) => file.name).join(', '),
                  }),
                );
              },
            );
          }}
        />
      ) : null}
    </VStack>
  );
}

/** What stands between the query and a search, or the shortcut. */
function queryNote(t: LabelText, form: EmbeddingQueryForm, index: IndexState): string {
  if (form.issue) return form.issue;
  if (index === 'none') return t('@theorem.embedding.not_indexed');
  if (index === 'stale') return t('@theorem.embedding.stale');
  return t('@theorem.embedding.search_shortcut');
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
  const run = () => {
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
        note={queryNote(t, form, index)}
        isReady={isReady}
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
