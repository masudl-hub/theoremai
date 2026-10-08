import { assertEquals } from '@std/assert';
import { followGenerationDefaults } from '../../react/src/client/generation-selection.ts';
import type { ComposerProfileInterface } from '../../src/interface/mod.ts';
import {
  compileStudio,
  createExampleDraft,
  type StudioDraft,
  studioInterface,
} from '../../studio/mod.ts';

/**
 * The example draft's interface, with fast as its default model: models fast (efforts fast, deep),
 * smart (normal, deep), open.
 */
function iface(edit: (draft: StudioDraft) => StudioDraft = (draft) => draft) {
  const example = createExampleDraft();
  const result = compileStudio(
    edit({ ...example, models: { ...example.models, defaultModel: 'fast' } }),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  const described = studioInterface(result);
  if (described.type === 'live') throw new Error('expected a composer profile');
  return described satisfies ComposerProfileInterface;
}

function binding(
  modelId: string,
  change: Partial<StudioDraft['modelBindings'][number]>,
): (draft: StudioDraft) => StudioDraft {
  return (draft) => ({
    ...draft,
    modelBindings: draft.modelBindings.map((entry) =>
      entry.modelId === modelId ? { ...entry, ...change } : entry,
    ),
  });
}

Deno.test('the first interface seeds its default model and effort', () => {
  assertEquals(followGenerationDefaults(iface(), {}, undefined), { model: 'fast', effort: 'fast' });
});

Deno.test('a pick on the old default effort follows the new default', () => {
  const next = iface(binding('fast', { defaultEffort: 'deep' }));
  assertEquals(followGenerationDefaults(next, { model: 'fast', effort: 'fast' }, iface()), {
    model: 'fast',
    effort: 'deep',
  });
});

Deno.test('a pick on the old default model follows the new one, with its default effort', () => {
  const next = iface((draft) => ({ ...draft, models: { ...draft.models, defaultModel: 'smart' } }));
  assertEquals(followGenerationDefaults(next, { model: 'fast', effort: 'deep' }, iface()), {
    model: 'smart',
    effort: 'normal',
  });
});

Deno.test('a pick off the defaults is kept when they change', () => {
  const next = iface((draft) => ({
    ...binding('smart', { defaultEffort: 'deep' })(draft),
    models: { ...draft.models, defaultModel: 'open' },
  }));
  assertEquals(followGenerationDefaults(next, { model: 'smart', effort: 'deep' }, iface()), {
    model: 'smart',
    effort: 'deep',
  });
});

Deno.test('a picked model follows its own default effort when that changes', () => {
  const next = iface(binding('smart', { defaultEffort: 'deep' }));
  assertEquals(followGenerationDefaults(next, { model: 'smart', effort: 'normal' }, iface()), {
    model: 'smart',
    effort: 'deep',
  });
});

Deno.test('a pick the profile no longer has falls back to the defaults', () => {
  const renamed = iface(
    binding('fast', {
      efforts: [
        { alias: 'fast', level: 'minimal' },
        { alias: 'hard', level: 'high' },
      ],
    }),
  );
  assertEquals(followGenerationDefaults(renamed, { model: 'fast', effort: 'deep' }, iface()), {
    model: 'fast',
    effort: 'fast',
  });
  const removed = iface((draft) => ({
    ...draft,
    modelBindings: draft.modelBindings.filter((entry) => entry.modelId !== 'smart'),
  }));
  assertEquals(followGenerationDefaults(removed, { model: 'smart', effort: 'deep' }, iface()), {
    model: 'fast',
    effort: 'fast',
  });
});
