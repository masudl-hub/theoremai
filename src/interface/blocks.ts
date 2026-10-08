import type { Source, ToolCallEvent, TurnEvent, TurnEventOf } from '../kernel/types.ts';
import { applyToolEvent } from './tool-calls.ts';
import { collectPromotedMediaFromToolOutput } from './tool-media.ts';
import type {
  CitationBlock,
  FoldTurnEventsOptions,
  ToolBlock,
  TranscriptBlock,
  UserTurnDraft,
} from './types.ts';

let turnBlockCounter = 0;

/**
 * User block ids are random: a counter restarts wherever this module loads
 * again (a hot reload, a second bundled copy) and would reuse an id already on
 * screen. Turn block ids count from each fold so streaming refolds keep keys.
 */
function nextBlockId(prefix: string): string {
  if (prefix === 'user') return `user-${globalThis.crypto.randomUUID()}`;
  turnBlockCounter += 1;
  return `${prefix}-${String(turnBlockCounter)}`;
}

/** Restarts block id numbering at zero. */
function resetBlockIds(): void {
  turnBlockCounter = 0;
}

function isAppendableTextBlock(
  block: TranscriptBlock | undefined,
  kind: 'text' | 'thought',
): block is Extract<TranscriptBlock, { kind: 'text' | 'thought' }> {
  return block?.kind === kind;
}

function appendText(
  blocks: TranscriptBlock[],
  kind: 'text' | 'thought',
  text: string,
  idPrefix: string,
): void {
  const last = blocks.at(-1);
  if (isAppendableTextBlock(last, kind)) {
    last.text += text;
    return;
  }
  blocks.push({
    id: nextBlockId(idPrefix),
    kind,
    text,
  });
}

/**
 * A decision made while text streams goes ahead of that text's block, so the block stays last and
 * the rest of the text joins it.
 */
function addGuardrailBlock(blocks: TranscriptBlock[], block: TranscriptBlock): void {
  const last = blocks.at(-1);
  const streaming = last?.kind === 'text' || last?.kind === 'thought';
  blocks.splice(streaming ? blocks.length - 1 : blocks.length, 0, block);
}

/** One block per call, keyed by `callId`; each event folds into it (`applyToolEvent`). */
function upsertToolBlock(blocks: TranscriptBlock[], tool: ToolCallEvent): void {
  const id = `tool-${tool.callId}`;
  const existing = blocks.find(
    (block): block is ToolBlock => block.kind === 'tool' && block.id === id,
  );
  const call = applyToolEvent(existing?.tool, tool);
  if (existing) {
    existing.tool = call;
    return;
  }
  blocks.push({ id, kind: 'tool', tool: call });
}

/** Same source: one place, or one link. */
function sameSource(a: Source, b: Source): boolean {
  if (a.type !== b.type) return false;
  if (a.placeId && b.placeId) return a.placeId === b.placeId;
  return a.uri === b.uri;
}

/**
 * One sources row per citer: the provider's grounding (no `callId`) or one
 * tool call. A stream cites the same places more than once (the search result
 * lists them, then the answer's annotations cite them), so later citations
 * fold into the row with each source listed once.
 */
function foldCitation(
  blocks: TranscriptBlock[],
  event: TurnEventOf<'citation'>,
  idPrefix: string,
): void {
  const existing = blocks.find(
    (block): block is CitationBlock => block.kind === 'citation' && block.callId === event.callId,
  );
  const sources = existing ? [...existing.sources] : [];
  for (const source of event.sources) {
    if (!sources.some((seen) => sameSource(seen, source))) sources.push(source);
  }
  if (existing) {
    existing.sources = sources;
    return;
  }
  blocks.push({
    id: nextBlockId(idPrefix),
    kind: 'citation',
    sources,
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
  });
}

function appendPromotedToolMedia(
  blocks: TranscriptBlock[],
  tool: ToolCallEvent,
  idPrefix: string,
  seenUrls: Set<string>,
): void {
  if (tool.phase !== 'complete' || tool.output === undefined) return;
  for (const media of collectPromotedMediaFromToolOutput(tool.output)) {
    if (seenUrls.has(media.url)) continue;
    seenUrls.add(media.url);
    blocks.push({
      id: nextBlockId(idPrefix),
      kind: 'media',
      mimeType: media.mimeType,
      url: media.url,
      ...(media.previewUrl ? { previewUrl: media.previewUrl } : {}),
    });
  }
}

