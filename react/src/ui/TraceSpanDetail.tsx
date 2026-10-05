import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip as HoverTip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { IconArrowLeft, IconX } from '@tabler/icons-react';
import {
  inlineContent,
  TRACE_ATTRIBUTE_GROUPS,
  TRACE_FIELDS,
  TRACE_SPAN_TYPES,
  TRACE_STATUS,
  type TraceAttributeMeta,
  type TraceOptionMeta,
  traceAttributeMeta,
  traceEventAttributeMeta,
  traceEventMeta,
} from '@theoremjs/agents';
import type { ReactNode } from 'react';
import { messageText, storedValue, traceActor, traceOutcome } from '../client/trace-story.ts';
import { nanosToMs, type TraceNode } from '../client/trace-view.ts';
import { keyedByContent } from './row-keys.ts';
import { ShapedData } from './ShapedData.tsx';
import { ActorMark } from './TraceStory.tsx';
import {
  attributeSections,
  TRACE_LABEL_PX,
  TraceAttributeList,
  TraceValue,
  useTraceFormat,
} from './TraceValues.tsx';

/** A span's own field, read as an attribute of that format. */
function fieldMeta(
  field: TraceOptionMeta,
  format: TraceAttributeMeta['format'],
): TraceAttributeMeta {
  return { ...field, format, group: 'record' };
}

const SPAN_FIELD_META = {
  type: { ...fieldMeta(TRACE_FIELDS.type, 'text'), options: TRACE_SPAN_TYPES },
  status: { ...fieldMeta(TRACE_FIELDS.status, 'text'), options: TRACE_STATUS },
  start: fieldMeta(TRACE_FIELDS.start, 'time'),
  traceId: fieldMeta(TRACE_FIELDS.traceId, 'id'),
  spanId: fieldMeta(TRACE_FIELDS.spanId, 'id'),
} satisfies Record<string, TraceAttributeMeta>;

function spanFieldMeta(key: string): TraceAttributeMeta | undefined {
  return key in SPAN_FIELD_META ? SPAN_FIELD_META[key as keyof typeof SPAN_FIELD_META] : undefined;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible defaultIsOpen={false} trigger={<Text weight="medium">{title}</Text>}>
      {children}
    </Collapsible>
  );
}

function EventList({ node }: { node: TraceNode }) {
  const format = useTraceFormat();
  return (
    <VStack gap={3}>
      {keyedByContent(node.span.events, (event) => `${event.name}:${event.timeUnixNano}`).map(
        ({ item: event, key }) => {
          const offset = format.t('@theorem.panel.trace.offset', {
            duration: format.duration(nanosToMs(event.timeUnixNano) - node.startMs),
          });
          const label = traceEventMeta(event.name)?.label ?? event.name;
          return (
            <VStack key={key} gap={1}>
              <HStack gap={2} align="center">
                <Text weight="medium">{label}</Text>
                <Text type="supporting" hasTabularNumbers>
                  {offset}
                </Text>
              </HStack>
              <TraceAttributeList
                record={node.record}
                attributes={event.attributes}
                metaOf={(key) => traceEventAttributeMeta(event.name, key)}
              />
            </VStack>
          );
        },
      )}
    </VStack>
  );
}

function LinkList({ node }: { node: TraceNode }) {
  return (
    <VStack gap={3}>
      {node.span.links.map((link) => (
        <TraceAttributeList
          key={`${link.traceId}:${link.spanId}`}
          record={node.record}
          attributes={{ traceId: link.traceId, spanId: link.spanId, ...link.attributes }}
          metaOf={(key) => spanFieldMeta(key) ?? traceAttributeMeta(key)}
        />
      ))}
    </VStack>
  );
}

const SPAN_FIELD_VALUES = {
  type: (node) => node.meta.type,
  start: (node) => node.span.startTimeUnixNano,
  traceId: (node) => node.span.traceId,
  spanId: (node) => node.span.spanId,
} satisfies Partial<Record<keyof typeof SPAN_FIELD_META, (node: TraceNode) => string>>;

