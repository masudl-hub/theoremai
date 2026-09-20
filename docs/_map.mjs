/** @type {import('../scripts/docs-truth/graph.mjs').DocsTruthGraph} */
const graph = {
  schema: 'theorem.docs-truth/v1',
  structural_sections: ['Export', 'Ownership', 'Exported API'],
  min_evidence_supports: 2,
  min_doc_lines: {
    default: 70,
    'README.md': 340,
    'docs/DOCS_TRUTH.md': 90,
    'docs/contracts/kernel.md': 280,
    'docs/contracts/providers.md': 160,
    'docs/contracts/guardrails.md': 110,
  },
  production_roots: [
    'mod.ts',
    'package.json',
    'src/',
    'scripts/docs-truth/',
  ],
  validation_roots: ['tests/', 'scripts/docs-truth/'],
  ignore: [
    'npm/',
    'node_modules/',
    'coverage/',
    'cov_profile/',
    'tmp/',
    '.fallow/',
  ],
  entries: {
    package: {
      export: '.',
      doc: 'README.md',
      owns: ['mod.ts', 'package.json'],
      watches: [
        {
          path: 'scripts/docs-truth/',
          reason: 'Docs-truth lint ships with the package repo',
          sections: ['Documentation'],
        },
        {
          path: 'docs/_map.mjs',
          reason: 'Ownership graph for docs-truth',
          sections: ['Documentation'],
        },
        {
          path: 'src/kernel/mod.ts',
          reason: 'README public entrypoints table tracks kernel surface',
          sections: ['Public Entrypoints'],
        },
        {
          path: 'src/providers/mod.ts',
          reason: 'README documents createProvider as the single door',
          sections: ['Public Entrypoints', 'Package Boundary'],
        },
        {
          path: 'src/interface/mod.ts',
          reason: 'README public entrypoints table tracks headless interface surface',
          sections: ['Public Entrypoints'],
        },
      ],
      validates: ['tests/kernel/theorem.test.ts', 'scripts/docs-truth/graph.test.mjs'],
      required_sections: [
        'Core Principles',
        'Architecture',
        'Public Entrypoints',
        'Package Boundary',
        'Documentation',
      ],
    },

    'docs-truth': {
      export: '_internal/docs-truth',
      doc: 'docs/DOCS_TRUTH.md',
      owns: ['scripts/docs-truth/'],
      watches: [
        {
          path: 'docs/_map.mjs',
          reason: 'Graph manifest consumed by the linter',
          sections: ['Ownership', 'Rules'],
        },
      ],
      validates: ['scripts/docs-truth/graph.test.mjs'],
      required_sections: ['Export', 'Ownership', 'Rules', 'Package vs repo documentation', 'Production roots', 'CI and hooks'],
      section_triggers: [
        {
          paths: [
            'scripts/docs-truth/export-drift.mjs',
            'scripts/docs-truth/copy-lint.mjs',
            'scripts/docs-truth/graph.test.mjs',
          ],
          sections: ['Rules'],
        },
        {
          paths: ['scripts/docs-truth/graph.mjs'],
          sections: ['Rules', 'Production roots'],
        },
        {
          paths: [
            'scripts/docs-truth/cli.mjs',
            'scripts/hooks/pre-commit',
            'scripts/hooks/pre-push',
            'scripts/hooks/install.mjs',
            '.github/workflows/ci.yml',
            'package.json',
          ],
          sections: ['CI and hooks'],
        },
        {
          paths: [
            'package.json',
            'deno.json',
            '.npmignore',
            'scripts/verify-publish-bundle.ts',
            'scripts/build-npm.ts',
          ],
          sections: ['Package vs repo documentation'],
        },
      ],
    },

    kernel: {
      export: './kernel',
      doc: 'docs/contracts/kernel.md',
      owns: ['src/kernel/'],
      owns_except: ['src/kernel/schema.ts'],
      validates: ['tests/kernel/'],
      required_sections: [
        'Export',
        'Ownership',
        'Facts and policy',
        'Profiles',
        'Turn lifecycle',
        'Stream events',
        'Registered tools',
        'Outputs and guardrails',
        'Compaction',
        'Stop and resume',
        'Validation',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/guardrails/lexicon.ts', 'src/kernel/stop.ts', 'playground/'],
          sections: ['Facts and policy'],
        },
        {
          paths: ['src/kernel/engine/compaction.ts', 'src/kernel/engine/history-tokens.ts'],
          sections: ['Compaction'],
        },
        {
          paths: ['src/kernel/stop.ts'],
          sections: ['Stop and resume'],
        },
        {
          paths: ['src/kernel/engine/runner/**', 'src/kernel/engine/runner.ts'],
          sections: ['Turn lifecycle'],
        },
        {
          paths: ['src/kernel/registry/profiles.ts', 'src/kernel/registry/resolve.ts', 'src/kernel/schema.ts'],
          sections: ['Profiles'],
        },
        {
          paths: ['src/kernel/tools/**', 'src/kernel/schema.ts'],
          sections: ['Registered tools'],
        },
      ],
    },

    providers: {
      export: './providers',
      doc: 'docs/contracts/providers.md',
      owns: ['src/providers/'],
      owns_except: ['src/providers/local/mod.ts', 'src/providers/google/live/mod.ts'],
      watches: [
        {
          path: 'src/kernel/registry/vault.ts',
          reason: 'Gemini vault types feed createProvider',
          sections: ['Gemini transport', 'createProvider'],
        },
      ],
      validates: [
        'tests/providers/create-provider.test.ts',
        'tests/providers/create-provider-import-isolation.test.ts',
        'tests/providers/google/keys.test.ts',
        'tests/providers/google/interactions/framing.test.ts',
        'tests/providers/google/interactions/stream.test.ts',
        'tests/providers/google/interactions/speech.test.ts',
        'tests/providers/google/live/framing.test.ts',
        'tests/providers/google/live/stream.test.ts',
        'tests/providers/local/local.test.ts',
        'tests/providers/openrouter/chat.test.ts',
        'tests/providers/openrouter/speech.test.ts',
        'tests/providers/openrouter/openai/chat-payload.test.ts',
        'tests/providers/openrouter/openai/compat.test.ts',
        'tests/providers/openrouter/openai/sdk-messages.test.ts',
        'tests/providers/shared/pcm.test.ts',
        'tests/providers/shared/sse.test.ts',
        'tests/providers/shared/upstream-tape.test.ts',
        'tests/providers/shared/upstream-tap.test.ts',
      ],
      required_sections: [
        'Export',
        'Ownership',
        'Package boundary',
        'createProvider',
        'OpenRouter',
        'Google Interactions',
        'Google Live',
        'Local provider',
        'Speech roles',
        'Gemini transport',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/providers/create-provider.ts'],
          sections: ['createProvider', 'Package boundary'],
        },
        {
          paths: [
            'src/providers/openrouter/chat.ts',
            'src/providers/openrouter/openai/chat-payload.ts',
          ],
          sections: ['OpenRouter'],
        },
        {
          paths: ['src/providers/local/local.ts', 'src/providers/local/mod.ts'],
          sections: ['Local provider'],
        },
        {
          paths: [
            'src/providers/google/interactions/framing.ts',
            'src/providers/google/interactions/stream.ts',
            'src/providers/google/interactions/mod.ts',
          ],
          sections: ['Google Interactions'],
        },
        {
          paths: [
            'src/providers/google/live/framing.ts',
            'src/providers/google/live/stream.ts',
            'src/providers/google/live/mod.ts',
          ],
          sections: ['Google Live'],
        },
        {
          paths: ['src/providers/openrouter/speech.ts'],
          sections: ['Speech roles'],
        },
      ],
    },

    'providers-local': {
      export: './providers/local',
      doc: 'docs/contracts/providers.md',
      owns: ['src/providers/local/mod.ts'],
      validates: ['tests/providers/local/local.test.ts'],
      required_sections: [
        'Export',
        'Local provider',
        'Exported API',
      ],
    },

    guardrails: {
      export: './guardrails',
      doc: 'docs/contracts/guardrails.md',
      owns: ['src/guardrails/'],
      owns_except: ['src/guardrails/testing.ts'],
      validates: ['tests/guardrails/'],
      required_sections: [
        'Export',
        'Ownership',
        'Public errors',
        'Trust levels',
        'Evaluation',
        'Tool boundary',
        'Guardrail events',
        'Network',
        'Sanitization',
        'Injection categories (non-exhaustive)',
        'Sensitive data',
        'Quota',
        'Lexicon',
        'Egress',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/guardrails/error.ts'], sections: ['Public errors'] },
        { paths: ['src/guardrails/lexicon.ts'], sections: ['Lexicon'] },
        {
          paths: ['src/guardrails/policy.ts', 'src/guardrails/types.ts'],
          sections: ['Trust levels'],
        },
        { paths: ['src/guardrails/network.ts'], sections: ['Network'] },
        { paths: ['src/guardrails/eval/**'], sections: ['Evaluation'] },
        {
          paths: ['src/guardrails/tool-result.ts'],
          sections: ['Tool boundary', 'Guardrail events'],
        },
        { paths: ['src/guardrails/sanitize.ts', 'src/guardrails/injection.ts'], sections: ['Sanitization'] },
        { paths: ['src/guardrails/injection.ts'], sections: ['Injection categories (non-exhaustive)'] },
        { paths: ['src/guardrails/sensitive.ts'], sections: ['Sensitive data'] },
        { paths: ['src/guardrails/quota.ts'], sections: ['Quota'] },
        {
          paths: [
            'src/guardrails/serialize.ts',
            'src/guardrails/egress.ts',
            'src/guardrails/progressive-yield.ts',
            'src/guardrails/live-outbound-gate.ts',
          ],
          sections: ['Egress'],
        },
      ],
    },

    'guardrails-testing': {
      export: './guardrails/testing',
      doc: 'docs/contracts/guardrails.md',
      owns: ['src/guardrails/testing.ts'],
      validates: [
        'tests/guardrails/injection.test.ts',
        'tests/cli/fuzz-guardrails.test.ts',
        'tests/cli/fuzz-canary.test.ts',
      ],
      required_sections: [
        'Export',
        'Adversarial testing',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/guardrails/testing.ts'], sections: ['Adversarial testing'] },
      ],
    },

	observability: {
      export: './observability',
      doc: 'docs/contracts/observability.md',
      owns: ['src/observability/'],
      validates: ['tests/observability/'],
      required_sections: [
        'Export',
        'Ownership',
        'Profile observability',
        'Trace destinations',
        'Trace sinks',
        'Sensitive storage',
        'Trace records',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/observability/types.ts', 'src/observability/policy.ts'], sections: ['Profile observability'] },
        { paths: ['src/observability/destinations.ts'], sections: ['Trace destinations'] },
        { paths: ['src/observability/trace.ts'], sections: ['Trace sinks'] },
        { paths: ['src/observability/trace-record.ts'], sections: ['Trace records', 'Sensitive storage'] },
      ],
    },

	host: {
      export: './host',
      doc: 'docs/contracts/host.md',
      owns: ['src/host/'],
      validates: ['tests/host/'],
      required_sections: [
        'Export',
        'Ownership',
        'HTTP replies',
        'Client-safe turn events',
        'Cutout mint trace',
        'Structured JSON preview',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/host/reply.ts'], sections: ['HTTP replies'] },
        { paths: ['src/host/client-turn.ts'], sections: ['Client-safe turn events'] },
        { paths: ['src/host/mint-trace.ts'], sections: ['Cutout mint trace'] },
        {
          paths: ['src/host/readStreamingJsonStringField.ts'],
          sections: ['Structured JSON preview'],
        },
      ],
    },

	cli: {
      export: './cli',
      doc: 'docs/contracts/cli.md',
      owns: ['src/cli/'],
      validates: ['tests/cli/'],
      required_sections: [
        'Export',
        'Ownership',
        'Commands',
        'Matrix and fixtures',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/cli/commands/'], sections: ['Commands'] },
        { paths: ['src/cli/event-log.ts'], sections: ['Commands'] },
        { paths: ['src/cli/matrix/'], sections: ['Matrix and fixtures'] },
      ],
    },

    presets: {
      export: './presets',
      doc: 'docs/contracts/presets.md',
      owns: ['src/presets/mod.ts'],
      watches: [
        {
          path: 'src/presets/google.ts',
          reason: 'Presets barrel re-exports Google pack',
          sections: ['Exported API', 'Role in the package'],
        },
      ],
      validates: ['tests/kernel/theorem.test.ts'],
      required_sections: [
        'Export',
        'Ownership',
        'Role in the package',
        'When to use',
        'Exported API',
      ],
    },

    'presets-google': {
      export: './presets/google',
      doc: 'docs/contracts/presets-google.md',
      owns: ['src/presets/google.ts'],
      watches: [
        {
          path: 'src/presets/google/speech-voices.ts',
          reason: 'Speech voice vocabulary consumed by the Google preset pack',
          sections: ['Vocabularies', 'Exported API'],
        },
      ],
      validates: ['tests/kernel/theorem.test.ts'],
      required_sections: [
        'Export',
        'Ownership',
        'Builtins',
        'Vocabularies',
        'Exported API',
      ],
    },

    'presets-google-speech-voices': {
      export: './presets/google/speech-voices',
      doc: 'docs/contracts/presets-google.md',
      owns: ['src/presets/google/speech-voices.ts'],
      validates: ['tests/kernel/theorem.test.ts'],
      required_sections: ['Export', 'Ownership', 'Vocabularies', 'Exported API'],
    },

    interface: {
      export: '_internal/interface',
      doc: 'docs/contracts/kernel.md',
      owns: ['src/interface/'],
      validates: ['tests/interface/'],
      required_sections: ['Headless interface', 'Exported API'],
      section_triggers: [
        { paths: ['src/interface/'], sections: ['Headless interface', 'Exported API'] },
      ],
    },

    schema: {
      export: './schema',
      doc: 'docs/contracts/kernel.md',
      owns: ['src/kernel/schema.ts'],
      validates: ['tests/kernel/schema.test.ts'],
      required_sections: ['Export', 'Ownership', 'Profiles', 'Exported API'],
    },

    'providers-google-live': {
      export: './providers/google/live',
      doc: 'docs/contracts/providers.md',
      owns: ['src/providers/google/live/mod.ts'],
      watches: [
        {
          path: 'src/providers/google/live/framing.ts',
          reason: 'Live wire helpers re-exported by the Google Live entry',
          sections: ['Google Live'],
        },
        {
          path: 'src/providers/google/live/stream.ts',
          reason: 'Shared Live WebSocket transport helpers for runSession',
          sections: ['Google Live'],
        },
        {
          path: 'src/providers/google/live/session.ts',
          reason: 'openGoogleLiveSession — long-lived Gemini Live socket',
          sections: ['Google Live'],
        },
        {
          path: 'src/kernel/engine/session/mod.ts',
          reason: 'runSession door — gated live session over shared resolve/tools/gates',
          sections: ['Google Live'],
        },
      ],
      validates: [
        'tests/providers/google/live/framing.test.ts',
        'tests/providers/google/live/stream.test.ts',
      ],
      required_sections: ['Export', 'Google Live', 'Exported API'],
    },
  },
};

export default graph;
