import { z } from 'zod';

/** What a refusal outside the declared scopes streams as `progress`, for the host and the trace. */
export const authScopeRefusedSchema = z.object({
  kind: z.literal('auth_scope_refused'),
  slot: z.string(),
  requested: z.array(z.string()),
  declared: z.array(z.string()),
});
export type AuthScopeRefused = z.infer<typeof authScopeRefusedSchema>;