/** What the span was, how long it took, what it cost and when it started. */
function spanFacts(
  node: TraceNode,
  turnStartMs: number,
  format: ReturnType<typeof useTraceFormat>,
): string {
  const cost = node.span.attributes['theorem.usage.cost_usd'];
  return [
    node.meta.label,
    format.duration(node.durationMs),
    ...(typeof cost === 'number' ? [format.usd(cost)] : []),
    format.t('@theorem.panel.trace.offset', {
      duration: format.duration(node.startMs - turnStartMs),
    }),
  ].join(format.t('@theorem.panel.trace.separator'));
}

function OutcomeBadge({ outcome }: { outcome: ReturnType<typeof traceOutcome> }) {
  if (!outcome) return null;
  return (
    <HoverTip content={outcome.doc ?? outcome.label}>
      <Badge variant={outcome.tone} label={outcome.label} />
    </HoverTip>
  );
}

/** The span's status message, unless the outcome badge already says it. */
function StatusMessage({
  node,
  outcome,
}: {
  node: TraceNode;
  outcome: ReturnType<typeof traceOutcome>;
}) {
  const message = node.span.status.message;
  if (!message || message.toLowerCase() === outcome?.label.toLowerCase()) return null;
  return <Text color="secondary">{message}</Text>;
}

/** Back (or close), then who acted, what it was, how it ended, how long it took and what it cost. */
function SpanHeader({
  node,
  turnStartMs,
  onBack,
  isClose,
}: {
  node: TraceNode;
  turnStartMs: number;
  onBack: () => void;
  isClose: boolean;
}) {
  const format = useTraceFormat();
  const outcome = traceOutcome(node);
  return (
    <VStack gap={2}>
      <HStack>
        <Button
          label={format.t(isClose ? '@theorem.panel.trace.close' : '@theorem.panel.trace.back')}
          variant="ghost"
          size="sm"
          icon={<Icon icon={isClose ? IconX : IconArrowLeft} />}
          onClick={onBack}
        />
      </HStack>
      <Item
        startContent={<ActorMark actor={traceActor(node)} />}
        label={<Text weight="semibold">{node.meta.subject ?? node.meta.label}</Text>}
        description={spanFacts(node, turnStartMs, format)}
        endContent={<OutcomeBadge outcome={outcome} />}
        align="start"
      />
      <StatusMessage node={node} outcome={outcome} />
    </VStack>
  );
}

function Panel({ title, doc, children }: { title: string; doc?: string; children: ReactNode }) {
  return (
    <Card padding={3} variant="muted" style={{ background: 'var(--color-background-surface)' }}>
      <VStack gap={2}>
        <HoverTip content={doc ?? title}>
          <Text type="supporting" color="secondary">
            {title}
          </Text>
        </HoverTip>
        {children}
      </VStack>
    </Card>
  );
}

function Prose({ text }: { text: string }) {
  return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</span>;
}

type Message = { role?: unknown; parts?: unknown };
type Part = {
  type?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
  response?: unknown;
  result?: unknown;
};

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ToolCallPart({ part }: { part: Part }) {
  return (
    <VStack gap={1}>
      <Text weight="medium">{String(part.name ?? '')}</Text>
      <ShapedData value={parsed(part.arguments)} />
    </VStack>
  );
}

/** One message part: its text, or a tool call's name and arguments, or what a tool returned. */
function PartView({ part }: { part: Part }) {
  if (part.type === 'text' && typeof part.content === 'string')
    return <Prose text={part.content} />;
  if (part.type === 'tool_call') return <ToolCallPart part={part} />;
  const body = part.response ?? part.result ?? part.content;
  return body === undefined ? null : <ShapedData value={parsed(body)} />;
}

