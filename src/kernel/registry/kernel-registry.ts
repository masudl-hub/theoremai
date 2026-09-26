/**
 * The registries one kernel scope reads: its tools, profiles, and structured
 * output schemas. Every run takes one explicitly; nothing reads a registry it
 * was not handed.
 *
 * @module
 */

import { createToolRegistry, type ToolRegistry } from '../tools/registry.ts';
import { createProfileRegistry, type ProfileRegistry } from './profiles.ts';
import { createSchemaRegistry, type SchemaRegistry } from './schemas.ts';

/** One scope's tools, profiles, and structured output schemas. */
interface KernelRegistry {
  readonly tools: ToolRegistry;
  readonly profiles: ProfileRegistry;
  readonly schemas: SchemaRegistry;
}

/** Empty registries, isolated from every other scope's. */
function createKernelRegistry(): KernelRegistry {
  const tools = createToolRegistry();
  return { tools, profiles: createProfileRegistry(tools), schemas: createSchemaRegistry() };
}

export type { KernelRegistry };
export { createKernelRegistry };
