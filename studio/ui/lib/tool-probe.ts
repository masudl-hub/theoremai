/**
 * One real call to a draft tool, from the server, which reaches public hosts only: the editor's
 * Test and th30's `test` action both go through here.
 */
import { HTTP_METHODS } from '../../../mod.ts';
import { credentialHeaderProblem, type ToolSpecDraft } from '../../mod.ts';

/** What the test-connection route answers: an HTTP response, or an MCP server's tool list. */
export interface ProbeResult {
	ok: boolean;
	status?: number;
	statusText?: string;
	error?: string;
	preview?: string;
	elapsedMs?: number;
	tools?: string[];
	targetToolFound?: boolean;
}

/** A JSON object typed into the test, or why it isn't one. Blank is `undefined`. */
function parseObject(
	raw: string,
	label: string,
): { value?: Record<string, unknown>; error?: string } {
	if (!raw.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { value: parsed as Record<string, unknown> };
		}
	} catch {
		// Falls through to the error below.
	}
	return { error: `${label} must be a JSON object.` };
}

/** The test-connection request for `tool`. The server applies its own network policy. */
function probeRequest(
	tool: ToolSpecDraft,
	sampleInput: string,
	credential: string,
): { body?: Record<string, unknown>; error?: string } {
	const headers = parseObject(tool.headersJson ?? '', 'Headers');
	if (headers.error) return { error: headers.error };
	const credentialHeader = credentialHeaderProblem(
		headers.value as Record<string, string> | undefined,
	);
	if (credentialHeader) return { error: credentialHeader };
	const authType = tool.authType ?? 'none';
	const shared = {
		headers: headers.value,
		...(authType === 'none'
			? {}
			: {
					auth: {
						type: authType,
						headerName: tool.authHeaderName,
						headerPrefix: tool.authHeaderPrefix,
					},
					testCredential: credential || undefined,
				}),
	};
	if (tool.toolType === 'mcp') {
		return {
			body: {
				type: 'mcp',
				serverUrl: tool.serverUrl ?? '',
				mcpToolName: tool.mcpToolName,
				...shared,
			},
		};
	}
	const input = parseObject(sampleInput, 'Sample input');
	if (input.error) return { error: input.error };
	return {
		body: {
			type: 'http',
			endpoint: tool.endpoint ?? '',
			method: tool.method ?? HTTP_METHODS[0],
			pathParams: tool.pathParams,
			queryParams: tool.queryParams,
			bodyParam: tool.bodyParam,
			sampleInput: input.value,
			...shared,
		},
	};
}

/** Sends the probe; a request that can't be made, or a server that can't be reached, comes back as a failed result. */
export async function runToolProbe(
	tool: ToolSpecDraft,
	sampleInput: string,
	credential: string,
): Promise<ProbeResult> {
	const request = probeRequest(tool, sampleInput, credential);
	if (!request.body) return { ok: false, error: request.error };
	try {
		const response = await fetch('/api/studio/test-connection', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request.body),
		});
		return await response.json<ProbeResult>();
	} catch {
		return { ok: false, error: "Couldn't reach the studio server." };
	}
}
