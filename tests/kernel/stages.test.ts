/**
 * Pressure tests for frozen turn-stage shapes and defensive affordance apply.
 */
import { assertEquals } from '../../src/kernel/engine/assert.ts';
import {
  AWAITING_USER_INPUT_STATUS,
  TOOL_GATE_KINDS,
  TURN_INJECT_STAGES,
  TURN_STAGES,
  TURN_STOP_KINDS,
} from '../../src/kernel/schema.ts';
import {
  applyStageResult,
  isAwaitingUserInput,
  isToolGateKind,
  isTurnInjectStage,
  isTurnStage,
  parseAwaitingUserInput,
  parseToolGate,
  STAGE_AFFORDANCE_MATRIX,
  STAGE_AFFORDANCES,
  stageAllowsAffordance,
  stageEventFields,
} from '../../src/kernel/stages.ts';
import { profileAllowsInject, profileAllowsSteering } from '../../src/kernel/stop.ts';

Deno.test('TURN_STAGES is the locked five-stage timeline', () => {
  assertEquals([...TURN_STAGES], ['pre_turn', 'pre_tool', 'post_tool', 'before_end', 'post_turn']);
  for (const s of TURN_STAGES) assertEquals(isTurnStage(s), true);
  assertEquals(isTurnStage('pre_llm'), false);
  assertEquals(isTurnStage('pre_tool_followup'), false);
  assertEquals(isTurnStage('barrier'), false);
});

Deno.test('TURN_INJECT_STAGES excludes tool gates and post_turn', () => {
  assertEquals([...TURN_INJECT_STAGES], ['pre_turn', 'post_tool', 'before_end']);
  assertEquals(isTurnInjectStage('pre_tool'), false);
  assertEquals(isTurnInjectStage('post_turn'), false);
});

Deno.test('STAGE_AFFORDANCE_MATRIX matches the contract table', () => {
  assertEquals([...STAGE_AFFORDANCES], ['inject', 'abort', 'deny', 'confirm', 'mutate']);
  assertEquals([...STAGE_AFFORDANCE_MATRIX.pre_turn], ['inject', 'abort']);
  assertEquals([...STAGE_AFFORDANCE_MATRIX.pre_tool], ['abort', 'deny', 'confirm', 'mutate']);
  assertEquals([...STAGE_AFFORDANCE_MATRIX.post_tool], ['inject', 'abort']);
  assertEquals([...STAGE_AFFORDANCE_MATRIX.before_end], ['inject', 'abort']);
  assertEquals([...STAGE_AFFORDANCE_MATRIX.post_turn], []);
  assertEquals(stageAllowsAffordance('pre_tool', 'inject'), false);
  assertEquals(stageAllowsAffordance('post_turn', 'abort'), false);
  assertEquals(stageAllowsAffordance('before_end', 'inject'), true);
});

Deno.test('TURN_STOP_KINDS includes gate and keeps deprecated tool', () => {
  assertEquals(TURN_STOP_KINDS.includes('gate'), true);
  assertEquals(TURN_STOP_KINDS.includes('tool'), true);
});

Deno.test('profileAllowsInject vs profileAllowsSteering', () => {
  assertEquals(profileAllowsSteering({ type: 'text' }), true);
  assertEquals(
    profileAllowsSteering({ type: 'text', turnBehaviour: { allowSteering: false } }),
    false,
  );
  assertEquals(profileAllowsSteering({ type: 'live' }), false);
  assertEquals(profileAllowsSteering({ type: 'image' }), false);

  assertEquals(profileAllowsInject({ type: 'text' }), true);
  assertEquals(profileAllowsInject({ type: 'live' }), true);
  assertEquals(
    profileAllowsInject({ type: 'live', turnBehaviour: { allowSteering: false } }),
    false,
  );
  assertEquals(profileAllowsInject({ type: 'image' }), false);
  assertEquals(profileAllowsInject({ type: 'speech' }), false);
  assertEquals(profileAllowsInject({ type: 'host' }), false);
});

Deno.test('applyStageResult: empty / null / non-object is a no-op', () => {
  assertEquals(applyStageResult({ stage: 'pre_turn', result: undefined, injectAllowed: true }), {
    warnings: [],
  });
  assertEquals(applyStageResult({ stage: 'pre_turn', result: null, injectAllowed: true }), {
    warnings: [],
  });
  const bad = applyStageResult({ stage: 'pre_turn', result: ['nope'], injectAllowed: true });
  assertEquals(bad.inject, undefined);
  assertEquals(bad.warnings[0]?.code, 'result_invalid');
});

