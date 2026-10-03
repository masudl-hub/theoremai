import type {
	HttpMethod,
	ToolAccess,
	ToolLoadTier,
	ToolPermission,
} from '../src/kernel/schema.ts';
import type { ToolAuthConfig, ToolLabels } from '../src/kernel/tools/types.ts';
import type { StructuredSpec } from '../src/kernel/types.ts';

/** The kernel's auth config; the host's OAuth endpoints are never set from the playground. */
export type PlaygroundToolAuth = Omit<ToolAuthConfig, 'preResolved'>;

export type PlaygroundToolLabels = Pick<ToolLabels, 'activity' | 'activityPast'>;

export type StructuredRegistration = {
	id: string;
	spec: StructuredSpec;
};

export type FunctionToolRegistration = {
	type: 'function';
	name: string;
	description: string;
	category: string;
	access: ToolAccess;
	permission: ToolPermission;
	loadTier: ToolLoadTier;
	paths: string[];
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	labels?: PlaygroundToolLabels;
	/** Overrides the generic stub. */
	stubResponse?: Record<string, unknown>;
};

export type HttpToolRegistration = {
	type: 'http';
	name: string;
	description: string;
	category: string;
	access: ToolAccess;
	permission: ToolPermission;
	loadTier: ToolLoadTier;
	paths: string[];
	endpoint: string;
	method: HttpMethod;
	headers?: Record<string, string>;
	mapping?: {
		pathParams?: string[];
		queryParams?: string[];
		bodyParam?: string;
	};
	auth?: PlaygroundToolAuth;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	labels?: PlaygroundToolLabels;
};

export type McpToolRegistration = {
	type: 'mcp';
	name: string;
	description: string;
	category: string;
	access: ToolAccess;
	permission: ToolPermission;
	loadTier: ToolLoadTier;
	paths: string[];
	serverUrl: string;
	mcpToolName: string;
	headers?: Record<string, string>;
	auth?: PlaygroundToolAuth;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	labels?: PlaygroundToolLabels;
};

/** Runs one turn of another registered agent; its schemas are the kernel's fixed ones. */
export type AgentToolRegistration = {
	type: 'agent';
	name: string;
	description: string;
	category: string;
	access: ToolAccess;
	permission: ToolPermission;
	loadTier: ToolLoadTier;
	paths: string[];
	/** The agent's profile id, registered before this tool. */
	profile: string;
	maxCallsPerTurn?: number;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	labels?: PlaygroundToolLabels;
};

export type ToolRegistration =
	| FunctionToolRegistration
	| HttpToolRegistration
	| McpToolRegistration
	| AgentToolRegistration;
