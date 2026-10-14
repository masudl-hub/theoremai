/**
 * Every request carries the compiled payload and the client-held `replay` state (permissions,
 * paused call). That is safe only because the studio user owns the whole profile and its
 * tools; product hosts keep the profile on the server (`createHttpTransport` with
 * `createTheoremHandler`).
 */

import { z } from 'zod';
import {
  type DecisionProfile,
  defineProfile,
  type Profile,
  TheoremError,
  traceRecordSchema,
  TURN_EVENT_SCHEMAS,
  type TurnEvent,
} from '@theoremjs/agents';
import {
  CHAT_LINES,
  type ChatLineSink,
  type ConversationLine,
  createTraceFeed,
  decisionInterface,
  type DecisionTransport,
  fetchConversation,
  fetchRewound,
  hostInterface,
  type HostTransport,
  type HttpOptions,
  type MalformedEvent,
  postDecision,
  postJson,
  postNdjson,
  type TheoremTransport,
  type TraceFeed,
  type TurnEventSink,
  type UnsupportedEvent,
  type WireLines,
} from '@theoremjs/react/client';
import { interfaceFromProfile, type ProfileInterface } from '@theoremjs/agents/interface';
import { createToolRegistry, type Equals } from '@theoremjs/agents/kernel';
import {
  clearStudioRunPayload,
  keptStudioRunIds,
  loadStudioRunPayload,
  type StudioRunPayload,
} from './run-payload.ts';
import { uncompiled } from './compile.ts';
import { registerStudioTools } from './tools.ts';
import type { StudioTraceLine } from './traces.ts';

/**
 * The agents the payload's agent names come first, so its agent tools find them. The patterns
 * are left out, as `compileStudio` checks them: only the run's server compiles them.
 */
function defineStudioRun(payload: StudioRunPayload) {
  const profiles = new Map<string, Profile>();
  const tools = createToolRegistry((id) => profiles.get(id));
  for (const dependency of payload.dependencies ?? []) {
    registerStudioTools(tools, dependency.customTools);
    const profile = defineProfile(uncompiled(dependency.profile));
    profiles.set(profile.id, profile);
  }
  registerStudioTools(tools, payload.customTools);
  return { profile: defineProfile(uncompiled(payload.profile)), tools };
}

export function studioInterface(payload: StudioRunPayload): ProfileInterface {
  const { profile, tools } = defineStudioRun(payload);
  return interfaceFromProfile(profile, tools);
}

/** False for a run kept by a package whose settings this one no longer takes. */
export function studioRunDefines(payload: StudioRunPayload): boolean {
  try {
    defineStudioRun(payload);
    return true;
  } catch (err) {
    if (err instanceof TheoremError) return false;
    throw err;
  }
}

/** Clears every kept run this package no longer defines. */
export function clearStaleStudioRuns(store?: Storage | null): void {
  for (const id of keptStudioRunIds(store)) {
    const payload = loadStudioRunPayload(id, store);
    if (!payload || !studioRunDefines(payload)) clearStudioRunPayload(id, store);
  }
}

/** The server picks the id, so a steer reaches only a run this browser started. */
export type StudioSteerLine = { type: 'steer_inbox'; inbox: string };

type StudioLine = TurnEvent | ConversationLine | StudioTraceLine | StudioSteerLine;

/** A trace record's line on a run's stream, as the page reads it. */
export const studioTraceLine = z.object({ type: z.literal('trace'), record: traceRecordSchema });
true satisfies Equals<z.infer<typeof studioTraceLine>, StudioTraceLine>;
const studioSteerLine = z.object({ type: z.literal('steer_inbox'), inbox: z.string().min(1) });
true satisfies Equals<z.infer<typeof studioSteerLine>, StudioSteerLine>;

const studioLines: WireLines<StudioLine> = {
  ...CHAT_LINES,
  trace: studioTraceLine,
  steer_inbox: studioSteerLine,
};

/** A host draft's call keeps no conversation and takes no steers: its stream is turn events and traces. */
const hostLines: WireLines<TurnEvent | StudioTraceLine> = {
  ...TURN_EVENT_SCHEMAS,
  trace: studioTraceLine,
};

/** A chat's lines go to the sink; a host draft's call streams turn events alone. */
export function routeStudioLines(
  onLine: ChatLineSink,
  traces: TraceFeed,
  onSteerInbox: (inbox: string) => void,
) {
  return (line: StudioLine | UnsupportedEvent | MalformedEvent) => {
    if (line.type === 'trace') traces.push(line.record);
    else if (line.type === 'steer_inbox') onSteerInbox(line.inbox);
    else onLine(line);
  };
}

function ignoreSteerInbox(): void {}

/**
 * A host draft's call as the chat router reads it. Its wire leaves conversation
 * lines out, so one reaching the call is a fault in the studio, not a line to drop.
 */
