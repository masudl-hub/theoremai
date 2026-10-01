import { createToolRegistry, type ToolRegistry } from '../tools/registry.ts';
import { createProfileRegistry, type ProfileRegistry } from './profiles.ts';
import { createSchemaRegistry, type SchemaRegistry } from './schemas.ts';

/** Every run takes one explicitly; nothing reads a registry it was not handed. */
interface KernelRegistry {
  readonly tools: ToolRegistry;
  readonly profiles: ProfileRegistry;
  readonly schemas: SchemaRegistry;
}

function createKernelRegistry(): KernelRegistry {
  const tools = createToolRegistry();
  return { tools, profiles: createProfileRegistry(tools), schemas: createSchemaRegistry() };
}

export type { KernelRegistry };
export { createKernelRegistry };
