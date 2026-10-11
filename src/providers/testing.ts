import {
  type CredentialContext,
  createKernelScope,
  type ErrorCopies,
  type ErrorKind,
  errorKind,
  type KernelScope,
  type LiveSession,
  type ProfileDefinition,
  type ProviderDefinition,
  type ProviderHostOptions,
  TheoremError,
  type TurnEvent,
} from '../../mod.ts';

export type ProviderConformanceCheck =
  | 'operation'
  | 'cancellation'
  | 'budgets'
  | 'credential_isolation'
  | 'terminal';

export interface ProviderFixtureControl {
  signal: AbortSignal;
  abort(): void;
}

export interface ProviderFixtureObservation {
  events: readonly TurnEvent[];
  value?: unknown;
  errorKind?: ErrorKind;
  errorCopy?: ErrorCopies;
  credentialSlots: readonly string[];
}

export interface ProviderAdapterFixtureBase {
  name: string;
  profile: ProfileDefinition;
  host?: ProviderHostOptions;
  checks?: readonly ProviderConformanceCheck[];
  abortBeforeStart?: boolean;
  cancel?(control: ProviderFixtureControl): void | Promise<void>;
  expectError?: ErrorKind;
  setup?(scope: KernelScope): void | Promise<void>;
  inspect?(observation: ProviderFixtureObservation): void | Promise<void>;
}

export type ProviderAdapterFixture = ProviderAdapterFixtureBase &
  (
    | {
        operation: 'complete';
        request: Omit<Parameters<KernelScope['runTurn']>[0], 'profile' | 'signal'>;
      }
    | {
        operation: 'decide';
        request: Omit<Parameters<KernelScope['runDecision']>[0], 'profile' | 'signal'>;
      }
    | {
        operation: 'openSession';
        request: Omit<Parameters<KernelScope['runSession']>[0], 'profile' | 'signal'>;
        exercise(session: LiveSession): void | Promise<void>;
      }
  );

export interface ProviderFixtureResult {
  name: string;
  operation: ProviderAdapterFixture['operation'];
  status: 'pass' | 'fail';
  category?: 'configuration' | 'execution' | 'expectation' | 'inspection';
  errorKind?: ErrorKind;
}

export interface ProviderConformanceReport {
  providerId: string;
  fixtures: ProviderFixtureResult[];
  operations: {
    operation: ProviderAdapterFixture['operation'];
    support: 'supported' | 'unsupported' | 'unknown';
    status: 'pass' | 'fail' | 'unverified';
  }[];
  checks: { check: ProviderConformanceCheck; status: 'pass' | 'fail' | 'unverified' }[];
}

function fixtureHost(fixture: ProviderAdapterFixture, signal: AbortSignal) {
  const slots: string[] = [];
  const vault = Object.fromEntries(
    Object.entries(fixture.host?.vault ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([slot, value]) => [
        slot,
        async (context: CredentialContext) => {
          slots.push(slot);
          if (value === undefined) throw new Error('Undefined fixture credential');
          return typeof value === 'function' ? await value(context) : value;
        },
      ]),
  );
  return {
    slots,
    host: {
      ...fixture.host,
      vault,
      signal,
      fetch: fixture.host?.fetch ?? (() => Promise.reject(new Error('Fixture fetch is required'))),
      openWebSocket:
        fixture.host?.openWebSocket ??
        (() => Promise.reject(new Error('Fixture socket is required'))),
    },
  };
}

