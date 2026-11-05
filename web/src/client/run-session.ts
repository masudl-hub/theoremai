import { attachmentsRefused, TheoremError, type TurnEvent } from '@theoremjs/agents';
import {
  type AttachmentValidationIssue,
  type ComposerProfileInterface,
  gatedToolsFromEvents,
  type InterfaceTurnSession,
  settlesToolCall,
  type TranscriptBlock,
  type UserTurnDraft,
} from '@theoremjs/agents/interface';
import { attachPreviewData, encodeFiles } from './encode-files.ts';
import { type TurnFailure, turnFailure } from './failure.ts';
import { type StreamView, streamFoldedTurn } from './run-commit.ts';
import { continueGatedToolInvocation, type ToolGateResolution } from './tool-resume.ts';
import {
  type ConversationLine,
  type EncodedBlob,
  isUnknownConversation,
  type TheoremTransport,
  type TheoremTurnRequest,
} from './transport.ts';
import {
  buildInvokeRequest,
  buildTurnRequest,
  foldAssistantTurn,
  issuedOperationId,
  prepareComposerTurn,
  projectUserTurn,
  type RunScope,
} from './turn-client.ts';

export type { TurnFailure } from './failure.ts';
export type { StreamView } from './run-commit.ts';

/**
 * Whether the host keeps this chat's conversation. A stateless profile keeps
 * none: the page holds its transcript, and nothing goes on from a ref.
 */
export function keepsConversation(iface: ComposerProfileInterface): boolean {
  return iface.providerContinuation?.history !== 'stateless';
}

/**
 * A session state the user can't act from (no gate waiting, a gate without a
 * call id): the labels' line for it, as a turn failure.
 */
function sessionFailure(
  key: 'session.gate_pending' | 'session.gate_expired',
  iface: ComposerProfileInterface,
): TurnFailure {
  return turnFailure(
    new TheoremError('request', `session state: ${key}`, { copy: { key } }),
    iface.labels,
  );
}

/**
 * What one run left. A host that keeps the conversation is the truth for the
 * rest: the page draws it again from the last ref the stream carried. A
 * stateless chat keeps the reply as the run streamed it.
 */
export type RunOutcome = {
  /** The session the run went out from, with any permission the answer granted. */
  session: InterfaceTurnSession;
  /** The reply's events: a gate's answer starts from the paused reply's. */
  events: TurnEvent[];
  /** The message reached the conversation: the host's when it keeps one (the ref marked `posted`), else the page's. */
  posted: boolean;
  failure?: TurnFailure;
};

type PreparedUserTurn = {
  draft: UserTurnDraft;
  blocks: TranscriptBlock[];
};

export type StreamInterfaceTurnBaseArgs = {
  iface: ComposerProfileInterface;
  transport: TheoremTransport;
  session: InterfaceTurnSession;
  scope: RunScope;
  view: StreamView;
  /**
   * Fires once the message posts, with the blocks the transcript gains: a
   * walked-away reply's settled blocks, then the message's own (with media
   * preview data). Walking away, it posts once the host has it.
   */
  onUserBlocks: (blocks: TranscriptBlock[]) => void;
  signal?: AbortSignal;
  /**
   * Send while the reply waits on gates: the message walks away from every
   * waiting call in its own request, and the host settles each one cancelled
   * ahead of the reply. Without it, or in a chat the host keeps no
   * conversation for, a waiting session refuses the send (`session.gate_pending`).
   */
  walkAway?: boolean;
  /**
   * The transcript before this message. Sent once, only when the host answers that it can no
   * longer open the conversation, so a host that restores from it (the studio) goes on.
   */
  transcript?: readonly TranscriptBlock[];
};

export type StreamInterfaceTurnArgs = StreamInterfaceTurnBaseArgs & {
  text: string;
  pendingFiles: readonly File[];
  pendingVoice: readonly File[];
};

export type StreamInterfaceDraftTurnArgs = StreamInterfaceTurnBaseArgs & {
  draft: UserTurnDraft;
};

type PreparedTurnOutcome =
  | { ok: false; issues: AttachmentValidationIssue[] }
  | {
      ok: true;
      prepared: PreparedUserTurn;
      encodedAttachments?: EncodedBlob[];
      encodedVoice?: EncodedBlob[];
    };