/** Messages as the model saw them: each one's role, then its parts. */
function MessageList({ messages }: { messages: readonly Message[] }) {
  return (
    <VStack gap={3}>
      {keyedByContent(messages, (message) => JSON.stringify(message)).map(
        ({ item: message, key }) => (
          <VStack key={key} gap={1}>
            <HStack>
              <Token label={String(message.role ?? '')} size="sm" color="gray" />
            </HStack>
            {Array.isArray(message.parts)
              ? keyedByContent(message.parts.filter(isObject), (part) => JSON.stringify(part)).map(
                  ({ item: part, key: partKey }) => <PartView key={partKey} part={part} />,
                )
              : null}
          </VStack>
        ),
      )}
    </VStack>
  );
}

function messagesOf(node: TraceNode, key: string): Message[] {
  const value = inlineContent(node.record, node.span.attributes[key]);
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function label(key: string): { title: string; doc?: string } {
  const meta = traceAttributeMeta(key);
  return meta ? { title: meta.label, doc: meta.doc } : { title: key };
}

/** A stored value under its attribute's name; nothing when the span has none. */
function DataPanel({ attribute, value }: { attribute: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <Panel {...label(attribute)}>
      <ShapedData value={value} />
    </Panel>
  );
}

/** Text under its attribute's name; nothing when there is none. */
function ProsePanel({ attribute, text }: { attribute: string; text: unknown }) {
  if (typeof text !== 'string' || !text) return null;
  return (
    <Panel {...label(attribute)}>
      <Prose text={text} />
    </Panel>
  );
}

function TurnIO({ node }: { node: TraceNode }) {
  return (
    <>
      <ProsePanel
        attribute="gen_ai.input.messages"
        text={messageText(node, 'gen_ai.input.messages', 'user')}
      />
      <ProsePanel
        attribute="gen_ai.output.messages"
        text={messageText(node, 'gen_ai.output.messages', 'assistant')}
      />
    </>
  );
}

function CallIO({ node }: { node: TraceNode }) {
  const input = messagesOf(node, 'gen_ai.input.messages');
  const output = messagesOf(node, 'gen_ai.output.messages');
  return (
    <>
      {output.length > 0 ? (
        <Panel {...label('gen_ai.output.messages')}>
          <MessageList messages={output} />
        </Panel>
      ) : null}
      {input.length > 0 ? (
        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text weight="medium">{`${label('gen_ai.input.messages').title} · ${input.length}`}</Text>
          }
        >
          <Card
            padding={3}
            variant="muted"
            style={{ background: 'var(--color-background-surface)' }}
          >
            <MessageList messages={input} />
          </Card>
        </Collapsible>
      ) : null}
    </>
  );
}

function ToolIO({ node }: { node: TraceNode }) {
  const { attributes } = node.span;
  const result =
    'theorem.tool.data' in attributes ? 'theorem.tool.data' : 'gen_ai.tool.call.result';
  return (
    <>
      <DataPanel
        attribute="gen_ai.tool.call.arguments"
        value={storedValue(node, 'gen_ai.tool.call.arguments')}
      />
      <DataPanel attribute={result} value={storedValue(node, result)} />
      <ProsePanel
        attribute="exception.message"
        text={
          'exception.message' in attributes ? storedValue(node, 'exception.message') : undefined
        }
      />
    </>
  );
}

/** What went in and what came out, read the way a person would: text, messages, or a tool's data. */
function SpanIO({ node }: { node: TraceNode }) {
  switch (node.meta.type) {
    case 'turn':
      return <TurnIO node={node} />;
    case 'call':
    case 'response':
      return <CallIO node={node} />;
    case 'tool':
      return <ToolIO node={node} />;
    default:
      return null;
  }
}