async function runFixture(
  scope: KernelScope,
  fixture: ProviderAdapterFixture,
  host: ProviderHostOptions,
  signal: AbortSignal,
): Promise<Omit<ProviderFixtureObservation, 'credentialSlots'>> {
  const events: TurnEvent[] = [];
  try {
    if (fixture.operation === 'complete') {
      for await (const event of scope.runTurn(
        { ...fixture.request, profile: fixture.profile.id, signal },
        host,
      ))
        events.push(event);
      const failure = events.find((event) => event.type === 'error');
      const terminal = events.findLast((event) => event.type === 'done');
      if (terminal?.type === 'done' && terminal.stop.kind === 'cancelled')
        return { events, errorKind: 'cancelled' };
      if (terminal?.type === 'done' && terminal.stop.kind === 'stream_incomplete')
        return { events, errorKind: 'bad_response' };
      if (failure?.type === 'error')
        return { events, errorKind: failure.errorKind, errorCopy: failure.errorCopy };
      return { events };
    }
    if (fixture.operation === 'decide') {
      return {
        events,
        value: await scope.runDecision(
          { ...fixture.request, profile: fixture.profile.id, signal },
          host,
        ),
      };
    }
    const session = await scope.runSession(
      { ...fixture.request, profile: fixture.profile.id, signal },
      host,
    );
    const drain = (async () => {
      for await (const event of session.events()) events.push(event);
    })();
    try {
      await fixture.exercise(session);
    } finally {
      await session.close();
      await drain;
    }
    return { events };
  } catch (error) {
    return {
      events,
      errorKind: errorKind(error),
      ...(error instanceof TheoremError && error.copy ? { errorCopy: error.copy } : {}),
    };
  }
}

function validateFixture(providerId: string, fixture: ProviderAdapterFixture): void {
  if (
    fixture.profile.type === 'host' ||
    Object.values(fixture.profile.models).some((model) => model.provider !== providerId)
  )
    throw new Error();
  if (
    fixture.checks?.includes('cancellation') &&
    (fixture.abortBeforeStart ||
      !fixture.cancel ||
      !fixture.inspect ||
      fixture.expectError !== 'cancelled')
  )
    throw new Error();
  if (
    fixture.checks?.includes('budgets') &&
    (!fixture.host?.limits || !fixture.expectError || !fixture.inspect)
  )
    throw new Error();
  if (fixture.checks?.includes('credential_isolation') && !fixture.inspect) throw new Error();
  if (fixture.checks?.includes('terminal') && fixture.operation !== 'complete') throw new Error();
}

