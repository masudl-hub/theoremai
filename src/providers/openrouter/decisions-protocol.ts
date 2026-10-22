import { extendProtocol, type Protocol } from '../../kernel/protocols/mod.ts';
import { type SystemOneOptions, systemOne } from '../system-one/protocol.ts';

/** OpenRouter's decision API: System One's questions and answers, at OpenRouter's own endpoint. */
export const openRouterDecisions: Protocol<SystemOneOptions> = extendProtocol(systemOne, {
  id: 'openRouterDecisions',
  name: 'OpenRouter Decisions',
  description: "OpenRouter's decision API: questions about a state, answered in one call.", // labels-exempt: builder field description, read by the studio and docs
  endpoints: { decision: '/alpha/decisions' },
});
