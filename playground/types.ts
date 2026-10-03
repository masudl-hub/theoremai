import type {
  AuthUnauthenticatedPolicy,
  CustomToolType,
  HttpMethod,
  PlaygroundAuthType,
  ToolAccess,
  ToolLoadTier,
  ToolPermission,
} from '../src/kernel/schema.ts';

/** The tool types a playground draft builds; agent tools come with more than one agent per draft. */
export type PlaygroundToolType = Exclude<CustomToolType, 'agent'>;

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