async function verifyFixture<C, O, K, S>(
  provider: ProviderDefinition<C, O, K, S>,
  fixture: ProviderAdapterFixture,
  timeoutMs: number,
): Promise<ProviderFixtureResult> {
  const result: ProviderFixtureResult = {
    name: fixture.name,
    operation: fixture.operation,
    status: 'fail',
  };
  const controller = new AbortController();
  let expire = () => {};
  const expired = new Promise<ProviderFixtureResult>((resolve) => {
    expire = () => {
      controller.abort(new DOMException('Fixture deadline', 'TimeoutError'));
      resolve({ ...result, category: 'execution', errorKind: 'timeout' });
    };
  });
  const timer = setTimeout(expire, timeoutMs);
  const work = async (): Promise<ProviderFixtureResult> => {
    let category: NonNullable<ProviderFixtureResult['category']> = 'configuration';
    try {
      const scope = createKernelScope();
      await fixture.setup?.(scope);
      scope.providers.register(provider);
      validateFixture(provider.id, fixture);
      scope.profiles.register(fixture.profile);
      const { host, slots } = fixtureHost(fixture, controller.signal);
      if (fixture.abortBeforeStart) controller.abort();
      category = 'execution';
      let cancelled = false;
      const control: ProviderFixtureControl = {
        signal: controller.signal,
        abort() {
          cancelled = true;
          controller.abort();
        },
      };
      let observation: ProviderFixtureObservation | undefined;
      let receivedError: ErrorKind | undefined;
      try {
        observation = {
          ...(fixture.cancel
            ? (
                await Promise.all([
                  runFixture(scope, fixture, host, controller.signal),
                  fixture.cancel(control),
                ])
              )[0]
            : await runFixture(scope, fixture, host, controller.signal)),
          credentialSlots: slots,
        };
        receivedError = observation.errorKind;
      } catch (error) {
        receivedError = errorKind(error);
      }
      category = 'expectation';
      if (fixture.checks?.includes('cancellation') && !cancelled) throw new Error();
      if (receivedError !== fixture.expectError)
        return { ...result, category, errorKind: receivedError };
      category = 'inspection';
      if (fixture.checks?.includes('credential_isolation') && slots.length === 0) throw new Error();
      await fixture.inspect?.(
        observation ?? { events: [], credentialSlots: slots, errorKind: receivedError },
      );
      return { ...result, status: 'pass' };
    } catch {
      return { ...result, category };
    }
  };
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function coverageStatus(
  results: readonly ProviderFixtureResult[],
  exercised: boolean,
): 'pass' | 'fail' | 'unverified' {
  if (results.some((result) => result.status === 'fail')) return 'fail';
  return results.length > 0 && exercised ? 'pass' : 'unverified';
}

function fixtureTargetsModel(fixture: ProviderAdapterFixture, apiId: string): boolean {
  return (
    fixture.profile.type !== 'host' &&
    Object.values(fixture.profile.models).some((binding) => binding.apiId === apiId)
  );
}

function fixtureCoverage(
  results: readonly ProviderFixtureResult[],
  fixtures: readonly ProviderAdapterFixture[],
  matches: (fixture: ProviderAdapterFixture) => boolean,
  requireSuccess = true,
): 'pass' | 'fail' | 'unverified' {
  const matching = results.filter((_, index) => matches(fixtures[index]));
  const exercised =
    !requireSuccess ||
    fixtures.some((fixture) => matches(fixture) && fixture.expectError === undefined);
  return coverageStatus(matching, exercised);
}

/** Runs host-supplied offline fixtures through public kernel boundaries. Missing evidence remains unverified. */
export async function verifyProviderAdapter<C, O, K, S>(options: {
  provider: ProviderDefinition<C, O, K, S>;
  fixtures: readonly ProviderAdapterFixture[];
  timeoutMs?: number;
  model?: { apiId: string; providerOptions?: unknown };
}): Promise<ProviderConformanceReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new RangeError('Invalid fixture deadline');
  if (new Set(options.fixtures.map((fixture) => fixture.name)).size !== options.fixtures.length)
    throw new Error('Duplicate fixture name');
  const fixtures: ProviderFixtureResult[] = [];
  for (const fixture of options.fixtures)
    fixtures.push(await verifyFixture(options.provider, fixture, timeoutMs));
  const names: ProviderConformanceCheck[] = [
    'operation',
    'cancellation',
    'budgets',
    'credential_isolation',
    'terminal',
  ];
  const checks = names.map((check) => ({
    check,
    status: fixtureCoverage(
      fixtures,
      options.fixtures,
      (fixture) => check === 'operation' || fixture.checks?.includes(check) === true,
      check === 'operation',
    ),
  }));
  const declarations = options.model
    ? options.provider.adapter.capabilities({
        apiId: options.model.apiId,
        connection: options.provider.adapter.connectionSchema.parse(options.provider.connection),
        providerOptions: options.provider.adapter.optionsSchema.parse(
          options.model.providerOptions ?? {},
        ),
      })
    : undefined;
  const operationNames: ProviderAdapterFixture['operation'][] = [
    'complete',
    'decide',
    'openSession',
  ];
  const operations = operationNames.map((operation) => {
    const supported =
      declarations &&
      (operation === 'complete'
        ? declarations.profileTypes.some(
            (type) => type === 'text' || type === 'image' || type === 'speech',
          )
        : declarations.profileTypes.includes(operation === 'decide' ? 'decision' : 'live'));
    return {
      operation,
      support:
        supported === undefined
          ? ('unknown' as const)
          : supported
            ? ('supported' as const)
            : ('unsupported' as const),
      status: fixtureCoverage(
        fixtures,
        options.fixtures,
        (fixture) =>
          fixture.operation === operation &&
          (!options.model || fixtureTargetsModel(fixture, options.model.apiId)),
      ),
    };
  });
  return { providerId: options.provider.id, fixtures, operations, checks };
}
