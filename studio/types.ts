import {
  type AuthUnauthenticatedPolicy,
  type CustomToolType,
  type HttpMethod,
  type StudioAuthType,
  TOOL_TYPES,
  type ToolAccess,
  type ToolLoadTier,
  type ToolPermission,
} from '@theoremjs/agents/schema';

/** The tool types a studio draft builds. */
export type StudioToolType = CustomToolType;

/** Those types, in the kernel's order. `builtin` is not one a draft builds. */
export const STUDIO_TOOL_TYPES = TOOL_TYPES.filter(
  (type): type is StudioToolType => type !== 'builtin',
);

const toolTypeList = STUDIO_TOOL_TYPES.join(', ').replace(/, ([^,]+)$/, ', or $1');

/** What a file or a draft is told when a tool's type is not one of those. */
export const STUDIO_TOOL_TYPE_MESSAGE = `Tool type must be ${toolTypeList}.`;

/** Serializable tool facet seed — UI adds `kind` / `expanded` in the frontend. */
export type StudioToolSpecSeed = {
  toolName: string;
  toolType: StudioToolType;
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
  activityFailed?: string;
  request?: string;
  stubOutputJson?: string;
  /** A function tool the page answers; the studio's page answers with the stub. */
  answeredBy?: 'page';
  endpoint?: string;
  method?: HttpMethod;
  headersJson?: string;
  pathParams?: string[];
  queryParams?: string[];
  bodyParam?: string;
  serverUrl?: string;
  mcpToolName?: string;
  /** An HTTP or MCP tool's most response bytes read; `null` or absent: no limit. */
  maxResponseBytes?: number | null;
  /** An MCP tool's session idle time, in ms; `null` or absent: no limit. */
  sessionIdleMs?: number | null;
  /** An MCP tool's most sessions; `null` or absent: no limit. */
  sessionMax?: number | null;
  /** An agent tool's agent, by its workspace key. */
  agentKey?: string;
  /** A decision or text agent that filters this tool's output at `post_tool`, by its workspace key. */
  stageAgentKey?: string;
  /** An agent tool's calls in one turn of its caller; `null` or absent: no cap but max steps. */
  maxCallsPerTurn?: number | null;
  authType?: StudioAuthType;
  authSlot?: string;
  authService?: string;
  authHeaderName?: string;
  authHeaderPrefix?: string;
  /** An API key's query parameter: set, the key goes in the URL and in no header. */
  authQueryParam?: string;
  authUnauthenticated?: AuthUnauthenticatedPolicy;
  authScopes?: string[];
  authClientId?: string;
  authRedirectUri?: string;
};

export type StudioToolSeed = { id: string; data: StudioToolSpecSeed };

export type StudioInputsSpec = {
  text: boolean;
  attachmentsAccept: readonly string[];
  voiceAccept: readonly string[];
  maxFiles: number;
  maxBytes: number;
  maxTurnBytes: number;
};
