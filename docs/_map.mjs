/** @type {import('../scripts/docs-truth/graph.mjs').DocsTruthGraph} */
const graph = {
  schema: 'theorem.docs-truth/v1',
  structural_sections: ['Export', 'Ownership', 'Exported API'],
  min_evidence_supports: 2,
  min_doc_lines: {
    default: 70,
    'README.md': 280,
    'docs/DOCS_TRUTH.md': 90,
    'docs/contracts/kernel.md': 280,
    'docs/contracts/providers.md': 160,
    'docs/contracts/guardrails.md': 110,
    'docs/contracts/studio.md': 50,
  },
  production_roots: ['mod.ts', 'package.json', 'src/', 'scripts/docs-truth/'],
  validation_roots: ['tests/', 'scripts/docs-truth/'],
  ignore: ['npm/', 'node_modules/', 'coverage/', 'cov_profile/', 'tmp/', '.fallow/'],
  entries: {
    package: {
      export: '.',
      doc: 'README.md',
      owns: ['mod.ts', 'package.json'],
      watches: [
        {
          path: 'src/kernel/mod.ts',
          reason: 'README public entrypoints table tracks kernel surface',
          sections: ['Public Entrypoints'],
        },
        {
          path: 'src/providers/mod.ts',
          reason: 'README documents registered providers and adapter boundaries',
          sections: ['Public Entrypoints', 'Package Boundary'],
        },
        {
          path: 'src/interface/mod.ts',
          reason: 'README public entrypoints table tracks headless interface surface',
          sections: ['Public Entrypoints'],
        },
      ],
      validates: ['tests/kernel/theorem.test.ts', 'scripts/docs-truth/graph.test.mjs'],
      required_sections: ['Architecture', 'Public Entrypoints', 'Package Boundary'],
    },

    'react-package': {
      export: '_internal/react-package',
      doc: 'react/README.md',
      owns: ['react/src/', 'react/package.json'],
      watches: [
        {
          path: 'src/kernel/protocols/provider.ts',
          reason: 'React setup registers provider definitions and host options',
          sections: ['Quick start'],
        },
        {
          path: 'src/interface/session.ts',
          reason: 'Chat snapshots retain portable history and provider state',
          sections: ['Chat'],
        },
        {
          path: 'src/kernel/provider-live.ts',
          reason: 'Live reconnects depend on the registered session boundary',
          sections: ['Other profile types'],
        },
      ],
      validates: ['tests/react/', 'scripts/docs-truth/graph.test.mjs'],
    },

    'studio-package': {
      export: '_internal/studio-package',
      doc: 'studio/README.md',
      owns: ['studio/'],
      validates: ['tests/studio/', 'studio/tests/'],
    },

    'studio-contract': {
      export: '_internal/studio-contract',
      doc: 'docs/contracts/studio.md',
      owns: [],
      watches: [
        {
          path: 'studio/runtime.ts',
          reason:
            'The contract states how studio runs keep vaults, sessions, and operation records',
          sections: ['Runs and sessions'],
        },
        {
          path: 'studio/runtime-scope.ts',
          reason:
            'The contract states how studio runs keep vaults, sessions, and operation records',
          sections: ['Runs and sessions'],
        },
        {
          path: 'studio/browser-execution.ts',
          reason:
            'The contract states how studio runs keep vaults, sessions, and operation records',
          sections: ['Runs and sessions'],
        },
        {
          path: 'studio/browser-transport.ts',
          reason:
            'The contract states how studio runs keep vaults, sessions, and operation records',
          sections: ['Runs and sessions'],
        },
        {
          path: 'studio/live-session-bridge.ts',
          reason:
            'The contract states how studio runs keep vaults, sessions, and operation records',
          sections: ['Runs and sessions'],
        },
        {
          path: 'scripts/build-npm-studio.ts',
          reason:
            'The contract states what the studio package ships and what stays out of the kernel',
          sections: ['Package boundary'],
        },
        {
          path: 'scripts/verify-publish-bundle.ts',
          reason:
            'The contract states what the studio package ships and what stays out of the kernel',
          sections: ['Package boundary'],
        },
      ],
      validates: ['tests/studio/'],
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
      required_sections: [
        'Export',
        'Ownership',
        'Rules',
        'Package vs repo documentation',
        'Production roots',
        'CI and hooks',
      ],
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
            'scripts/build-npm-react.ts',
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
          paths: ['src/guardrails/labels.ts', 'src/kernel/stop.ts', 'studio/'],
          sections: ['Facts and policy'],
        },
        {
          paths: ['src/kernel/engine/compaction.ts', 'src/kernel/engine/token-estimate.ts'],
          sections: ['Compaction'],
        },
        {
          paths: ['src/kernel/stop.ts'],
          sections: ['Stop and resume'],
        },
        {
          paths: ['src/kernel/engine/usage.ts', 'src/kernel/engine/runner/usage.ts'],
          sections: ['Stream events'],
        },
        {
          paths: ['src/kernel/engine/runner/**'],
          sections: ['Turn lifecycle'],
        },
        {
          paths: [
            'src/kernel/registry/profiles.ts',
            'src/kernel/registry/resolve.ts',
            'src/kernel/schema.ts',
          ],
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
      watches: [
        {
          path: 'src/kernel/registry/vault.ts',
          reason: 'Key slot resolution feeds every provider',
          sections: ['Key vault (provider-neutral)', 'Registered providers'],
        },
        {
          path: 'src/kernel/protocols/**',
          reason: 'Protocols, providers, and bindings are defined and run by the kernel',
          sections: [
            'Registered providers',
            'Model bindings',
            'Protocol contract',
            'Saved provider state',
          ],
        },
      ],
      validates: [
        'tests/kernel/protocols/protocols.test.ts',
        'tests/kernel/protocols/checkpoints.test.ts',
        'tests/providers/providers.test.ts',
        'tests/providers/create-provider.test.ts',
        'tests/providers/registered-openrouter.test.ts',
        'tests/providers/embedding-protocol.test.ts',
        'tests/providers/gemini/interactions-protocol.test.ts',
        'tests/providers/gemini/live-protocol.test.ts',
        'tests/providers/google/interactions/framing.test.ts',
        'tests/providers/google/interactions/stream.test.ts',
        'tests/providers/google/interactions/speech.test.ts',
        'tests/providers/google/live/framing.test.ts',
        'tests/providers/google/live/stream.test.ts',
        'tests/providers/open-ai/protocol.test.ts',
        'tests/providers/openrouter/protocol.test.ts',
        'tests/providers/openrouter/images-protocol.test.ts',
        'tests/providers/openrouter/openai/compat.test.ts',
        'tests/providers/openrouter/openai/usage.test.ts',
        'tests/providers/system-one/protocol.test.ts',
        'tests/providers/shared/pcm.test.ts',
        'tests/providers/shared/sse.test.ts',
        'tests/providers/shared/upstream-tape.test.ts',
        'tests/providers/shared/upstream-tap.test.ts',
      ],
      required_sections: [
        'Export',
        'Ownership',
        'Package boundary',
        'Registered providers',
        'Model bindings',
        'Protocol contract',
        'OpenRouter',
        'Google Interactions',
        'Google Live',
        'Local provider',
        'Speech roles',
        'Key vault (provider-neutral)',
        'Saved provider state',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/providers/mod.ts', 'src/providers/*/provider.ts'],
          sections: ['Registered providers', 'Package boundary'],
        },
        {
          paths: [
            'src/providers/openrouter/protocol.ts',
            'src/providers/openrouter/images-protocol.ts',
            'src/providers/openrouter/openai/usage.ts',
            'src/providers/system-one/protocol.ts',
          ],
          sections: ['OpenRouter'],
        },
        {
          paths: ['src/providers/local/provider.ts', 'src/providers/open-ai/protocol.ts'],
          sections: ['Local provider'],
        },
        {
          paths: [
            'src/providers/gemini/interactions-protocol.ts',
            'src/providers/google/interactions/framing.ts',
            'src/providers/google/interactions/stream.ts',
          ],
          sections: ['Google Interactions'],
        },
        {
          paths: [
            'src/providers/gemini/live-protocol.ts',
            'src/providers/google/live/framing.ts',
            'src/providers/google/live/stream.ts',
            'src/kernel/engine/session/mod.ts',
          ],
          sections: ['Google Live'],
        },
        {
          paths: ['src/providers/*/embedding-protocol.ts', 'src/kernel/engine/embedding.ts'],
          sections: ['Embedding protocols'],
        },
      ],
    },

    guardrails: {
      export: './guardrails',
      doc: 'docs/contracts/guardrails.md',
      owns: ['src/guardrails/'],
      owns_except: [
        'src/guardrails/testing.ts',
        'src/guardrails/compile-egress.ts',
        'src/guardrails/egress-compiler.ts',
      ],
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
        'Labels',
        'Egress',
        'Exported API',
      ],
      section_triggers: [
        { paths: ['src/guardrails/error.ts'], sections: ['Public errors'] },
        { paths: ['src/guardrails/labels.ts'], sections: ['Labels'] },
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
        {
          paths: ['src/guardrails/sanitize.ts', 'src/guardrails/injection.ts'],
          sections: ['Sanitization'],
        },
        {
          paths: ['src/guardrails/injection.ts'],
          sections: ['Injection categories (non-exhaustive)'],
        },
        {
          paths: [
            'src/guardrails/sensitive.ts',
            'src/guardrails/sensitive-groups.ts',
            'src/guardrails/credential-scan.ts',
            'src/guardrails/credential-rules.ts',
          ],
          sections: ['Sensitive data'],
        },
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
        { paths: ['src/guardrails/host-patterns.ts'], sections: ['Whose patterns'] },
      ],
    },

    'guardrails-compile': {
      export: './guardrails/compile',
      doc: 'docs/contracts/guardrails.md',
      owns: ['src/guardrails/compile-egress.ts', 'src/guardrails/egress-compiler.ts'],
      validates: [
        'tests/guardrails/host-pattern-holds.test.ts',
        'tests/guardrails/egress-stream.test.ts',
      ],
      required_sections: ['Export', 'Whose patterns', 'Exported API'],
      section_triggers: [
        {
          paths: ['src/guardrails/compile-egress.ts', 'src/guardrails/egress-compiler.ts'],
          sections: ['Whose patterns'],
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
      required_sections: ['Export', 'Adversarial testing', 'Exported API'],
      section_triggers: [
        { paths: ['src/guardrails/testing.ts'], sections: ['Adversarial testing'] },
      ],
    },

    observability: {
      export: './observability',
      doc: 'docs/contracts/observability.md',
      owns: ['src/observability/'],
      owns_except: [
        'src/observability/jsonl.ts',
        'src/observability/openinference.ts',
        'src/observability/phoenix.ts',
      ],
      validates: ['tests/observability/'],
      required_sections: [
        'Export',
        'Ownership',
        'Profile observability',
        'Trace destinations',
        'Trace sinks',
        'Sensitive storage',
        'Trace records',
        'OTLP export',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/observability/types.ts', 'src/observability/policy.ts'],
          sections: ['Profile observability'],
        },
        { paths: ['src/observability/destinations.ts'], sections: ['Trace destinations'] },
        { paths: ['src/observability/trace.ts'], sections: ['Trace sinks'] },
        {
          paths: ['src/observability/trace-record.ts'],
          sections: ['Trace records', 'Sensitive storage'],
        },
        { paths: ['src/observability/trace-span.ts'], sections: ['Trace records'] },
        { paths: ['src/observability/otlp.ts'], sections: ['OTLP export'] },
      ],
    },

    'observability-jsonl': {
      export: './observability/jsonl',
      doc: 'docs/contracts/observability.md',
      owns: ['src/observability/jsonl.ts'],
      validates: ['tests/observability/jsonl.test.ts'],
      required_sections: ['Export', 'JSONL sink', 'Exported API'],
      section_triggers: [{ paths: ['src/observability/jsonl.ts'], sections: ['JSONL sink'] }],
    },

    'observability-openinference': {
      export: './observability/openinference',
      doc: 'docs/contracts/observability.md',
      owns: ['src/observability/openinference.ts'],
      validates: ['tests/observability/openinference.test.ts'],
      required_sections: ['Export', 'OpenInference attributes', 'Exported API'],
      section_triggers: [
        { paths: ['src/observability/openinference.ts'], sections: ['OpenInference attributes'] },
      ],
    },

    'observability-phoenix': {
      export: './observability/phoenix',
      doc: 'docs/contracts/observability.md',
      owns: ['src/observability/phoenix.ts'],
      validates: ['tests/observability/phoenix.test.ts'],
      required_sections: ['Export', 'Phoenix annotations', 'Exported API'],
      section_triggers: [
        { paths: ['src/observability/phoenix.ts'], sections: ['Phoenix annotations'] },
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
      required_sections: ['Export', 'Ownership', 'Commands', 'Matrix and fixtures', 'Exported API'],
      section_triggers: [
        { paths: ['src/cli/commands/'], sections: ['Commands'] },
        { paths: ['src/cli/event-log.ts'], sections: ['Commands'] },
        { paths: ['src/cli/matrix/'], sections: ['Matrix and fixtures'] },
      ],
    },

    presets: {
      export: './presets',
      doc: 'docs/contracts/presets.md',
      owns: [
        'src/presets/mod.ts',
        'src/presets/facts.ts',
        'src/presets/local.ts',
        'src/presets/openrouter.ts',
        'src/presets/openrouter-facts.ts',
        'src/presets/typesafe.ts',
      ],
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
      owns: [
        'src/presets/google.ts',
        'src/presets/google-limits.ts',
        'src/presets/google/media-tokens.ts',
      ],
      watches: [
        {
          path: 'src/presets/google/speech-voices.ts',
          reason: 'Speech voice vocabulary consumed by the Google preset pack',
          sections: ['Vocabularies', 'Exported API'],
        },
      ],
      validates: ['tests/kernel/theorem.test.ts'],
      required_sections: ['Export', 'Ownership', 'Builtins', 'Vocabularies', 'Exported API'],
    },

    'presets-google-speech-voices': {
      export: './presets/google/speech-voices',
      doc: 'docs/contracts/presets-google.md',
      owns: ['src/presets/google/speech-voices.ts'],
      validates: ['tests/kernel/theorem.test.ts'],
      required_sections: ['Export', 'Ownership', 'Vocabularies', 'Exported API'],
    },

    interface: {
      export: './interface',
      doc: 'docs/contracts/kernel.md',
      owns: ['src/interface/'],
      validates: ['tests/interface/'],
      required_sections: ['Headless interface', 'Exported API'],
      section_triggers: [
        { paths: ['src/interface/'], sections: ['Headless interface', 'Exported API'] },
      ],
    },

    surface: {
      export: './surface',
      doc: 'docs/contracts/surface.md',
      owns: ['src/surface/'],
      validates: ['tests/surface/'],
      required_sections: ['Export', 'Ownership', 'Protocol', 'Secrets', 'Exported API'],
      section_triggers: [
        { paths: ['src/surface/runtime.ts'], sections: ['Protocol'] },
        { paths: ['src/surface/formats.ts'], sections: ['Secrets'] },
        { paths: ['src/surface/mod.ts', 'src/surface/tools.ts'], sections: ['Exported API'] },
      ],
    },

    schema: {
      export: './schema',
      doc: 'docs/contracts/kernel.md',
      owns: ['src/kernel/schema.ts'],
      validates: ['tests/kernel/schema.test.ts'],
      required_sections: ['Export', 'Ownership', 'Profiles', 'Exported API'],
    },

    evals: {
      export: './evals',
      doc: 'docs/contracts/evals.md',
      owns: ['src/evals/'],
      validates: ['tests/evals/'],
      required_sections: [
        'Export',
        'Ownership',
        'Suites and cases',
        'Trials',
        'Graders',
        'Judges',
        'Result records',
        'Running a suite',
        'Exported API',
      ],
      section_triggers: [
        {
          paths: ['src/evals/types.ts', 'src/evals/attachments.ts'],
          sections: ['Suites and cases'],
        },
        { paths: ['src/evals/trial.ts'], sections: ['Trials'] },
        { paths: ['src/evals/graders/'], sections: ['Graders'] },
        {
          paths: [
            'src/evals/graders/judge.ts',
            'src/evals/graders/media.ts',
            'src/evals/graders/transcript.ts',
            'src/evals/rubrics/',
          ],
          sections: ['Judges'],
        },
        { paths: ['src/evals/record.ts', 'src/evals/verdict.ts'], sections: ['Result records'] },
        {
          paths: [
            'src/evals/run.ts',
            'src/evals/suite.ts',
            'src/evals/summary.ts',
            'src/evals/breakdown.ts',
          ],
          sections: ['Running a suite'],
        },
      ],
    },
  },
};

export default graph;
