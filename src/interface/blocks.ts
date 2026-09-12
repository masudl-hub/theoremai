/**
 * Turn event folding — map kernel `TurnEvent` streams to transcript blocks.
 *
 * @module
 */

import type { TurnEvent } from '../kernel/types.ts';
import { collectPromotedMediaFromToolOutput } from './tool-media.ts';
import type { FoldTurnEventsOptions, TranscriptBlock, UserTurnDraft } from './types.ts';

let userBlockCounter = 0;
let turnBlockCounter = 0;

function nextBlockId(prefix: string): string {
  if (prefix === 'user') {
    userBlockCounter += 1;
    return `user-${String(userBlockCounter)}`;
  }
  turnBlockCounter += 1;
  return `${prefix}-${String(turnBlockCounter)}`;
}

function resetBlockIds(): void {
  userBlockCounter = 0;
  turnBlockCounter = 0;
}

function isAppendableTextBlock(
  block: TranscriptBlock | undefined,
  kind: 'text' | 'thought',
): block is Extract<TranscriptBlock, { kind: 'text' | 'thought' }> {
  return block?.kind === kind;
}

function toolKey(event: TurnEvent, index: number): string {
  const tool = event.tool;
  if (!tool) return `tool-${String(index)}`;
  return tool.callId ?? tool.id ?? `${tool.name}-${String(index)}`;
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

function upsertToolBlock(blocks: TranscriptBlock[], event: TurnEvent, key: string): void {
  const tool = event.tool;
  if (!tool) return;
  const existing = blocks.find((block) => block.kind === 'tool' && block.id === `tool-${key}`);
  const payload = { ...tool, id: tool.id ?? tool.callId };
  if (existing && existing.kind === 'tool') {
    existing.tool = { ...existing.tool, ...payload };
    return;
  }
  blocks.push({
    id: `tool-${key}`,
    kind: 'tool',
    tool: payload,
  });
}

/** Append inline media blocks for http(s) image/video/audio URLs in completed tool output. */
function appendPromotedToolMedia(
  blocks: TranscriptBlock[],
  event: TurnEvent,
  idPrefix: string,
  seenUrls: Set<string>,
): void {
  const tool = event.tool;
  if (tool?.phase !== 'complete' || tool.output === undefined) return;
  for (const media of collectPromotedMediaFromToolOutput(tool.output)) {
    if (seenUrls.has(media.url)) continue;
    seenUrls.add(media.url);
    blocks.push({
      id: nextBlockId(idPrefix),
      kind: 'media',
      mimeType: media.mimeType,
      url: media.url,
    });
  }
}

/** Build transcript blocks for a user-authored turn. */
function buildUserTurnBlocks(draft: UserTurnDraft, idPrefix = 'user'): TranscriptBlock[] {
  // Do not reset counters — user ids must stay unique across the conversation.
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

/**
 * Fold a single assistant turn's `TurnEvent` stream into ordered transcript blocks.
 *
 * Merges consecutive `text` and `thought` deltas, upserts tool calls by id,
 * promotes http(s) media URLs from completed tool output into `media` blocks, and
 * skips kernel bookkeeping events (`tokens`, `session`) unless folded into `turn-done`.
 *
 * Resets only the turn id sequence so streaming refolds keep stable `turn-*` keys;
 * user ids are left alone.
 */
function foldTurnEvents(
  events: readonly TurnEvent[],
  options: FoldTurnEventsOptions = {},
): TranscriptBlock[] {
  const idPrefix = options.idPrefix ?? 'turn';
  const showThoughts = options.showThoughts ?? true;
  turnBlockCounter = 0;

  const blocks: TranscriptBlock[] = [];
  let toolIndex = 0;
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
      case 'tool': {
        const key = toolKey(event, toolIndex);
        toolIndex += 1;
        upsertToolBlock(blocks, event, key);
        appendPromotedToolMedia(blocks, event, idPrefix, promotedMediaUrls);
        break;
      }
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
        if (event.grounding) {
          blocks.push({
            id: nextBlockId(idPrefix),
            kind: 'grounding',
            grounding: event.grounding,
          });
        }
        break;
      case 'evidence':
        if (event.evidence) {
          blocks.push({
            id: nextBlockId(idPrefix),
            kind: 'evidence',
            evidence: event.evidence,
          });
        }
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

/** User draft blocks followed by folded assistant turn events. */
function foldConversationTurn(
  draft: UserTurnDraft,
  assistantEvents: readonly TurnEvent[],
  options: FoldTurnEventsOptions = {},
): TranscriptBlock[] {
  return [...buildUserTurnBlocks(draft, 'user'), ...foldTurnEvents(assistantEvents, options)];
}

export { buildUserTurnBlocks, foldConversationTurn, foldTurnEvents, resetBlockIds };
