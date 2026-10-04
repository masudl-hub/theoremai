import type { InvokeToolResume, ToolGate, ToolPermission } from './types.ts';

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