/** The span's own fields: its type, start and IDs. */
function SpanFields({ node }: { node: TraceNode }) {
  return (
    <MetadataList columns="single" label={{ position: 'start', width: TRACE_LABEL_PX }}>
      {(Object.keys(SPAN_FIELD_VALUES) as (keyof typeof SPAN_FIELD_VALUES)[]).map((key) => (
        <MetadataListItem key={key} label={SPAN_FIELD_META[key].label}>
          <TraceValue
            record={node.record}
            meta={SPAN_FIELD_META[key]}
            value={SPAN_FIELD_VALUES[key](node)}
          />
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}

/** The record's host resource and request metadata, shown on the span that roots the record. */
function RecordSections({ node }: { node: TraceNode }) {
  const { record } = node;
  if (record.spans[0]?.spanId !== node.span.spanId) return null;
  return (
    <>
      {Object.keys(record.resource).length > 0 ? (
        <Section title={TRACE_FIELDS.resource.label}>
          <TraceAttributeList
            record={record}
            attributes={record.resource}
            metaOf={traceAttributeMeta}
          />
        </Section>
      ) : null}
      {record.metadata ? (
        <Section title={TRACE_FIELDS.metadata.label}>
          <TraceAttributeList
            record={record}
            attributes={record.metadata}
            metaOf={() => undefined}
          />
        </Section>
      ) : null}
    </>
  );
}

/** One span in full: who acted and how it ended, what went in and came out, its tokens, then every detail it recorded. */
export function TraceSpanDetail({
  node,
  turnStartMs,
  isClose = false,
  onBack,
  onOpen,
}: {
  node: TraceNode;
  turnStartMs: number;
  /** In the wide panel the span sits beside the turn: close, not back. */
  isClose?: boolean;
  onBack: () => void;
  onOpen: (node: TraceNode) => void;
}) {
  const format = useTraceFormat();
  const { t } = format;
  const { span, record } = node;
  const sections = attributeSections(span.attributes);
  const usage = sections.find((section) => section.key === 'usage');
  return (
    <VStack gap={4}>
      <SpanHeader node={node} turnStartMs={turnStartMs} onBack={onBack} isClose={isClose} />
      <SpanIO node={node} />
      {usage ? (
        <Panel title={TRACE_ATTRIBUTE_GROUPS.usage.label} doc={TRACE_ATTRIBUTE_GROUPS.usage.doc}>
          <TraceAttributeList
            record={record}
            attributes={usage.attributes}
            metaOf={traceAttributeMeta}
          />
        </Panel>
      ) : null}
      {node.children.length > 0 ? (
        <Panel title={TRACE_FIELDS.children.label} doc={TRACE_FIELDS.children.doc}>
          <VStack gap={0}>
            {node.children.map((child) => (
              <Item
                key={child.id}
                startContent={<ActorMark actor={traceActor(child)} />}
                label={child.meta.subject ?? child.meta.label}
                description={child.meta.label}
                endContent={
                  <Text type="supporting" hasTabularNumbers>
                    {format.duration(child.durationMs)}
                  </Text>
                }
                density="compact"
                onClick={() => onOpen(child)}
              />
            ))}
          </VStack>
        </Panel>
      ) : null}
      <Collapsible
        defaultIsOpen={false}
        trigger={<Text weight="medium">{t('@theorem.panel.trace.details')}</Text>}
      >
        <VStack gap={3}>
          <SpanFields node={node} />
          {sections
            .filter((section) => section !== usage)
            .map((section) => (
              <Section
                key={section.key}
                title={
                  section.key === 'other'
                    ? t('@theorem.panel.trace.other')
                    : TRACE_ATTRIBUTE_GROUPS[section.key].label
                }
              >
                <TraceAttributeList
                  record={record}
                  attributes={section.attributes}
                  metaOf={traceAttributeMeta}
                />
              </Section>
            ))}
          {span.events.length > 0 ? (
            <Section title={TRACE_FIELDS.events.label}>
              <EventList node={node} />
            </Section>
          ) : null}
          {span.links.length > 0 ? (
            <Section title={TRACE_FIELDS.links.label}>
              <LinkList node={node} />
            </Section>
          ) : null}
          <RecordSections node={node} />
        </VStack>
      </Collapsible>
    </VStack>
  );
}