export function hostCallLines(onEvent: TurnEventSink): ChatLineSink {
  return (line) => {
    if (line.type === 'conversation') {
      // labels-exempt: internal diagnostic; the user reads error.internal
      throw new TheoremError('internal', 'a host call streamed a conversation line');
    }
    onEvent(line);
  };
}

/**
 * How a studio transport reaches the server. `traces` is the feed its trace records land in:
 * pass one feed to every transport of a conversation so a recompiled draft keeps the earlier
 * turns' traces beside the transcript that kept them.
 */
export type StudioTransportOptions = HttpOptions & { traces?: TraceFeed };

export function createStudioTransport(
  payload: StudioRunPayload,
  options: StudioTransportOptions = {},
): TheoremTransport {
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    structured: payload.structured,
    dependencies: payload.dependencies,
  };
  const traces = options.traces ?? createTraceFeed();
  /** The server's steer inbox for each turn, by the client's turn id. */
  const inboxes = new Map<string, string>();
  return {
    pageResult: (body, signal) => postJson('/api/studio/page-result', body, { ...options, signal }),
    describe: () => Promise.resolve(studioInterface(payload)),
    turn: async (request, onEvent, signal) => {
      try {
        await postNdjson(
          '/api/studio/turn',
          { ...compiled, ...request },
          studioLines,
          routeStudioLines(onEvent, traces, (inbox) => {
            if (request.turnId) inboxes.set(request.turnId, inbox);
          }),
          { ...options, signal },
        );
      } finally {
        if (request.turnId) inboxes.delete(request.turnId);
      }
    },
    invoke: (request, onEvent, signal) =>
      postNdjson(
        '/api/studio/invoke',
        // `replay` carries the paused call.
        { ...compiled, ...request },
        studioLines,
        routeStudioLines(onEvent, traces, ignoreSteerInbox),
        { ...options, signal },
      ),
    conversation: (request, signal) =>
      fetchConversation('/api/studio/conversation', { ...compiled, ...request }, { ...options, signal }),
    rewind: (request, signal) =>
      fetchRewound('/api/studio/rewind', { ...compiled, ...request }, { ...options, signal }),
    async steer({ turnId, id, inject }) {
      const inbox = inboxes.get(turnId);
      if (!inbox) {
        // labels-exempt: internal diagnostic; the user reads session.turn_ended
        throw new TheoremError('request', 'steer: the turn has not opened its inbox', {
          copy: { key: 'session.turn_ended' },
        });
      }
      // The server's inbox is the turn it steers, so the body is a `TheoremSteerRequest`.
      await postJson('/api/studio/turn/steer', { turnId: inbox, id, inject }, options);
    },
    traces,
  };
}

/**
 * A decision draft's transport: the page describes the profile itself, and every decision posts
 * the draft's profile and questions beside the state, since the studio user authors both.
 */
export function createStudioDecisionTransport(
  payload: StudioRunPayload,
  options: StudioTransportOptions = {},
): DecisionTransport {
  const questions = payload.questions ?? {};
  const traces = options.traces ?? createTraceFeed();
  return {
    describe: () =>
      Promise.resolve(decisionInterface(defineProfile(payload.profile) as DecisionProfile, questions)),
    decide: (state, signal) =>
      postDecision(
        '/api/studio/decide',
        { profile: payload.profile, questions, state },
        signal,
        options,
      ),
    traces,
  };
}

/**
 * A host draft's transport: the page describes the tools from the draft's own schemas, and every
 * call posts the draft's profile and tools beside it. The server retains operation authority;
 * permission answers remain explicit request data.
 */
export function createStudioHostTransport(
  payload: StudioRunPayload,
  options: StudioTransportOptions = {},
): HostTransport {
  const compiled = {
    profile: payload.profile,
    customTools: payload.customTools,
    dependencies: payload.dependencies,
  };
  const traces = options.traces ?? createTraceFeed();
  let sessionPermissions: string[] = [];
  return {
    pageResult: (body, signal) => postJson('/api/studio/page-result', body, { ...options, signal }),
    describe: () =>
      Promise.resolve(
        hostInterface(
          defineProfile(payload.profile) as Extract<Profile, { type: 'host' }>,
          (name) => payload.customTools.find((tool) => tool.name === name),
        ),
      ),
    call: (request, onEvent, signal) =>
      postNdjson(
        '/api/studio/call',
        { ...compiled, ...request, sessionPermissions },
        hostLines,
        routeStudioLines(hostCallLines(onEvent), traces, ignoreSteerInbox),
        { ...options, signal },
      ),
    invoke: (request, onEvent, signal) => {
      sessionPermissions = request.replay?.sessionPermissions ?? sessionPermissions;
      return postNdjson(
        '/api/studio/invoke',
        // `replay` carries the paused call.
        { ...compiled, ...request },
        hostLines,
        routeStudioLines(hostCallLines(onEvent), traces, ignoreSteerInbox),
        { ...options, signal },
      );
    },
    traces,
  };
}
