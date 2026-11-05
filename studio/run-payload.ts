import type { DecisionAsset, DecisionQuestion, ProfileDefinition } from '@theoremjs/agents';
import { maskHeaders, maskUrl, unmaskHeaders, unmaskUrl } from '@theoremjs/agents/surface';
import { z } from 'zod';
import type { StudioConnectionMode } from './policy.ts';
import type { StudioProvider } from './providers.ts';
import type { StructuredRegistration, ToolRegistration } from './registrations.ts';
import type { StudioDependency } from './runtime-scope.ts';

export type StudioRunPayload = {
  /** Execution choice only. Credentials never belong in this persisted payload. */
  connectionMode?: StudioConnectionMode;
  /** Non-secret localhost connection setting; no bearer key travels with it. */
  localBaseUrl?: string;
  agentId: string;
  profile: ProfileDefinition;
  customTools: ToolRegistration[];
  structured?: StructuredRegistration;
  /** A decision profile's questions, by id. */
  questions?: Record<string, DecisionQuestion>;
  /** The pictures a decision can send, by the reference its questions write. A decision sends only those its state or questions name. */
  images?: Record<string, DecisionAsset>;
  /** The providers its models name, each with its adapter. Left out, they are the studio's own. */
  providers?: readonly StudioProvider[];
  /** The agents this one names, each after the agents it names; registered before it. */
  dependencies?: StudioDependency[];
};

const kept = z.looseObject({
  profile: z.looseObject({ id: z.string() }),
  customTools: z.array(z.looseObject({ name: z.string() })),
});
/** The outline of a run kept in this browser, which an older or other package may have written. */
const keptRun = kept.extend({
  agentId: z.string(),
  dependencies: z.array(kept).optional(),
});

/** The outline of a kept run, or null when `raw` is not one. `defineProfile` checks its profiles when the run opens. */
export function keptStudioRun(raw: unknown): StudioRunPayload | null {
  return keptRun.safeParse(raw).success ? (raw as StudioRunPayload) : null;
}

export function createStudioRunId(): string {
  return crypto.randomUUID();
}

export function readStudioRunIdFromUrl(
  url: string | { href: string } = typeof window !== 'undefined'
    ? globalThis.location
    : { href: '' },
): string | null {
  const href = typeof url === 'string' ? url : url.href;
  if (!href) return null;
  try {
    const parsed = new URL(href, 'http://localhost');
    const run = parsed.searchParams.get('run')?.trim();
    return run && run.length > 0 ? run : null;
  } catch {
    return null;
  }
}

/** A tool's credentials in a run: what its kept copy masks, and the run tab asks the studio tab for. */
export type StudioRunCredentials = Record<
  string,
  { endpoint?: string; serverUrl?: string; headers?: Record<string, string> }
>;

function eachTool(payload: StudioRunPayload): ToolRegistration[] {
  return [
    ...payload.customTools,
    ...(payload.dependencies ?? []).flatMap((dependency) => dependency.customTools),
  ];
}

function mapTools(
  payload: StudioRunPayload,
  change: (tool: ToolRegistration) => ToolRegistration,
): StudioRunPayload {
  return {
    ...payload,
    customTools: payload.customTools.map(change),
    ...(payload.dependencies
      ? {
          dependencies: payload.dependencies.map((dependency) => ({
            ...dependency,
            customTools: dependency.customTools.map(change),
          })),
        }
      : {}),
  };
}

/** The run as this browser keeps it: each tool's URLs and headers with their credentials masked. */
export function maskedStudioRun(payload: StudioRunPayload): StudioRunPayload {
  return mapTools(payload, (tool) => {
    if (tool.type === 'http')
      return {
        ...tool,
        endpoint: maskUrl(tool.endpoint),
        ...(tool.headers ? { headers: maskHeaders(tool.headers) as Record<string, string> } : {}),
      };
    if (tool.type === 'mcp')
      return {
        ...tool,
        serverUrl: maskUrl(tool.serverUrl),
        ...(tool.headers ? { headers: maskHeaders(tool.headers) as Record<string, string> } : {}),
      };
    return tool;
  });
}

/** Each tool's credentials in `payload`, by tool name. */
export function studioRunCredentials(payload: StudioRunPayload): StudioRunCredentials {
  const held: StudioRunCredentials = {};
  for (const tool of eachTool(payload)) {
    if (tool.type === 'http') held[tool.name] = { endpoint: tool.endpoint, headers: tool.headers };
    if (tool.type === 'mcp') held[tool.name] = { serverUrl: tool.serverUrl, headers: tool.headers };
  }
  return held;
}

/** Whether keeping the run masked anything, so the run tab needs the studio tab's credentials. */
export function studioRunIsMasked(payload: StudioRunPayload): boolean {
  return JSON.stringify(maskedStudioRun(payload)) !== JSON.stringify(payload);
}

/** A kept run with what its copy masked put back from `held`, the studio tab's credentials. */
export function withStudioRunCredentials(
  payload: StudioRunPayload,
  held: StudioRunCredentials,
): StudioRunPayload {
  return mapTools(payload, (tool) => {
    const real = held[tool.name];
    if (!real || (tool.type !== 'http' && tool.type !== 'mcp')) return tool;
    const headers =
      tool.headers && real.headers ? { headers: unmaskHeaders(tool.headers, real.headers) } : {};
    if (tool.type === 'http')
      return { ...tool, endpoint: unmaskUrl(tool.endpoint, real.endpoint ?? ''), ...headers };
    return { ...tool, serverUrl: unmaskUrl(tool.serverUrl, real.serverUrl ?? ''), ...headers };
  });
}
