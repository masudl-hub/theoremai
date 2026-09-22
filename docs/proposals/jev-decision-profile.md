# Jev decision profile — proposed specification

**Status:** proposed; no public kernel API is introduced by this document.

## Goal

Add native support for TypeSafe Jev as a first-class Theoremai decision
capability. A Jev call resolves structured questions over host-supplied JSON
state; it is not a conversational turn, a tool loop, or a streaming provider.

The design must preserve Theoremai's existing profile, key-vault, guardrail,
observability, and interface conventions without representing Jev as an
OpenAI-compatible chat provider.

## Scope

V1 provides one native Jev adapter and one execution door:

```ts
const result = await runDecision({
  profile: 'triage',
  state: { authorization: 'none', operation: 'delete-account' },
  questions: [
    choice('action', ['execute', 'ask_user', 'decline']),
    score('risk', ['low', 'high']),
  ],
});
```

`result` is a validated, non-streaming decision result. The host decides how
to present or act on it.

V1 does not add chat completion compatibility, media understanding, tools,
system prompts, history, streaming, output repair, retries after an ambiguous
request, or a generic multi-provider decision abstraction.

## Architectural position

`decision` is a profile archetype beside `text`, `image`, `speech`, `live`,
and `host`.

It follows the established `live` precedent:

```text
defineProfile / registry / projection / guardrail policy / trace destination
                                  |
                              runDecision
                                  |
                           native Jev adapter
                                  |
                          TypeSafe System One API
```

It deliberately does **not** pass through `resolveTurn`,
`ProviderCompleteRequest`, `ModelProvider.complete`, `TurnEvent`, or chat
egress repair. Those contracts encode conversational input, output, and
streaming semantics that Jev does not have.

## Profile schema

The exact exported names may follow repository naming conventions, but the
semantic shape is fixed:

```ts
type DecisionJson =
  | null
  | string
  | number
  | boolean
  | DecisionJson[]
  | { [key: string]: DecisionJson };

interface DecisionModelBinding {
  /** TypeSafe API model id, e.g. `jev-latest` or a pinned release. */
  apiId: string;
  /** Optional named vault credential; falls back to the profile key. */
  key?: KeySlot;
  /** Per-attempt network deadline. */
  timeoutMs?: number;
  /** Defaults to zero: POST timeout outcomes may have reached the service. */
  retry?: { maxRetries?: number };
}

interface DecisionInputsSpec {
  /** Jev accepts JSON state, including scalar JSON values. */
  state: 'json';
  maxStateBytes?: number;
}

interface DecisionProfile {
  type: 'decision';
  id: ProfileId;
  identity: { handle: string };

  models: Record<ModelId, DecisionModelBinding>;
  defaultModel?: ModelId;
  allowModelSelect?: boolean;
  key?: OverflowKeySlot;

  inputs: DecisionInputsSpec;
  decision: { contract: DecisionContractId };
  guardrails?: DecisionGuardrailsSpec;
  observability?: ProfileObservabilitySpec;
}
```

`protocol` and `provider` are intentionally absent. In current Theoremai they
mean a selection for `createProvider` and a chat/live wire transport. Jev has a
native execution path. If a second decision engine is added later, adapters
belong behind `runDecision`; adding a transport-shaped field now would make the
profile claim behavior it does not have.

The registry retains the familiar `models`, `defaultModel`,
`allowModelSelect`, and vault-key ergonomics. This requires extracting the
generic model-selection fields from chat-specific `ModelBinding` rather than
widening `ModelBinding` until its required `protocol` and `provider` fields
become optional.

## Decision contracts and requests

A contract is a registered host-owned definition of permitted question ids and
their expected answer shapes. It prevents a profile intended for one decision
from silently being used to ask unrelated questions.

```ts
type DecisionQuestion =
  | {
      type: 'choice';
      id: string;
      instructions: string;
      choices: readonly string[];
    }
  | {
      type: 'noul';
      id: string;
      instructions: string;
    }
  | {
      type: 'score';
      id: string;
      instructions: string;
      criteria: readonly [string, ...string[]];
    };

interface DecisionRequest {
  profile: ProfileId;
  state: DecisionJson;
  questions: readonly DecisionQuestion[];
  model?: ModelId;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}
```

V1 may accept a contract-selected subset of questions, but must reject unknown
ids, duplicate ids, empty instructions, empty choice lists, and malformed
criteria before making a network request. `state: null` is rejected by the
native adapter even though it is valid JSON, because the tested Jev endpoint
rejects it.

The contract owns application semantics such as whether a decision is merely
advisory or authorizes an action. Theoremai must not promote a Jev answer into
authority automatically.

## Results and errors

The runner returns typed answers and normalized usage. It validates the Jev
response against the submitted question set before returning it.

```ts
type DecisionAnswer =
  | { type: 'choice'; id: string; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; id: string; score: number; confidence: number }
  | { type: 'score'; id: string; score: number; confidence: number; legend: Record<string, number>; probabilities: Record<string, number> };

interface DecisionResult {
  model: string;
  answers: readonly DecisionAnswer[];
  usage?: { inputTokens: number; outputTokens: number };
}

type DecisionFailure =
  | { code: 'invalid_request'; status: 400 | 422 }
  | { code: 'authentication'; status: 401 }
  | { code: 'permission'; status: 403 }
  | { code: 'rate_limited'; status: 429; retryAfterMs?: number }
  | { code: 'unavailable'; status?: number }
  | { code: 'timeout' }
  | { code: 'cancelled' }
  | { code: 'malformed_response' }
  | { code: 'disclosure_blocked' };
```

