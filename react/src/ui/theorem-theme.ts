import { type DefinedTheme, defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { tablerIcons } from './icons.ts';

/**
 * Default Theorem look: Astryx neutral (its radius scale, palettes, type)
 * with Tabler icons. Extend it like any Astryx theme:
 *
 * ```ts
 * defineTheme({ name: 'mine', extends: theoremTheme, tokens: { '--color-accent': '#5b5bd6' } })
 * ```
 */
export const theoremTheme: DefinedTheme = defineTheme({
  name: 'theorem',
  extends: neutralTheme,
  icons: tablerIcons,
  components: {
    // why: Media keeps a margin from the viewport edges, over a lighter scrim than
    // Astryx's shared --color-overlay (dialogs keep theirs).
    lightbox: {
      base: {
        padding: 'var(--spacing-12)',
        '::backdrop': { backgroundColor: 'light-dark(#00000059, #00000099)' },
      },
    },
    // why: Collapsible shows and hides without motion; ease its height with the
    // same --duration-medium / --ease-standard as ChatToolCalls and the
    // composer drawer. Closed = the trigger before it reads aria-expanded="false".
    'collapsible-content': {
      base: {
        display: 'block',
        overflow: 'clip',
        interpolateSize: 'allow-keywords',
        transition:
          'height var(--duration-medium) var(--ease-standard), padding-top var(--duration-medium) var(--ease-standard), content-visibility var(--duration-medium) allow-discrete',
        ':where([aria-expanded="false"] + *)': {
          height: '0',
          paddingTop: '0',
          contentVisibility: 'hidden',
        },
      },
    },
    // why: A source's favicon sits bare beside its title, without the ring
    // Astryx draws around a citation icon. Nested keys must open with a
    // pseudo-class, so `:where(*)` (the citation itself) leads the child rules.
    citation: {
      base: {
        ':where(*) > [aria-hidden="true"]': {
          backgroundColor: 'transparent',
          borderWidth: '0',
          borderRadius: '0',
        },
        ':where(*) > [aria-hidden="true"] > img': { width: '100%', height: '100%' },
      },
    },
    // why: A call row's name is code type and its target or error note is body type;
    // centered, their different metrics sit their text on different lines.
    // Share a baseline instead (the status icon and chevron stay centered).
    'chat-tool-calls': {
      base: {
        ':where(*) [role="button"][aria-expanded] > span:not(:first-child):not(:has(svg))': {
          alignSelf: 'baseline',
        },
      },
    },
    // why: A card that waits on the user sits in the transcript as a turn of its
    // own, so it takes the surface of the user's message bubble.
    card: {
      'variant:bubble': {
        backgroundColor: 'var(--color-neutral)',
        borderRadius: 'var(--radius-chat)',
        paddingBlock: 'var(--spacing-3)',
        paddingInline: 'var(--spacing-4)',
      },
    },
    // why: A code block sits among cards and panels, so it takes a card's corner
    // (--radius-container) rather than the smaller element radius Astryx gives it.
    'code-block': {
      'container:card': { borderRadius: 'var(--radius-container)' },
    },
    'layout-panel': {
      base: {
        ':where([role="complementary"])': {
          transition: 'width var(--duration-medium) var(--ease-standard)',
        },
        // why: While its ResizeHandle drags, follow the pointer. An end panel's
        // handle is the sibling before it; a start panel's handle is the sibling after it.
        ':where([data-resizing] + [role="complementary"], [role="complementary"]:has(+ [data-resizing]))':
          {
            transition: 'none',
          },
      },
    },
  },
  adaptations: {
    rules: [
      {
        when: { motion: 'reduce' },
        value: {
          components: {
            'collapsible-content': { base: { transition: 'none' } },
            'layout-panel': { base: { ':where([role="complementary"])': { transition: 'none' } } },
          },
        },
      },
    ],
  },
});