/** A run that never went out: nothing streamed, and the message did not post. */
function unsent(session: InterfaceTurnSession, failure: TurnFailure): RunOutcome {
  return { session, events: [], posted: false, failure };
}

async function streamPreparedTurn(
  args: StreamInterfaceTurnBaseArgs & {
    prepared: PreparedUserTurn;
    encodedAttachments?: EncodedBlob[];
    encodedVoice?: EncodedBlob[];
  },
): Promise<RunOutcome> {
  const keeps = keepsConversation(args.iface);
  const userBlocks = attachPreviewData(
    args.prepared.blocks,
    args.encodedAttachments,
    args.encodedVoice,
  );
  const paused = args.session.assistantEvents;
  const walking = args.session.gatedTool !== null;
  const request = buildTurnRequest(
    args.iface,
    args.session,
    {
      ...(args.prepared.draft.text ? { text: args.prepared.draft.text } : {}),
      ...(args.encodedAttachments?.length ? { attachments: args.encodedAttachments } : {}),
      ...(args.encodedVoice?.length ? { voice: args.encodedVoice } : {}),
    },
    {
      ...args.scope,
      ...(walking ? { walkAway: { calls: gatedToolsFromEvents(paused) } } : {}),
    },
  );
  // why: Walking away, the stream settles the paused reply first; once the message posts, the events are the new reply's.
  const events: TurnEvent[] = walking ? [...paused] : [];
  let posted = !keeps;
  if (!walking) args.onUserBlocks(userBlocks);
  const onConversation = (line: ConversationLine) => {
    if (!line.posted) return;
    posted = true;
    if (walking) {
      args.onUserBlocks([...foldAssistantTurn(args.iface, events), ...userBlocks]);
      events.length = 0;
    }
  };
  const send = (body: TheoremTurnRequest) =>
    streamFoldedTurn({
      iface: args.iface,
      view: args.view,
      events,
      onConversation,
      stream: (onLine) => args.transport.turn(body, onLine, args.signal),
    });
  try {
    try {
      await send(request);
    } catch (err) {
      if (!args.transcript || request.conversation === undefined || !isUnknownConversation(err))
        throw err;
      // why: The host lost the conversation before the message posted; it goes on from the page's copy, once. The lost reply's waiting calls went with it.
      const { abandon: _lost, ...rest } = request;
      await send({ ...rest, transcript: [...args.transcript] });
    }
  } catch (err) {
    return {
      session: args.session,
      // why: A walk that failed before the message posted leaves no reply of its own; the host's view is the truth.
      events: posted ? events : [],
      posted,
      failure: turnFailure(err, args.iface.labels, args.signal),
    };
  }
  if (!posted) {
    // why: A host that keeps the conversation posts the message or fails; a stream that ends without either is the host's fault.
    return unsent(
      args.session,
      turnFailure(
        // labels-exempt: internal diagnostic; the user reads error.internal
        new TheoremError('internal', 'the reply ended without posting the message'),
        args.iface.labels,
      ),
    );
  }
  return { session: args.session, events, posted };
}

function extractInlineEncodedAttachments(
  attachments?: readonly { name: string; mimeType: string; data?: unknown }[],
): Array<{ name: string; mimeType: string; data: string }> | undefined {
  const filtered = attachments
    ?.filter(
      (a): a is { name: string; mimeType: string; data: string } => typeof a.data === 'string',
    )
    .map((a) => ({ name: a.name, mimeType: a.mimeType, data: a.data }));
  return filtered && filtered.length > 0 ? filtered : undefined;
}