No `TurnEvent` is emitted. A host that wants a user-visible explanation must
generate or render one on its own explicit path.

## Guardrails and egress

Existing `ProfileEgressSpec` protects model output released to an end user. It
is not a fit for a Jev request: its retry/repair behavior mutates output and
does not govern outbound state disclosure.

Decision profiles add a separate, pre-dispatch disclosure gate:

```ts
interface DecisionDisclosureContext {
  destination: 'typesafe';
  model: string;
  profile: ProfileId;
  questions: readonly DecisionQuestion[];
}

type DecisionDisclosureEnforcer = (
  state: DecisionJson,
  context: DecisionDisclosureContext,
) => Verdict | Promise<Verdict>;

interface DecisionGuardrailsSpec {
  quota?: QuotaGuardrailSpec;
  sanitizeInput?: boolean;
  redactSensitive?: boolean;
  disclosure?: { enforce: DecisionDisclosureEnforcer };
}
```

The gate is allow/block only. It must never redact, rewrite, repair, or retry
state, because changing the evidence can change the decision. A blocked request
makes no provider call.

`sanitizeDecisionState` recursively visits string leaves and records existing
guardrail hits. Its V1 contract is detect/report plus disclosure policy; it must
not silently substitute text into state. This preserves semantic fidelity while
giving the host enough information to reject, route, or explicitly transform
the request upstream.

`canary`, chat `egress`, network/tool controls, `maxSteps`, and turn-resumption
settings are invalid on `decision` profiles. `defineProfile` must reject them,
as it already rejects inert fields for `host` and `live` profiles.

## Observability

Decision execution reuses `ProfileObservabilitySpec`, destination resolution,
sampling, retention, and scrub configuration. It introduces a distinct
`DecisionTraceRecord`; it must not fabricate a turn trace.

A record includes:

- profile id and selected model alias / resolved `apiId`;
- timing, outcome, normalized failure code, and usage;
- contract id and question ids/types;
- state and result hashes, plus scrubbed summaries only when policy permits;
- disclosure and sanitization guardrail hits.

Raw API keys, complete raw state, and raw provider payloads are excluded by
default. A trace write failure never changes the decision outcome.

## Interface and wrong-door behavior

`projectProfile` and the headless interface need a `DecisionProfileInterface`.
It exposes identity, model selection, JSON-state input capability, contract id,
and serializable policy views. It does not expose a composer, transcript,
attachments, tool palette, streaming controls, or chat output schema.

The public doors are unambiguous:

```text
runTurn(decision profile)       -> deterministic profile-type error
runSession(decision profile)    -> deterministic profile-type error
createProvider(decision profile)-> deterministic profile-type error
runDecision(non-decision)       -> deterministic profile-type error
```

## Native adapter behavior

The adapter sends one System One request to TypeSafe with the selected `apiId`,
state, and questions. It verifies the response model, answer ids/types,
probability labels and sums where applicable, scores, confidences, legends, and
non-negative usage counters.

The verified probe establishes these integration facts:

- valid primitive and structured JSON state succeeds;
- `state: null` is rejected with `422`;
- an all-null/malformed question is rejected with `400`;
- invalid score criteria containing `null` are rejected with `422`;
- a `noul` question without instructions is rejected with `400`;
- an invalid credential is rejected with `401`.

The live probe is a regression check, not a kernel dependency:

```sh
export TYPESAFE_API_KEY="$(security find-generic-password -a "$USER" -s theoremai.typesafe-api-key -w)"
deno task verify:jev-api --full --edge --use-cases --failure-states
```

The script never prints or persists the credential.

## Implementation order

1. Add the `decision` discriminant, schema metadata, profile graph facet, and
   definition validation. Add explicit rejection for chat-only/inert fields.
2. Extract generic model selection and profile projection primitives without
   weakening `ModelBinding` or `ModelProfile`'s chat transport guarantees.
3. Add decision contracts, request/result types, `runDecision`, and wrong-door
   errors. Export the new surface from the kernel barrel.
4. Implement the native Jev adapter with fake-fetch response fixtures and no
   ambient credentials.
5. Add decision disclosure, recursive detection/reporting, quota integration,
   and `DecisionTraceRecord` using existing trace sink policy.
6. Add the headless decision interface and update documentation ownership.

## Acceptance criteria

- `defineProfile` accepts a valid decision profile and rejects `protocol`,
  `provider`, `outputs`, `tools`, `system`, `maxSteps`, chat egress, canary,
  and turn behavior on it.
- Profile graph, field metadata, registry projection, and headless interface
  exhaustiveness tests cover `decision`.
- Model selection and key-slot resolution work without making `ModelBinding`
  permissive or changing existing text/image/speech/live behavior.
- No decision request can reach `createProvider`, `runTurn`, or `runSession`.
- Invalid local requests and disclosure blocks make zero network calls.
- Adapter fixtures cover `400`, `401`, `403`, `409`, `413`, `422`, `429`,
  timeout, abort, malformed JSON, and schema-invalid successful responses.
- State is never silently altered by sanitization or disclosure enforcement.
- Decision traces cannot contain credentials and honor sampling/scrub policy.
- Existing profile, interface, guardrail, and observability suites remain green;
  the opt-in live Jev probe passes when a Keychain credential is available.

## Deferred to V2

- registered decision templates and richer contract versioning;
- explicit evaluation datasets, calibration reporting, and drift monitoring;
- host-authorized action policies that consume a decision result;
- composition of multiple decision models;
- media-to-facts host workflows with provenance conventions.
