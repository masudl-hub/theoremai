import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { z } from 'zod';
import { registerTool, resetTools } from '../../src/kernel/default-scope.ts';
import { defaultKernelScope } from '../../src/kernel/scope.ts';
import { type LimitClock, takeLimitPlace } from '../../src/kernel/tools/http-limit.ts';
import { executeRegisteredTool } from '../../src/kernel/tools/mod.ts';
import type { Profile } from '../../src/kernel/types.ts';
import { toolEventsOf } from '../fixtures/events.ts';

/** A clock whose waits pass at once, unless `hang` holds them until their signal aborts. */
function fakeClock(): LimitClock & { waits: number[]; hang: boolean; at: (ms: number) => void } {
  let now = 0;
  const clock = {
    waits: [] as number[],
    hang: false,
    at: (ms: number) => {
      now = ms;
    },
    now: () => now,
    wait: (ms: number, signal?: AbortSignal | null) => {
      clock.waits.push(ms);
      if (!clock.hang) {
        now += ms;
        return Promise.resolve();
      }
      return new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  return clock;
}

function isPlace(taken: Awaited<ReturnType<typeof takeLimitPlace>>) {
  if ('full' in taken) throw new Error('expected a place');
  return taken;
}

Deno.test('a full window past the wait budget sends nothing and says when the next place opens', async () => {
  const tool = {};
  const clock = fakeClock();
  const limit = { requests: 2, windowMs: 60_000 };
  isPlace(await takeLimitPlace(tool, limit, null, clock)).answered(new Response());
  clock.at(1000);
  isPlace(await takeLimitPlace(tool, limit, null, clock)).answered(new Response());
  clock.at(2000);
  const full = await takeLimitPlace(tool, limit, null, clock);
  assertEquals(full, { full: true, limit, opensInMs: 58_000 });
  assertEquals(clock.waits, []);
});

Deno.test('a place that opens within the wait budget is waited for', async () => {
  const tool = {};
  const clock = fakeClock();
  const limit = { requests: 1, windowMs: 3000 };
  isPlace(await takeLimitPlace(tool, limit, null, clock)).answered(new Response());
  isPlace(await takeLimitPlace(tool, limit, null, clock));
  assertEquals(clock.waits, [3000]);
});

Deno.test('an unanswered request holds its place: the budget passes and nothing is sent', async () => {
  const tool = {};
  const clock = fakeClock();
  const limit = { requests: 1, windowMs: 1000 };
  isPlace(await takeLimitPlace(tool, limit, null, clock));
  assertEquals(await takeLimitPlace(tool, limit, null, clock), {
    full: true,
    limit,
    opensInMs: undefined,
  });
  assertEquals(clock.waits, [5000]);
});

Deno.test('an answer wakes a waiting call, which then waits out the window from that answer', async () => {
  const tool = {};
  const clock = fakeClock();
  const limit = { requests: 1, windowMs: 1000 };
  const first = isPlace(await takeLimitPlace(tool, limit, null, clock));
  clock.hang = true;
  const second = takeLimitPlace(tool, limit, null, clock);
  await Promise.resolve();
  clock.hang = false;
  clock.at(500);
  first.answered(new Response());
  isPlace(await second);
  assertEquals(clock.now(), 1500);
});

Deno.test("a 429's Retry-After holds every call of the tool until then", async () => {
  const tool = {};
  const clock = fakeClock();
  const limit = { requests: 30, windowMs: 60_000 };
  isPlace(await takeLimitPlace(tool, limit, null, clock)).answered(
    new Response(null, { status: 429, headers: { 'Retry-After': '40' } }),
  );
  assertEquals(await takeLimitPlace(tool, limit, null, clock), {
    full: true,
    limit,
    opensInMs: 40_000,
  });
});

Deno.test('tools have their own windows', async () => {
  const clock = fakeClock();
  const limit = { requests: 1, windowMs: 60_000 };
  isPlace(await takeLimitPlace({}, limit, null, clock)).answered(new Response());
  isPlace(await takeLimitPlace({}, limit, null, clock));
});

Deno.test('an abort ends the wait for a place', async () => {
  const tool = {};
  const clock = fakeClock();
  const limit = { requests: 1, windowMs: 1000 };
  isPlace(await takeLimitPlace(tool, limit, null, clock));
  clock.hang = true;
  const stop = new AbortController();
  const waiting = takeLimitPlace(tool, limit, stop.signal, clock);
  stop.abort(new Error('stopped'));
  await assertRejects(() => waiting, Error, 'stopped');
});

const limitedProfile: Profile = {
  id: 'limited-profile',
  type: 'host',
  tools: { allow: ['limited_read'] },
};

function registerLimited(limit: { requests: number; windowMs: number }, timeoutMs?: number): void {
  resetTools();
  registerTool({
    name: 'limited_read',
    description: 'A read with a limit',
    type: 'http',
    endpoint: 'https://api.example.com/read',
    method: 'GET',
    category: 'api',
    access: 'read-only',
    loadTier: 'T0',
    permission: 'auto',
    paths: ['*'],
    limit,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
  });
}

async function callLimited(callId: string) {
  const events = [];
  for await (const event of executeRegisteredTool({
    tools: defaultKernelScope.tools,
    profile: limitedProfile,
    name: 'limited_read',
    input: {},
    callId,
    ctx: {},
  })) {
    events.push(event);
  }
  return events;
}

Deno.test('a limited HTTP tool past its limit fails as rate_limit without sending', async () => {
  registerLimited({ requests: 1, windowMs: 60_000 });
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (() => {
    sent++;
    return Promise.resolve(Response.json({ ok: true }));
  }) as typeof fetch;
  try {
    assertEquals(toolEventsOf(await callLimited('call_1'), 'complete').length, 1);
    const failed = toolEventsOf(await callLimited('call_2'), 'error');
    assertEquals(failed[0]?.failure?.code, 'rate_limit_window');
    assertEquals(failed[0]?.failure?.kind, 'rate_limit');
    assertEquals(sent, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetTools();
  }
});

Deno.test("a limited HTTP tool's 429 holds its next call without sending", async () => {
  registerLimited({ requests: 30, windowMs: 60_000 });
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (() => {
    sent++;
    return Promise.resolve(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '40' } }),
    );
  }) as typeof fetch;
  try {
    const refused = toolEventsOf(await callLimited('call_1'), 'error');
    assertEquals(refused[0]?.failure?.code, 'http_429');
    const held = toolEventsOf(await callLimited('call_2'), 'error');
    assertEquals(held[0]?.failure?.code, 'rate_limit_window');
    assertEquals(sent, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetTools();
  }
});

Deno.test('registration refuses a limit that is not a whole number of requests in some time', () => {
  for (const limit of [
    { requests: 0, windowMs: 1000 },
    { requests: 1.5, windowMs: 1000 },
    { requests: 1, windowMs: 0 },
    { requests: 1, windowMs: Number.POSITIVE_INFINITY },
  ]) {
    assertThrows(() => registerLimited(limit), Error, 'limit needs a whole number');
  }
  resetTools();
});

Deno.test('a call past its timeout fails as timeout and frees its place', async () => {
  registerLimited({ requests: 1, windowMs: 1 }, 20);
  const originalFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sent++;
    if (sent > 1) return Promise.resolve(Response.json({ ok: true }));
    // The first call hangs until its signal aborts.
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const failed = toolEventsOf(await callLimited('call_1'), 'error');
    assertEquals(failed[0]?.failure?.code, 'timeout');
    assertEquals(failed[0]?.failure?.kind, 'timeout');
    assertEquals(toolEventsOf(await callLimited('call_2'), 'complete').length, 1);
    assertEquals(sent, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetTools();
  }
});

Deno.test('registration refuses a timeout that is not some time', () => {
  for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assertThrows(
      () => registerLimited({ requests: 1, windowMs: 1000 }, timeoutMs),
      Error,
      'timeoutMs needs a finite number',
    );
  }
  resetTools();
});
