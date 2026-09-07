/**
 * Bundled egress policy helpers for hosts that want kernel-default disclosure checks.
 *
 * @module
 */

import type { EgressContext, EgressEnforcementResult } from '../kernel/types.ts';
import { scanTextForCanaryLeak } from './canary.ts';
import { injectionSpans } from './injection.ts';
import { sensitiveSpans } from './sensitive.ts';

const SYSTEM_BOUNDARY = /This turn's canary is|<\/?user_data>|Untrusted user content is inside/i;

/** Default egress enforce — canary leak, sensitive echo, fence markers, injection echo. */
function standardEgressEnforce(context: EgressContext): EgressEnforcementResult {
  const { text, canary } = context;
  const hits: string[] = [];
  if (canary && scanTextForCanaryLeak(text, canary)) {
    hits.push('canary');
  }
  if (sensitiveSpans(text).length > 0) {
    hits.push('sensitive');
  }
  if (SYSTEM_BOUNDARY.test(text)) {
    hits.push('system_boundary');
  }
  if (injectionSpans(text).length > 0) {
    hits.push('injection_echo');
  }
  if (hits.length > 0) {
    return {
      blocked: true,
      text: '',
      hits,
      rejectionMessage: `Egress blocked: ${hits.join(', ')}`,
    };
  }
  return { blocked: false, text };
}

export { standardEgressEnforce };
