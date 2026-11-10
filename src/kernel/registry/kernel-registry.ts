import { createProviderRegistry, type ProviderRegistry } from '../protocols/provider.ts';
import { createToolRegistry, type ToolRegistry } from '../tools/registry.ts';
import { createProfileRegistry, type ProfileRegistry, structuredReplySchemas } from './profiles.ts';
import { createSchemaRegistry, type SchemaRegistry } from './schemas.ts';

/** Every run takes one explicitly; nothing reads a registry it was not handed. */
interface KernelRegistry {
  readonly providers: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly profiles: ProfileRegistry;
  readonly schemas: SchemaRegistry;
}

/** Creates an empty registry of tools, profiles, and schemas, wired so a tool that names a profile can find it. */
function createKernelRegistry(): KernelRegistry {
  // why: An agent tool names a profile, and a profile allows tools: each registry reads
  // the other. Tools look profiles up only when one registers, after both exist.
  const schemas = createSchemaRegistry();
  const tools = createToolRegistry(
    (id) => profiles.find(id),
    (id) => structuredReplySchemas(schemas, profiles.find(id)),
  );
  const providers = createProviderRegistry();
  const profiles = createProfileRegistry(tools, schemas, providers);
  return { tools, profiles, schemas, providers };
}

export type { KernelRegistry };
export { createKernelRegistry };
