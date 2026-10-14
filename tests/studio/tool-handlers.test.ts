import { assert, assertEquals } from '@std/assert';
import { createToolRegistry } from '../../src/kernel/tools/registry.ts';
import { ON_OWN_KEYS } from '../../studio/lent-keys.ts';
import {
  compileStudio,
  createExampleDraft,
  registerStudioTools,
  type StudioToolHandlers,
  type ToolRegistration,
} from '../../studio/mod.ts';

/** A function tool from the example, named `name`, with no sample reply. */
function functionTool(name: string, stubResponse?: Record<string, unknown>): ToolRegistration {
  const compiled = compileStudio(createExampleDraft(), ON_OWN_KEYS);
  assert(compiled.ok);
  const tool = compiled.customTools.find(
    (each) => each.type === 'function' && each.answeredBy !== 'page',
  );
  assert(tool?.type === 'function');
  const { stubResponse: _, ...rest } = tool;
  return { ...rest, name, ...(stubResponse ? { stubResponse } : {}) };
}

async function answer(tool: ToolRegistration, handlers?: StudioToolHandlers): Promise<unknown> {
  const tools = createToolRegistry(() => undefined);
  registerStudioTools(tools, [tool], handlers);
  const registered = tools.require(tool.name);
  assert('handler' in registered && typeof registered.handler === 'function');
  return await (registered.handler as (input: unknown) => Promise<unknown>)({ value: 32 });
}

const HANDLERS: StudioToolHandlers = { convert_units: () => ({ answeredBy: 'host' }) };

Deno.test('a function tool runs no handler the host did not give, whatever its name', async () => {
  const answered = await answer(functionTool('convert_units'));
  assertEquals((answered as Record<string, unknown>).answeredBy, undefined);
});

Deno.test("a function tool runs the host's handler for its name", async () => {
  assertEquals(await answer(functionTool('convert_units'), HANDLERS), { answeredBy: 'host' });
});

Deno.test("the builder's sample reply wins over the host's handler", async () => {
  assertEquals(await answer(functionTool('convert_units', { mine: true }), HANDLERS), {
    mine: true,
  });
});

Deno.test('a tool named after an object property finds no handler on the prototype', async () => {
  const answered = await answer(functionTool('constructor'), {});
  assert(typeof answered === 'object' && answered !== null);
});
