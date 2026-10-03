import type {
  AuthUnauthenticatedPolicy,
  CustomToolType,
  HttpMethod,
  PlaygroundAuthType,
  ToolAccess,
  ToolLoadTier,
  ToolPermission,
} from '../src/kernel/schema.ts';

/** The tool types a playground draft builds. */
export type PlaygroundToolType = CustomToolType;

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
  stubOutputJson?: string;
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
