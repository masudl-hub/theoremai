import { runTurn } from '../fixtures/registered-runner.ts';
import '../fixtures/test-host.ts';
import { assert, assertEquals, assertInstanceOf } from '@std/assert';
import { describeError, errorKind, TheoremError } from '../../src/guardrails/error.ts';
import type { ErrorKind } from '../../src/guardrails/theorem-error.ts';
import { forClient } from '../../src/host/client-turn.ts';
import { registerProfile } from '../../src/kernel/default-scope.ts';
import { defineProfile } from '../../src/kernel/registry/profiles.ts';
import type { TurnStopKind } from '../../src/kernel/schema.ts';
import type { ModelEvent, TurnEvent, TurnModel } from '../../src/kernel/types.ts';
import type { TraceRecord } from '../../src/observability/trace-record.ts';
import { finalStop } from '../fixtures/events.ts';
import { geminiModels } from '../fixtures/models.ts';
import { FIXTURE_VAULT } from '../fixtures/registered-runner.ts';
import { catalogedSink } from '../fixtures/trace-catalog.ts';

/** What every reader of one injected failure got. */
interface Observed {
  events: TurnEvent[];
  traces: TraceRecord[];
  /** What the turn threw, when it threw instead of ending. */
  thrown?: unknown;
}

/** What the honest-errors rules say this failure must look like (docs/proposals/honest-errors.md). */
interface Expected {
  /** Text from the injected failure and each cause the builder must read (R1.1). */
  reasons: string[];
  kind?: ErrorKind;
  stop?: TurnStopKind;
  /** Text that must reach no label, no visitor copy and no trace (S1). */
  secrets?: string[];
}

const SECRET = String(FIXTURE_VAULT.slot_a);

function builderText(observed: Observed): string {
  const events = observed.events.map((event) => forClient(event, { reader: 'builder' }));
  const thrown = observed.thrown === undefined ? [] : [describeError(observed.thrown)];
  return JSON.stringify([...events, ...thrown]);
}

function visitorText(observed: Observed): string {
  return JSON.stringify(observed.events.map((event) => forClient(event)));
}

/** Every label the failure reached the user with. */
function labels(observed: Observed): string[] {
  return observed.events.flatMap((event) => {
    const visitor = forClient(event);
    if (visitor.type === 'error') return visitor.error === undefined ? [] : [visitor.error];
    if (visitor.type === 'tool' && visitor.tool.phase === 'error') {
      return visitor.tool.failure.error === undefined ? [] : [visitor.tool.failure.error];
    }
    return [];
  });
}

function kinds(observed: Observed): ErrorKind[] {
  return observed.events
    .flatMap((event) => {
      if (event.type === 'error') return [event.errorKind];
      if (event.type === 'tool' && event.tool.phase === 'error') return [event.tool.failure.kind];
      return [];
    })
    .concat(observed.thrown === undefined ? [] : [errorKind(observed.thrown)]);
}

function check(observed: Observed, expected: Expected): void {
  const builder = builderText(observed);
  const visitor = visitorText(observed);
  const trace = JSON.stringify(observed.traces);
  for (const reason of expected.reasons) {
    assert(builder.includes(reason), `R1.1: the builder reads "${reason}" in ${builder}`);
    if (observed.traces.length > 0) {
      assert(trace.includes(reason), `R1.1: the trace holds "${reason}"`);
    }
    for (const label of labels(observed)) {
      assert(!label.includes(reason), `R2.2: the label "${label}" holds no reason`);
    }
  }
  if (expected.kind) {
    assertEquals(kinds(observed).at(-1), expected.kind, 'R1.2, R1.3: the kind');
  }
  assert(!visitor.includes('errorInternal'), `R2.4: the visitor reads no errorInternal`);
  if (expected.stop) {
    assertEquals(finalStop(observed.events)?.kind, expected.stop, 'R3.1, R3.2: the stop');
  }
  for (const secret of expected.secrets ?? []) {
    assert(!visitor.includes(secret), 'S1: no secret in the visitor copy');
    assert(!builder.includes(secret), 'S1: no secret in the builder copy');
    assert(!trace.includes(secret), 'S1: no secret in the trace');
  }
}

async function turn(profile: string, model: TurnModel): Promise<Observed> {
  const events: TurnEvent[] = [];
  const traces: TraceRecord[] = [];
  try {
    for await (const event of runTurn(
      { profile, input: { text: 'x' } },
      model,
      catalogedSink(traces),
    )) {
      events.push(event);
    }
  } catch (thrown) {
    return { events, traces, thrown };
  }
  return { events, traces };
}

function textProfile(id: string, extra: Record<string, unknown> = {}): string {
  registerProfile(
    defineProfile({
      type: 'text',
      identity: { handle: 't', system: 't' },
      id,
      ...geminiModels('gemini35FlashLite'),
      tools: { allow: [] },
      inputs: { text: true },
      ...extra,
    } as Parameters<typeof defineProfile>[0]),
  );
  return id;
}

function throws(error: unknown): TurnModel {
  return {
    complete: () =>
      (async function* (): AsyncGenerator<ModelEvent> {
        await Promise.resolve();
        yield* [];
        throw error;
      })(),
  };
}

Deno.test('a provider failure keeps its cause for the builder, with no key', async () => {
  const profile = textProfile('matrix.provider.cause');
  const cause = new Error(`socket reset by upstream ${SECRET}`);
  const observed = await turn(
    profile,
    throws(new TheoremError('unavailable', 'stream broke', { cause })),
  );
  check(observed, {
    reasons: ['stream broke', 'socket reset by upstream'],
    kind: 'unavailable',
    secrets: [SECRET],
  });
});

Deno.test('a profile build that fails on a host bug reads as internal and keeps its cause', () => {
  const spec = {
    get sampleRate(): number {
      throw new TypeError('getter bug');
    },
  };
  let thrown: unknown;
  try {
    textProfile('matrix.profile.build', { observability: spec });
  } catch (error) {
    thrown = error;
  }
  assertInstanceOf(thrown, TheoremError);
  assertEquals(thrown.kind, 'internal');
  assertInstanceOf(thrown.cause, TypeError);
});
