type ErrorConstructor = new (message?: string) => Error;

function assertEquals(left: unknown, right: unknown): void {
  const same = JSON.stringify(left) === JSON.stringify(right);
  if (!same) {
    throw new Error(`assertEquals failed: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`assertStringIncludes failed: "${actual}" does not include "${expected}"`);
  }
}

function assertThrows(fn: () => unknown, ctor: ErrorConstructor, messageIncludes?: string): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ctor) {
      if (messageIncludes && !String((err as Error).message).includes(messageIncludes)) {
        throw new Error(
          `assertThrows failed: expected message to include "${messageIncludes}", got "${(err as Error).message}"`,
        );
      }
      return;
    }
    throw err;
  }
  throw new Error(`assertThrows failed: expected ${ctor.name}`);
}

async function assertRejects(
  fn: () => Promise<unknown>,
  ctor: ErrorConstructor,
  messageIncludes?: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ctor)) {
      throw err;
    }
    if (messageIncludes && !String(err.message).includes(messageIncludes)) {
      throw new Error(
        `assertRejects failed: message "${err.message}" does not include "${messageIncludes}"`,
      );
    }
    return;
  }
  throw new Error(`assertRejects failed: expected ${ctor.name}`);
}

export type { ErrorConstructor };
export { assertEquals, assertRejects, assertStringIncludes, assertThrows };
