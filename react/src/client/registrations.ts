import type {
	AuthUnauthenticatedPolicy,
	HttpMethod,
	SchemaEnforcement,
	ToolAccess,
	ToolAuthType,
	ToolLoadTier,
	ToolPermission,
} from '../../../src/kernel/schema.ts';

export type StructuredRegistration = {
	id: string;
	spec: {
		enforced: SchemaEnforcement;
		jsonSchema?: Record<string, unknown>;
	};
};

/** Compiled custom tool ready for host registerTool + export source. */
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
	/** Playground function stub payload when set (overrides generic stub). */
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
	auth?: {
		slot: string;
		type: ToolAuthType;
		headerName?: string;
		headerPrefix?: string;
		onUnauthenticated?: AuthUnauthenticatedPolicy;
		scopes?: string[];
		clientId?: string;
		redirectUri?: string;
	};
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
	auth?: {
		slot: string;
		type: ToolAuthType;
		headerName?: string;
		headerPrefix?: string;
		onUnauthenticated?: AuthUnauthenticatedPolicy;
		scopes?: string[];
		clientId?: string;
		redirectUri?: string;
	};
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
};

export type ToolRegistration =
	| FunctionToolRegistration
	| HttpToolRegistration
	| McpToolRegistration;
