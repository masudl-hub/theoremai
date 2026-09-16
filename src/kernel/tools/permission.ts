/**
 * Declarative catalog permission + gate-resume helpers.
 *
 * Shared by function and HTTP/MCP execute paths (no circular import with remote).
 *
 * @module
 */

import type { InvokeToolResume, ToolGate, ToolPermission } from './types.ts';

export function isResumeContinuation(resume?: InvokeToolResume): boolean {
  return resume?.value !== undefined || typeof resume?.granted === 'boolean';
}

/** Gate resume — only `granted: true` skips confirm/permission/`preTool` re-ask. */
export function isGateResumeGranted(resume?: InvokeToolResume): boolean {
  return resume?.granted === true;
}

/** Host denied after a gate — settle without running the body. */
export function isGateResumeDenied(resume?: InvokeToolResume): boolean {
  return resume?.granted === false;
}

export function permissionGranted(toolName: string, sessionPermissions?: string[]): boolean {
  if (!sessionPermissions) {
    return false;
  }
  return sessionPermissions.includes('*') || sessionPermissions.includes(toolName);
}

export function checkPermission(
  toolName: string,
  permission: ToolPermission,
  sessionPermissions?: string[],
  resume?: InvokeToolResume,
): ToolGate | null {
  if (permission === 'auto') {
    return null;
  }
  if (permission === 'always_confirm') {
    if (resume?.granted === true) {
      return null;
    }
    return {
      kind: 'permission',
      tool: toolName,
      permission,
    };
  }
  if (permissionGranted(toolName, sessionPermissions)) {
    return null;
  }
  return {
    kind: 'permission',
    tool: toolName,
    permission,
  };
}
