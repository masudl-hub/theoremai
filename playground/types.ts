import {
  TOOL_TYPES,
  type AuthUnauthenticatedPolicy,
  type CustomToolType,
  type HttpMethod,
  type PlaygroundAuthType,
  type ToolAccess,
  type ToolLoadTier,
  type ToolPermission,
} from '../src/kernel/schema.ts';

/** The tool types a playground draft builds. */
export type PlaygroundToolType = CustomToolType;

/** Those types, in the kernel's order. `builtin` is not one a draft builds. */
export const PLAYGROUND_TOOL_TYPES = TOOL_TYPES.filter(
  (type): type is PlaygroundToolType => type !== 'builtin',
);

const toolTypeList = PLAYGROUND_TOOL_TYPES.join(', ').replace(/, ([^,]+)$/, ', or $1');

/** What a file or a draft is told when a tool's type is not one of those. */
export const PLAYGROUND_TOOL_TYPE_MESSAGE = `Tool type must be ${toolTypeList}.`;

/** Serializable tool facet seed — UI adds `kind` / `expanded` in the frontend. */
export type PlaygroundToolSpecSeed = {
  toolName: string;
  toolType: PlaygroundToolType;
  description: string;
  category: string;
  access: ToolAccess;
  permission: ToolPermission;
  loadTier: ToolLoadTier;
  paths: string[];
  inputJson: string;
  outputJson: string;
  activity?: string;
  activityPast?: string;
  request?: string;
  stubOutputJson?: string;
  /** A function tool the page answers; the playground's page answers with the stub. */
  answeredBy?: 'page';
  endpoint?: string;
  method?: HttpMethod;
  headersJson?: string;
  pathParams?: string[];
  queryParams?: string[];
  bodyParam?: string;
  serverUrl?: string;
  mcpToolName?: string;
  /** An agent tool's agent, by its workspace key. */
  agentKey?: string;
  /** An agent tool's calls in one turn of its caller; `null` or absent: no cap but max steps. */
  maxCallsPerTurn?: number | null;
  authType?: PlaygroundAuthType;
  authSlot?: string;
  authService?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
  authUnauthenticated?: AuthUnauthenticatedPolicy;
  authScopes?: string[];
  authClientId?: string;
  authRedirectUri?: string;
};

export type PlaygroundToolSeed = { id: string; data: PlaygroundToolSpecSeed };

export type PlaygroundInputsSpec = {
  text: boolean;
  attachmentsAccept: readonly string[];
  voiceAccept: readonly string[];
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
};
