import type { IconName } from '@astryxdesign/core/Icon';
import { type DefinedTheme, defineTheme, Theme, ThemeContext } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import {
	type Icon as TablerIcon,
	IconAlertTriangle,
	IconArrowDown,
	IconArrowsSort,
	IconArrowUp,
	IconCalendar,
	IconCheck,
	IconChecks,
	IconChevronDown,
	IconChevronLeft,
	IconChevronRight,
	IconChevronsLeft,
	IconChevronsRight,
	IconCircleCheck,
	IconCircleX,
	IconClock,
	IconColumns,
	IconCopy,
	IconDots,
	IconExternalLink,
	IconEyeOff,
	IconFilter,
	IconInfoCircle,
	IconMenu2,
	IconMicrophone,
	IconPlayerStopFilled,
	IconSearch,
	IconTool,
	IconX,
} from '@tabler/icons-react';
import { type ReactNode, use } from 'react';

const TABLER_BY_NAME: Record<IconName, TablerIcon> = {
	close: IconX,
	chevronDown: IconChevronDown,
	chevronLeft: IconChevronLeft,
	chevronRight: IconChevronRight,
	chevronsLeft: IconChevronsLeft,
	chevronsRight: IconChevronsRight,
	check: IconCheck,
	success: IconCircleCheck,
	error: IconCircleX,
	warning: IconAlertTriangle,
	info: IconInfoCircle,
	calendar: IconCalendar,
	clock: IconClock,
	externalLink: IconExternalLink,
	menu: IconMenu2,
	moreHorizontal: IconDots,
	search: IconSearch,
	arrowUp: IconArrowUp,
	arrowDown: IconArrowDown,
	arrowsUpDown: IconArrowsSort,
	funnel: IconFilter,
	eyeSlash: IconEyeOff,
	viewColumns: IconColumns,
	copy: IconCopy,
	checkDouble: IconChecks,
	wrench: IconTool,
	stop: IconPlayerStopFilled,
	microphone: IconMicrophone,
};

/** Astryx semantic icon registry drawn from Tabler (replaces neutral's lucide set). */
export const tablerIcons = Object.fromEntries(
	Object.entries(TABLER_BY_NAME).map(([name, Glyph]) => [
		name,
		<Glyph key={name} size="1em" stroke={1.75} aria-hidden />,
	]),
) as Record<IconName, ReactNode>;

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

export type TheoremThemeProviderProps = {
	/** Force a theme. Omit to inherit the host's `<Theme>`, or fall back to {@link theoremTheme}. */
	theme?: DefinedTheme;
	mode?: 'system' | 'light' | 'dark';
	children: ReactNode;
};

/** Wraps children in the Theorem theme unless the host already provides an Astryx theme. */
export function TheoremThemeProvider({ theme, mode = 'system', children }: TheoremThemeProviderProps) {
	// Ask the React tree, not `useThemeName()`: outside a Theme that falls back to
	// the <html> attribute our own Theme sets, which would unmount it in a loop.
	const hostTheme = use(ThemeContext);
	if (hostTheme != null && !theme) return <>{children}</>;
	return (
		<Theme theme={theme ?? theoremTheme} mode={mode}>
			{children}
		</Theme>
	);
}
