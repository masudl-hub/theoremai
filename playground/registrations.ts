import type {
	HttpMethod,
	ToolAccess,
	ToolLoadTier,
	ToolPermission,
} from '../src/kernel/schema.ts';
import type { HttpToolAuthConfig } from '../src/kernel/tools/types.ts';
import type { StructuredSpec } from '../src/kernel/types.ts';

/** The kernel's auth config; the host's OAuth endpoints are never set from the playground. */
export type PlaygroundToolAuth = Omit<HttpToolAuthConfig, 'preResolved'>;

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
};

export type ToolRegistration =
	| FunctionToolRegistration
	| HttpToolRegistration
	| McpToolRegistration;
