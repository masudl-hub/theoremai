import type { TurnEvent } from '@theoremjs/agents';
import { toolCallsOf, toolSnapshotFromEvents } from '@theoremjs/agents/interface';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ClientFailure, clientFailure } from '../client/failure.ts';
import type { ToolCall } from '../client/host-call.ts';
import type { HostInterface, HostTransport } from '../client/host-transport.ts';
import { continueGatedToolInvocation, type ToolGateResolution } from '../client/tool-resume.ts';
import type { ClientTurnEvent } from '../client/transport.ts';
import { useDescribed } from './use-described.ts';

export type { ToolCall };

/** One call of one of the host's tools, as it streams. */
export type TheoremHostCall = {
  /** The page's id for the call, before the host names it. */
  id: string;
  name: string;
  input: unknown;
  /** Everything the host streamed for the call, answers included. */
  events: TurnEvent[];
  /** The call as its events fold: its state is the phase it is in. */
  call: ToolCall | null;
  /** The tool's latest progress report while it runs. */
  progress: unknown;
  isRunning: boolean;
  /** The call never reached its tool, or its stream broke. */
  failure: ClientFailure | null;
  /** The answer on its way to the gate the call paused on. */
  answering: ToolGateResolution['action'] | null;
  startedAt: number;
  /** Round trip, once it settles or pauses. */
  elapsedMs: number | null;
};

export type TheoremHostState = {
  /** The host as the page sees it; null until it describes itself. */
  iface: HostInterface | null;
  describeFailure: ClientFailure | null;
  /** This page's calls, newest first. */
  calls: TheoremHostCall[];
};

function callId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function withEvent(call: TheoremHostCall, event: TurnEvent): TheoremHostCall {
  const events = [...call.events, event];
  const progress =
    event.type === 'tool' && event.tool.phase === 'progress' ? event.tool.data : call.progress;
  return { ...call, events, call: toolCallsOf(events)[0] ?? null, progress };
}

/**
 * One host profile: describe it once, then `run(name, input)` any of its tools
 * as often as needed, and answer the gates a call pauses on. `run` returns the
 * call's id at once; calls run side by side, and `cancel` stops one.
 */
export function useTheoremHost(transport: HostTransport): TheoremHostState & {
  run: (name: string, input: unknown) => string;
  answer: (id: string, resolution: ToolGateResolution) => Promise<void>;
  cancel: (id: string) => void;
} {
  const { iface, describeFailure } = useDescribed(transport);
  const [calls, setCalls] = useState<TheoremHostCall[]>([]);
  const running = useRef(new Map<string, AbortController>());
  const permissions = useRef<string[]>([]);
  const latest = useRef(calls);
  latest.current = calls;

  useEffect(() => {
    const open = running.current;
    return () => {
      for (const controller of open.values()) controller.abort();
    };
  }, []);

  const update = useCallback((id: string, change: (call: TheoremHostCall) => TheoremHostCall) => {
    setCalls((previous) => previous.map((call) => (call.id === id ? change(call) : call)));
  }, []);

  /** Streams one request's events into the call, then marks it settled or failed. */
  const stream = useCallback(
    async (
      id: string,
      send: (onEvent: (event: ClientTurnEvent) => void, signal: AbortSignal) => Promise<void>,
    ) => {
      const controller = new AbortController();
      running.current.set(id, controller);
      const started = performance.now();
      update(id, (call) => ({ ...call, isRunning: true, failure: null }));
      try {
        await send((event) => {
          if (event.type === 'unsupported' || event.type === 'malformed') return;
          update(id, (call) => withEvent(call, event));
        }, controller.signal);
        update(id, (call) => ({
          ...call,
          isRunning: false,
          answering: null,
          elapsedMs: performance.now() - started,
        }));
      } catch (err) {
        const failure = controller.signal.aborted ? null : clientFailure(err);
        update(id, (call) => ({
          ...call,
          isRunning: false,
          answering: null,
          failure,
          elapsedMs: performance.now() - started,
        }));
      } finally {
        if (running.current.get(id) === controller) running.current.delete(id);
      }
    },
    [update],
  );

  const run = useCallback(
    (name: string, input: unknown) => {
      const id = callId();
      setCalls((previous) => [
        {
          id,
          name,
          input,
          events: [],
          call: null,
          progress: undefined,
          isRunning: true,
          failure: null,
          answering: null,
          startedAt: Date.now(),
          elapsedMs: null,
        },
        ...previous,
      ]);
      void stream(id, (onEvent, signal) => transport.call({ name, input }, onEvent, signal));
      return id;
    },
    [stream, transport],
  );

  const answer = useCallback(
    async (id: string, resolution: ToolGateResolution) => {
      const held = latest.current.find((call) => call.id === id);
      const state = held?.call?.state;
      if (!held?.call || state?.phase !== 'gate') return;
      const gateId = held.call.callId;
      const reply = continueGatedToolInvocation({
        toolName: held.name,
        gate: state.gate,
        sessionPermissions: permissions.current,
        resolution,
      });
      if (reply.decision === 'approve') permissions.current = reply.sessionPermissions;
      const snapshot = toolSnapshotFromEvents(held.events);
      update(id, (call) => ({ ...call, answering: resolution.action }));
      await stream(id, (onEvent, signal) =>
        transport.invoke(
          {
            gateId,
            decision: reply.decision,
            ...(reply.decision === 'approve' && reply.secret !== undefined
              ? { secret: reply.secret }
              : {}),
            // why: A host without sessions (the playground) replays the paused call; others ignore it.
            replay: {
              name: held.name,
              input: held.input,
              sessionPermissions: permissions.current,
              ...(snapshot ? { snapshot } : {}),
            },
          },
          onEvent,
          signal,
        ),
      );
    },
    [stream, transport, update],
  );

  const cancel = useCallback((id: string) => {
    running.current.get(id)?.abort();
    running.current.delete(id);
  }, []);

  return { iface, describeFailure, calls, run, answer, cancel };
}