Deno.test('applyStageResult: inject matrix and gate', () => {
  const ok = applyStageResult({
    stage: 'before_end',
    injectAllowed: true,
    result: { inject: [{ role: 'user', content: 'more' }] },
  });
  assertEquals(ok.inject?.length, 1);
  assertEquals(ok.warnings.length, 0);

  const blockedStage = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: true,
    result: { inject: [{ role: 'user', content: 'x' }] },
  });
  assertEquals(blockedStage.inject, undefined);
  assertEquals(blockedStage.warnings[0]?.code, 'affordance_not_allowed');

  const blockedGate = applyStageResult({
    stage: 'post_tool',
    injectAllowed: false,
    result: { inject: [{ role: 'user', content: 'x' }] },
  });
  assertEquals(blockedGate.inject, undefined);
  assertEquals(blockedGate.warnings[0]?.code, 'inject_not_allowed');

  const maxSteps = applyStageResult({
    stage: 'before_end',
    injectAllowed: true,
    injectWouldExceedMaxSteps: true,
    result: { inject: [{ role: 'user', content: 'x' }] },
  });
  assertEquals(maxSteps.inject, undefined);
  assertEquals(maxSteps.warnings[0]?.code, 'inject_rejected_max_steps');

  const postTurn = applyStageResult({
    stage: 'post_turn',
    injectAllowed: true,
    result: { inject: [{ role: 'user', content: 'x' }] },
  });
  assertEquals(postTurn.inject, undefined);
  assertEquals(postTurn.warnings[0]?.code, 'affordance_not_allowed');
});

Deno.test('applyStageResult: inject whitelist — drop tool role and strip junk keys', () => {
  const out = applyStageResult({
    stage: 'pre_turn',
    injectAllowed: true,
    result: {
      inject: [
        { role: 'tool', content: 'nope', tool_call_id: 'c1', name: 't' },
        {
          role: 'user',
          content: 'yes',
          tool_call_id: 'should-warn',
          evil: true,
          metadata: { a: 1 },
        },
        { role: 'assistant', content: 12 },
        { role: 'system' },
      ],
    },
  });
  const inject = out.inject ?? [];
  assertEquals(inject.length, 2);
  const first = inject[0];
  const second = inject[1];
  assertEquals(first, { role: 'user', content: 'yes', metadata: { a: 1 } });
  assertEquals(second, { role: 'system' });
  assertEquals((first as unknown as Record<string, unknown>).evil, undefined);
  assertEquals(
    out.warnings.some((w) => w.code === 'inject_invalid_messages'),
    true,
  );
});

Deno.test('applyStageResult: deny / confirm / mutate only on pre_tool', () => {
  const denyOk = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { deny: {} },
  });
  assertEquals(denyOk.deny, { code: 'not_authorized', message: 'Tool execution not authorized' });

  const denyElsewhere = applyStageResult({
    stage: 'post_tool',
    injectAllowed: true,
    result: { deny: { code: 'x', message: 'y' } },
  });
  assertEquals(denyElsewhere.deny, undefined);
  assertEquals(denyElsewhere.warnings[0]?.code, 'affordance_not_allowed');

  const confirm = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { confirm: true },
  });
  assertEquals(confirm.confirm, {});

  const confirmSummary = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { confirm: { summary: '  run me  ' } },
  });
  assertEquals(confirmSummary.confirm, { summary: 'run me' });

  const both = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { deny: { code: 'no', message: 'nope' }, confirm: true },
  });
  assertEquals(both.deny?.code, 'no');
  assertEquals(both.confirm, undefined);
  assertEquals(
    both.warnings.some((w) => w.field === 'confirm'),
    true,
  );

  const mutate = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { mutate: { input: { a: 1 } } },
  });
  assertEquals(mutate.mutate, { input: { a: 1 } });

  const mutateNullInput = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { mutate: { input: null } },
  });
  assertEquals(mutateNullInput.mutate, { input: null });

  const mutateBad = applyStageResult({
    stage: 'before_end',
    injectAllowed: true,
    result: { mutate: { input: 1 } },
  });
  assertEquals(mutateBad.mutate, undefined);

  const mutateShape = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { mutate: { wrong: true } },
  });
  assertEquals(mutateShape.mutate, undefined);
  assertEquals(mutateShape.warnings[0]?.code, 'mutate_invalid');
});

Deno.test('applyStageResult: abort rules and unknown fields', () => {
  const ok = applyStageResult({
    stage: 'pre_turn',
    injectAllowed: true,
    result: { abort: { reason: ' stop ' } },
  });
  assertEquals(ok.abort, { reason: 'stop' });

  const emptyReason = applyStageResult({
    stage: 'pre_tool',
    injectAllowed: false,
    result: { abort: { reason: '   ' } },
  });
  assertEquals(emptyReason.abort, true);

  const post = applyStageResult({
    stage: 'post_turn',
    injectAllowed: false,
    result: { abort: true },
  });
  assertEquals(post.abort, undefined);
  assertEquals(post.warnings[0]?.code, 'affordance_not_allowed');

  const unknown = applyStageResult({
    stage: 'pre_turn',
    injectAllowed: true,
    result: { pause: { kind: 'interactive' }, inject: [{ role: 'user', content: 'x' }] },
  });
  assertEquals(unknown.inject?.length, 1);
  assertEquals(
    unknown.warnings.some((w) => w.code === 'unknown_field' && w.field === 'pause'),
    true,
  );
});