async function runPreparedTurnStream(
  args: StreamInterfaceTurnBaseArgs & {
    prepare: () => PreparedTurnOutcome | Promise<PreparedTurnOutcome>;
  },
): Promise<RunOutcome> {
  if (args.session.gatedTool !== null && (!args.walkAway || !keepsConversation(args.iface))) {
    return unsent(args.session, sessionFailure('session.gate_pending', args.iface));
  }
  try {
    const outcome = await args.prepare();
    if (!outcome.ok) {
      return unsent(args.session, {
        ...turnFailure(attachmentsRefused(outcome.issues), args.iface.labels),
        issues: outcome.issues,
      });
    }
    return await streamPreparedTurn({
      ...args,
      prepared: outcome.prepared,
      ...(outcome.encodedAttachments ? { encodedAttachments: outcome.encodedAttachments } : {}),
      ...(outcome.encodedVoice ? { encodedVoice: outcome.encodedVoice } : {}),
    });
  } catch (err) {
    return unsent(args.session, turnFailure(err, args.iface.labels, args.signal));
  }
}

export async function streamInterfaceTurn(args: StreamInterfaceTurnArgs): Promise<RunOutcome> {
  return await runPreparedTurnStream({
    ...args,
    prepare: async () => {
      const prepared = prepareComposerTurn(
        args.iface,
        args.text,
        args.pendingFiles,
        args.pendingVoice,
      );
      if (!prepared.ok) return prepared;
      return {
        ok: true,
        prepared,
        encodedAttachments: args.pendingFiles.length
          ? await encodeFiles(args.pendingFiles)
          : undefined,
        encodedVoice: args.pendingVoice.length ? await encodeFiles(args.pendingVoice) : undefined,
      };
    },
  });
}

/** Send a turn from an already-encoded pending draft (queue drain / send now). */
export async function streamInterfaceDraftTurn(
  args: StreamInterfaceDraftTurnArgs,
): Promise<RunOutcome> {
  return await runPreparedTurnStream({
    ...args,
    prepare: () => {
      const prepared = projectUserTurn(args.iface, args.draft);
      if (!prepared.ok) return prepared;
      return {
        ok: true,
        prepared,
        encodedAttachments: extractInlineEncodedAttachments(prepared.draft.attachments),
        encodedVoice: extractInlineEncodedAttachments(prepared.draft.voice),
      };
    },
  });
}

/**
 * Send the user's answer to the gate the session waits on. The host settles
 * the call either way (an approval runs it; a refusal records it declined), so
 * the model and the trace read what the user chose. A host that keeps the
 * conversation goes on with the reply in the same stream once no call waits.
 */
export async function resumeInterfaceTool(args: {
  iface: ComposerProfileInterface;
  transport: TheoremTransport;
  session: InterfaceTurnSession;
  scope: RunScope;
  resolution: ToolGateResolution;
  view: StreamView;
}): Promise<RunOutcome> {
  const gated = args.session.gatedTool;
  if (!gated?.callId)
    return unsent(args.session, sessionFailure('session.gate_expired', args.iface));
  const reply = continueGatedToolInvocation({
    toolName: gated.name,
    gate: gated,
    sessionPermissions: args.session.sessionPermissions,
    resolution: args.resolution,
  });
  const session = {
    ...args.session,
    sessionPermissions:
      reply.decision === 'approve' ? reply.sessionPermissions : args.session.sessionPermissions,
  };
  // why: Seeded with the paused reply, and filled as the answer streams, so a failed answer keeps what it delivered.
  const events = [...args.session.assistantEvents];
  try {
    await streamFoldedTurn({
      iface: args.iface,
      view: args.view,
      events,
      stream: (onLine) =>
        args.transport.invoke(
          buildInvokeRequest(
            args.iface,
            args.session,
            {
              gateId: gated.callId,
              operationId: issuedOperationId(gated),
              decision: reply.decision,
              name: gated.name,
              input: gated.arguments,
              sessionPermissions: session.sessionPermissions,
              ...(reply.decision === 'approve' && reply.secret !== undefined
                ? { secret: reply.secret }
                : {}),
              ...(reply.decision === 'approve' && reply.page ? { page: reply.page } : {}),
            },
            args.scope,
          ),
          onLine,
        ),
    });
  } catch (err) {
    // why: An answer that failed before its call settled leaves the reply waiting as it was; the answer can go again.
    const answered = events.slice(args.session.assistantEvents.length);
    const settled = answered.some((event) => settlesToolCall(event, gated.callId));
    return {
      session,
      events: settled ? events : [...args.session.assistantEvents],
      posted: true,
      failure: turnFailure(err, args.iface.labels),
    };
  }
  return { session, events, posted: true };
}
