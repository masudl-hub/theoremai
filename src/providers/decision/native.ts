import { kindOfHttpStatus, TheoremError, throwIfAborted } from '../../guardrails/error.ts';
import type { ProviderContext, ProviderDecisionRequest } from '../../kernel/provider-contract.ts';
import type { DecisionResult } from '../../kernel/types.ts';
import { isRecord } from '../../kernel/util/record.ts';
import { decisionUsage } from './usage.ts';

export async function nativeDecision(
  request: ProviderDecisionRequest,
  context: ProviderContext,
  endpoint: string,
  service: 'typesafe' | 'openrouter',
): Promise<DecisionResult> {
  const credential = await context.resolveCredential('primary');
  if (typeof credential !== 'string')
    throw new TheoremError('auth', 'Decision provider requires a credential');
  throwIfAborted(request.signal);
  const response = await context.fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: request.apiId,
      state: request.state,
      questions: request.questions,
    }),
    signal: request.signal,
  });
  if (!response.ok)
    throw Object.assign(
      new TheoremError(kindOfHttpStatus(response.status), 'Decision provider request failed'),
      { status: response.status },
    );
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.model !== 'string' || !body.model || !isRecord(body.answers))
    throw new TheoremError('bad_response', 'Decision response has an invalid shape');
  const usage = decisionUsage(body.usage, { apiId: request.apiId, provider: service }, body.model);
  // invariant: The kernel validates every answer against its question before exposing it.
  return {
    model: body.model,
    answers: body.answers as DecisionResult['answers'],
    ...(usage ? { usage } : {}),
  };
}
