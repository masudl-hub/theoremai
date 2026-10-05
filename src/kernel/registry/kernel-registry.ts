import { createToolRegistry, type ToolRegistry } from '../tools/registry.ts';
import { createProfileRegistry, type ProfileRegistry } from './profiles.ts';
import { createSchemaRegistry, type SchemaRegistry } from './schemas.ts';

/** Every run takes one explicitly; nothing reads a registry it was not handed. */
interface KernelRegistry {
  readonly tools: ToolRegistry;
  readonly profiles: ProfileRegistry;
  readonly schemas: SchemaRegistry;
}

/** Creates an empty registry of tools, profiles and schemas, wired so a tool that names a profile can find it. */
function createKernelRegistry(): KernelRegistry {
  // why: An agent tool names a profile, and a profile allows tools: each registry reads
  // the other. Tools look profiles up only when one registers, after both exist.
  const tools = createToolRegistry((id) => profiles.find(id));
  const schemas = createSchemaRegistry();
  const profiles = createProfileRegistry(tools, schemas);
  return { tools, profiles, schemas };
}

export type { KernelRegistry };
export { createKernelRegistry };
