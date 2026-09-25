import { type DefinedTheme, defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { tablerIcons } from './icons';

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
		// Media keeps a margin from the viewport edges, over a lighter scrim than
		// Astryx's shared --color-overlay (dialogs keep theirs).
		lightbox: {
			base: {
				padding: 'var(--spacing-12)',
				'::backdrop': { backgroundColor: 'light-dark(#00000059, #00000099)' },
			},
		},
		// Collapsible shows and hides without motion; ease its height with the
		// same --duration-medium / --ease-standard as ChatToolCalls and the
		// composer drawer. Closed = the trigger before it reads aria-expanded="false".
		'collapsible-content': {
			base: {
				display: 'block',
				overflow: 'clip',
				interpolateSize: 'allow-keywords',
				transition:
					'height var(--duration-medium) var(--ease-standard), padding-top var(--duration-medium) var(--ease-standard), content-visibility var(--duration-medium) allow-discrete',
				':where([aria-expanded="false"] + *)': { height: '0', paddingTop: '0', contentVisibility: 'hidden' },
			},
		},
		// Side panels (SidePanel's LayoutPanels) slide open and closed by easing
		// their width, pushing the content over.
		'layout-panel': {
			base: {
				':where([role="complementary"])': {
					transition: 'width var(--duration-medium) var(--ease-standard)',
				},
				// While its ResizeHandle (the sibling before it) drags, follow the pointer.
				':where([data-resizing] + [role="complementary"])': {
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
