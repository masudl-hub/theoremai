/**
 * The runs that are going on in the project's loads: turns and voice calls, while the page is
 * joined to them. A load holds its runs in memory, so it is not replaced under one.
 *
 * @module
 */

export interface Runs {
  /** Counts a run from now on. Answers how to end it: more than once is the same as once. */
  begin(): () => void;
  busy(): boolean;
  /** Calls `then` when no run is going on: now, or in the same tick as the last one ends. */
  whenIdle(then: () => void): void;
}

/** Keeps count of the runs. `idle` is called each time the last one ends. */
export function createRuns(idle: () => void): Runs {
  let open = 0;
  const waiting: (() => void)[] = [];
  const ended = () => {
    // invariant: a waiter runs in the tick the count reaches none, so no run starts between.
    while (open === 0 && waiting.length) waiting.shift()?.();
    if (open === 0) idle();
  };
  return {
    begin: () => {
      open += 1;
      let over = false;
      return () => {
        if (over) return;
        over = true;
        open -= 1;
        if (open === 0) ended();
      };
    },
    busy: () => open > 0,
    whenIdle: (then) => {
      if (open === 0) then();
      else waiting.push(then);
    },
  };
}

/** `response` as it was, with `end` called when its body is read to the end, fails or is dropped. */
export function untilRead(response: Response, end: () => void): Response {
  if (!response.body) {
    end();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