Deno.test('parseAwaitingUserInput: strict shape', () => {
  assertEquals(parseAwaitingUserInput(null), undefined);
  assertEquals(parseAwaitingUserInput({ status: AWAITING_USER_INPUT_STATUS }), undefined);
  assertEquals(
    parseAwaitingUserInput({
      status: AWAITING_USER_INPUT_STATUS,
      kind: 'text',
      prompt: '  ',
    }),
    undefined,
  );
  assertEquals(
    parseAwaitingUserInput({
      status: AWAITING_USER_INPUT_STATUS,
      kind: 'choice',
      prompt: 'Pick',
    }),
    undefined,
  );
  assertEquals(
    parseAwaitingUserInput({
      status: AWAITING_USER_INPUT_STATUS,
      kind: 'choice',
      prompt: 'Pick',
      options: ['a', ''],
    }),
    undefined,
  );
  assertEquals(
    parseAwaitingUserInput({
      status: AWAITING_USER_INPUT_STATUS,
      kind: 'confirm',
      prompt: 'OK?',
      options: 'nope',
    }),
    undefined,
  );

  const ok = parseAwaitingUserInput({
    status: AWAITING_USER_INPUT_STATUS,
    kind: 'choice',
    prompt: ' Pick ',
    options: [' a ', 'b'],
  });
  assertEquals(ok !== undefined, true);
  assertEquals(ok, {
    status: AWAITING_USER_INPUT_STATUS,
    kind: 'choice',
    prompt: 'Pick',
    options: ['a', 'b'],
  });
  assertEquals(isAwaitingUserInput(ok), true);
  assertEquals(isAwaitingUserInput({ finding: 'hi' }), false);

  const text = parseAwaitingUserInput({
    status: AWAITING_USER_INPUT_STATUS,
    kind: 'text',
    prompt: 'Name?',
  });
  assertEquals(text?.kind, 'text');
  assertEquals(text?.options, undefined);
});

Deno.test('parseToolGate: auth requires challenge; kinds closed', () => {
  assertEquals([...TOOL_GATE_KINDS], ['confirmation', 'permission', 'auth']);
  assertEquals(isToolGateKind('interactive'), false);
  assertEquals(isToolGateKind('pause'), false);

  assertEquals(parseToolGate({ kind: 'confirmation' }), undefined);
  assertEquals(parseToolGate({ kind: 'confirmation', tool: 'ask' })?.kind, 'confirmation');
  assertEquals(
    parseToolGate({ kind: 'confirmation', tool: '  ask  ', permission: 'always_confirm' })
      ?.permission,
    'always_confirm',
  );
  assertEquals(
    parseToolGate({ kind: 'confirmation', tool: 'ask', permission: 'nope' })?.permission,
    undefined,
  );

  assertEquals(
    parseToolGate({
      kind: 'auth',
      tool: 'http_tool',
      authChallenge: { slot: 's', authType: 'oauth2', message: 'login' },
    })?.authChallenge?.slot,
    's',
  );
  assertEquals(
    parseToolGate({
      kind: 'auth',
      tool: 'http_tool',
      authChallenge: { slot: 's', authType: 'nope', message: 'login' },
    }),
    undefined,
  );
  assertEquals(
    parseToolGate({ kind: 'auth', tool: 'http_tool', authChallenge: { slot: 's' } }),
    undefined,
  );
  assertEquals(parseToolGate({ kind: 'auth', tool: 'http_tool' }), undefined);
  assertEquals(parseToolGate({ kind: 'confirmation' }, 'fallback')?.tool, 'fallback');
});

Deno.test('stageEventFields marks stream discriminant and strips junk', () => {
  assertEquals(stageEventFields('pre_turn'), { type: 'stage', stage: 'pre_turn' });
  const gated = stageEventFields('pre_tool', {
    callNotStarted: true,
    callId: 'c1',
    toolName: 'ask',
  });
  assertEquals(gated.type, 'stage');
  assertEquals(gated.stage, 'pre_tool');
  assertEquals(gated.callNotStarted, true);
  assertEquals(gated.callId, 'c1');
  assertEquals(gated.toolName, 'ask');
  const stripped = stageEventFields('post_tool', {
    callId: 'c2',
    awaiting: true,
    outputRaw: { secret: true },
  } as Partial<{
    callId: string;
    awaiting: boolean;
    outputRaw: unknown;
  }>);
  assertEquals((stripped as unknown as Record<string, unknown>).outputRaw, undefined);
  assertEquals(stripped.awaiting, true);
  assertEquals(stripped.callId, 'c2');
});