/** Turns a user draft into transcript blocks: a `user-text` block for the trimmed text, then one block per attachment and per voice clip. */
function buildUserTurnBlocks(draft: UserTurnDraft, idPrefix = 'user'): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const text = draft.text?.trim();
  if (text) {
    blocks.push({
      id: nextBlockId(idPrefix),
      kind: 'user-text',
      text,
    });
  }
  for (const file of draft.attachments ?? []) {
    blocks.push({
      id: nextBlockId(idPrefix),
      kind: 'user-attachment',
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      ...(file.data !== undefined ? { data: file.data } : {}),
    });
  }
  for (const file of draft.voice ?? []) {
    blocks.push({
      id: nextBlockId(idPrefix),
      kind: 'user-voice',
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      ...(file.data !== undefined ? { data: file.data } : {}),
    });
  }
  return blocks;
}

/** Resets only the turn id sequence, so streaming refolds keep stable `turn-*` keys. */
function foldTurnEvents(
  events: readonly TurnEvent[],
  options: FoldTurnEventsOptions = {},
): TranscriptBlock[] {
  const idPrefix = options.idPrefix ?? 'turn';
  const showThoughts = options.showThoughts ?? true;
  turnBlockCounter = 0;

  const blocks: TranscriptBlock[] = [];
  const promotedMediaUrls = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case 'thought':
        if (showThoughts && event.text) {
          appendText(blocks, 'thought', event.text, idPrefix);
        }
        break;
      case 'text':
        if (event.text) {
          appendText(blocks, 'text', event.text, idPrefix);
        }
        break;
      case 'tool':
        upsertToolBlock(blocks, event.tool);
        appendPromotedToolMedia(blocks, event.tool, idPrefix, promotedMediaUrls);
        break;
      case 'structured':
        blocks.push({
          id: nextBlockId(idPrefix),
          kind: 'structured',
          value: event.structured,
        });
        break;
      case 'media':
        if (event.media) {
          blocks.push({
            id: nextBlockId(idPrefix),
            kind: 'media',
            mimeType: event.media.mimeType,
            data: event.media.data,
          });
        }
        break;
      case 'grounding':
        blocks.push({
          id: nextBlockId(idPrefix),
          kind: 'grounding',
          grounding: event.grounding,
        });
        break;
      case 'citation':
        foldCitation(blocks, event, idPrefix);
        break;
      case 'evidence':
        blocks.push({
          id: nextBlockId(idPrefix),
          kind: 'evidence',
          evidence: event.evidence,
        });
        break;
      case 'guardrail':
        addGuardrailBlock(blocks, {
          id: nextBlockId(idPrefix),
          kind: 'guardrail',
          guardrail: event.guardrail,
        });
        break;
      case 'error':
        if (event.error) {
          blocks.push({
            id: nextBlockId(idPrefix),
            kind: 'error',
            message: event.error,
          });
        }
        break;
      case 'done':
        blocks.push({
          id: nextBlockId(idPrefix),
          kind: 'turn-done',
          stop: event.stop,
          tokens: event.tokens,
          interactionId: event.interactionId,
          compaction: event.compaction !== undefined,
        });
        break;
      case 'tokens':
      case 'session':
      case 'stage':
        break;
      default:
        break;
    }
  }

  return blocks;
}

/** One conversation turn as blocks: the user draft's blocks followed by the assistant events folded into blocks. */
function foldConversationTurn(
  draft: UserTurnDraft,
  assistantEvents: readonly TurnEvent[],
  options: FoldTurnEventsOptions = {},
): TranscriptBlock[] {
  return [...buildUserTurnBlocks(draft, 'user'), ...foldTurnEvents(assistantEvents, options)];
}

export { buildUserTurnBlocks, foldConversationTurn, foldTurnEvents, resetBlockIds };
