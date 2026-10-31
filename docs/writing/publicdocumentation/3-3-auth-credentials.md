# Auth & Credentials

Tools that read private user data or mutate external services must act on behalf of the signed-in user, not with ambient environment credentials or shared server keys.

Theorem decouples credential management from tool definitions:
* **Zero Model Exposure**: Credentials are never placed in prompt context, tool definitions, or browser bundles.
* **Automatic Echo Scrubbing**: If an external API reflects credentials in its response body or headers, Theorem strips the value and substitutes `[omitted - credential]` before emitting trace events or returning data to the model.
* **Origin-Locked Dispatch**: Credentials are delivered exclusively to the tool's verified origin and never forwarded across HTTP redirects.

---

## Declaring Tool Auth (`auth`)

Add an `auth` block to any tool definition (`function`, `http`, or `mcp`) to specify how it authenticates:

```ts
import { registerTool } from '@theoremjs/agents';

registerTool({
  type: 'http',
  name: 'list_user_shipments',
  endpoint: 'https://api.tracker.example/shipments',
  method: 'GET',
  // ... access, loadTier, input, output

  auth: {
    slot: 'tracker',
    type: 'oauth2',
    service: 'FreightTracker',
    scopes: ['shipments.read'],
    onUnauthenticated: 'gate',
  },
});
```

* **`slot`**: Logical identifier naming where this credential is saved. Multiple tools targeting the same service share a slot.
* **`type`**: Credential shape: `'bearer'`, `'api_key'`, or `'oauth2'`.
* **`service`**: Human-readable service name displayed on the sign-in prompt.
* **`scopes`**: OAuth scopes required for execution.
* **`preResolved`**: Optional endpoints (`authorizationEndpoint`, `tokenEndpoint`) for providers lacking RFC 8414 discovery metadata.

---

## Credential Placement

By default, bearer tokens and API keys are sent in the `Authorization` header:

```ts
// Default header placement
auth: {
  slot: 'metrics',
  type: 'bearer', // Header: "Authorization: Bearer <token>"
  service: 'MetricsService',
}
```

### Custom Headers

For services expecting non-standard authorization headers (e.g., `X-API-Key`):

```ts
auth: {
  slot: 'custom_gateway',
  type: 'api_key',
  service: 'Gateway',
  headerName: 'X-API-Key',
  headerPrefix: '', // Omit standard "Bearer " prefix
}
```

### URL Query Parameters

Some services require API keys in the URL query string rather than HTTP headers (e.g., `?key=...`). Set `queryParam`:

```ts
auth: {
  slot: 'geocoding',
  type: 'api_key',
  service: 'MappingService',
  queryParam: 'key', // Appends ?key=<token> to request URL
}
```

When `queryParam` is set, Theorem sends the key exclusively in the query string and emits no authorization headers. `registerTool` rejects configurations that declare both `queryParam` and header settings.

---

## Unauthenticated Policies (`onUnauthenticated`)

The `onUnauthenticated` policy dictates what happens when a credential slot is empty or expired:

| Policy | Behavior | Typical Use Case |
| :--- | :--- | :--- |
| **`'gate'`** (Default) | Turn halts with `stop: { kind: 'gate' }` and `kind: 'auth'`. | Standard user sign-in flows. |
| **`'report_to_model'`** | Turn continues; model is informed that the user is not signed in. | Optional tools where the agent can adapt its plan. |
| **`'fail'`** | Call fails immediately with `not_authorized`. | Machine-to-machine keys held by server operators. |

---

## Supplying Credentials (`ToolCredentialSource`)

The host supplies credentials per turn or per session using a `ToolCredentialSource`. The kernel reads slots on demand when a tool runs:

```ts
import { runTurn, type ToolCredentialSource, type ToolCredential } from '@theoremjs/agents';

const userCredentials: ToolCredentialSource = {
  get: async (slot: string): Promise<ToolCredential | undefined> => {
    return await secureVault.load(currentUserId, slot);
  },
  set: async (slot: string, credential: ToolCredential): Promise<void> => {
    await secureVault.save(currentUserId, slot, credential);
  },
  clientSecret: async (clientId: string): Promise<string | undefined> => {
    return process.env.OAUTH_CLIENT_SECRET;
  },
};

const events = runTurn({
  profile: 'harbor.desk',
  input: { text: 'List my shipments.' },
  credentials: userCredentials,
});
```

For test environments and local development, initialize an in-memory store using `memoryCredentialSource({ slot: credential })`.

---

## Interactive Key & Token Sign-In

When an `api_key` or `bearer` tool halts on an auth gate, the frontend collects the secret from the user. The backend builds and stores the typed credential using `credentialForSignInGate()`:

```ts
import { credentialForSignInGate, invokeTool } from '@theoremjs/agents';

// 1. Build typed credential from user input
const { slot, credential } = credentialForSignInGate(gateEvent.tool.gate.auth, userSecretInput);
await userCredentials.set(slot, credential);

// 2. Resume the held call
const resumeEvents = invokeTool({
  profile: 'harbor.desk',
  name: 'list_user_shipments',
  snapshot: gateEvent.tools,
  resume: { granted: true, signIn: true },
  credentials: userCredentials,
  input: {},
});
```

Because typed secrets are validated server-side, client code cannot tamper with the credential kind or target slot.

---

## Scope Protection & Network Safety

Theorem enforces strict boundaries around tool authentication:

* **Scope Boundaries**: If a service attempts to grant or demand scopes not declared in `auth.scopes`, Theorem emits an `auth_scope_refused` event and rejects the token.
* **SSRF Prevention**: All authentication handshakes and tool requests are evaluated against network guardrails. Requests to private networks, loopback addresses, or cloud metadata endpoints (`169.254.169.254`) are refused unless explicitly permitted via `resolveHost`.
* **Redirect Protection**: Authenticated requests and OAuth code exchanges never follow redirects that leave the resource server's origin.

---

## OAuth PKCE Sign-In

For services requiring OAuth 2.0 with PKCE (e.g., GitHub, Slack, Google), Theorem provides stateless authorization helpers and automatic token refresh:

* See the dedicated guide: **[OAuth PKCE Flow](3-3-1-oauth-pkce.md)** for complete implementation patterns, callback exchanges, and session-binding security.

---

## Authenticated Function Tools (`signedInFetch`)

For custom `function` tools that declare `auth`, Theorem provides `ctx.signedInFetch`. The handler never touches the raw secret:

```ts
registerTool({
  type: 'function',
  name: 'sync_user_vault',
  // ... access, loadTier, input, output
  auth: { slot: 'user_vault', type: 'bearer', service: 'UserVault' },

  handler: async (input, ctx) => {
    // signedInFetch injects Authorization header exclusively to the service origin
    const response = await ctx.signedInFetch(`https://vault.example.com/${input.path}`, {
      method: 'POST',
    });
    return { synced: response.ok };
  },
});
```

---

## Related Guides

* **[OAuth PKCE Flow](3-3-1-oauth-pkce.md)**: Managing PKCE flows, encrypted state, and automatic token refresh.
* **[Tools & Execution Pipeline](3-1-tools.md)**: Declaring function, HTTP, and MCP tools.
* **[Tool Permissions & Gates](3-2-tool-gates.md)**: Handling permission gates and `invokeTool()` resumption.
* **[Network Safety & Guardrails](4-4-network-safety.md)**: Restricting outbound destination domains and IP ranges.
