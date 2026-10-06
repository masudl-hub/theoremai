import { resolveAllow, resolveDetect } from './detectors.ts';
import type {
  BlockedReplySpec,
  ProfileGuardrailsSpec,
  ResolvedBlockedReply,
  ResolvedGuardrailPolicy,
} from './types.ts';

/** A blocked reply is rewritten once unless the profile says otherwise. */
const BLOCKED_REPLY: ResolvedBlockedReply = { onBlock: 'retry', maxRetries: 1 };

function resolveBlockedReply(spec: BlockedReplySpec | undefined): ResolvedBlockedReply {
  return {
    onBlock: spec?.onBlock ?? BLOCKED_REPLY.onBlock,
    maxRetries: spec?.maxRetries ?? BLOCKED_REPLY.maxRetries,
  };
}

/** Every ingress and egress path resolves through here so none can drift on what "unset" means. */
function resolveGuardrailPolicy(spec: ProfileGuardrailsSpec | undefined): ResolvedGuardrailPolicy {
  return {
    detect: resolveDetect(spec?.detect),
    allow: resolveAllow(spec?.detect),
    blockedReply: resolveBlockedReply(spec?.blockedReply),
    egress: spec?.egress,
    network: spec?.network,
    quota: spec?.quota,
    taint: spec?.taint,
  };
}

export { resolveGuardrailPolicy };
