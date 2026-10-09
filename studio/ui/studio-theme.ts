import { defineTheme } from '@astryxdesign/core/theme';
import { tablerIcons } from '../../react/src/ui/icons.ts';
import { theoremTheme } from '../../react/src/ui/theorem-theme.ts';

/**
 * The look of the studio and the shell it sits in: Theorem's theme on a black base, with the page
 * drawn as a rounded panel inset from the viewport edges beside the rail. The website's theme
 * extends this one, so the studio looks the same on the website and on its own.
 * `npm --prefix studio run theme:build` compiles it to `built/`, which is what a page imports.
 */
export const studioTheme = defineTheme({
	name: 'theorem-studio',
	extends: theoremTheme,
	// Restated so the built module carries the registry; a build keeps only the icons its source imports.
	icons: tablerIcons,
	tokens: {
		// Behind the rail and the page panel, in both modes.
		'--color-background-body': '#000000',
		// The type ladder, a step above Astryx's: body is 16px, not 14px. Text and heading types read these.
		'--font-size-xs': '0.6875rem',
		'--font-size-sm': '0.875rem',
		'--font-size-base': '1rem',
		'--font-size-lg': '1.1875rem',
		'--font-size-xl': '1.375rem',
		'--font-size-2xl': '1.625rem',
		'--font-size-3xl': '2rem',
		'--font-size-4xl': '2.375rem',
		'--font-size-5xl': '2.75rem',
	},
	components: {
		// why: Astryx fixes every toast at 400px, so a short message sits in a wide empty box. Let it
		// size to its text; the viewport lines toasts up on the end edge, so the toast stays there.
		toast: {
			base: {
				width: 'fit-content',
				minWidth: 'min(240px, 100%)',
				justifySelf: 'end',
			},
		},
		// AppShell's elevated variant only rounds the panel when a TopNav is
		// present; with the rail alone, inset top, bottom, and the trailing edge.
		// The leading edge stays flush to the rail. The matching start inset
		// is added in studio-shell.css only below the drawer breakpoint.
		'layout-content': {
			base: {
				':where([role="main"])': {
					height: 'calc(100% - 2 * var(--spacing-4))',
					marginBlock: 'var(--spacing-4)',
					marginInlineEnd: 'var(--spacing-4)',
					borderRadius: 'var(--radius-page)',
				},
			},
		},
		// A clear gap between rail groups; Astryx's own section spacing reads as one list.
		'side-nav-section': {
			base: {
				paddingBlock: 'var(--spacing-3)',
			},
		},
		// Neutral's selected fill (accent-muted) matches the dark page surface, so a selected row
		// vanishes; the pressed overlay reads on any surface in either mode.
		'tree-list-item': {
			'selected:selected': {
				backgroundColor: 'var(--color-overlay-pressed)',
			},
		},
		// A name longer than its column (a tool's snake_case, which never wraps) ends in an ellipsis
		// rather than running under the column's edge.
		'tree-list-item-label': {
			base: {
				minWidth: '0',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
		},
		// Same fill and corners as the elevated shell's page panel (surface + radius-page, no border),
		// for pages that sit on the base and draw their own panels.
		section: {
			'variant:raised': {
				backgroundColor: 'var(--color-background-surface)',
				borderRadius: 'var(--radius-page)',
				// Content scrolling past the rounded corners would otherwise draw outside them.
				overflow: 'clip',
			},
		},
		// Inline code in prose reads as part of its sentence: the sentence's own typeface, at its size
		// and weight. Astryx sets it in the code typeface.
		code: {
			base: {
				fontFamily: 'inherit',
			},
		},
	},
});
