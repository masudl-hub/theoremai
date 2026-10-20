import type { ToolAccess } from '../schema.ts';
import type { ToolGateBase } from '../turn-events.ts';
import { fillActivityLabel } from './activity-label.ts';
import type { InvokeToolResume, ToolGate, ToolLabels, ToolPermission } from './types.ts';

export function isResumeContinuation(resume?: InvokeToolResume): boolean {
  return typeof resume?.granted === 'boolean';
}

export function isGateResumeGranted(resume?: InvokeToolResume): boolean {
  return resume?.granted === true;
}

export function isGateResumeDenied(resume?: InvokeToolResume): boolean {
  return resume?.granted === false;
}

export function permissionGranted(toolName: string, sessionPermissions?: string[]): boolean {
  if (!sessionPermissions) {
    return false;
  }
  return sessionPermissions.includes('*') || sessionPermissions.includes(toolName);
}

/** What a gate says about the call beyond its kind: the tool's access and its filled request. */
export type GateDetails = Pick<ToolGateBase, 'access' | 'request'>;

/** What an approval card says about a call: what it would do, and what the tool can change. */
export function gateDetails(
  tool: { access: ToolAccess; labels?: ToolLabels },
  input: unknown,
): GateDetails {
  const request = fillActivityLabel(tool.labels?.request, { input });
  return { access: tool.access, ...(request ? { request } : {}) };
}

export function checkPermission(
  toolName: string,
  permission: ToolPermission,
  sessionPermissions?: string[],
  resume?: InvokeToolResume,
  details?: GateDetails,
): ToolGate | null {
  if (permission === 'auto') {
    return null;
  }
  const granted =
    permission === 'always_confirm'
      ? resume?.granted === true
      : permissionGranted(toolName, sessionPermissions);
  if (granted) {
    return null;
  }
  return {
    kind: 'permission',
    tool: toolName,
    permission,
    ...details,
  };
}
