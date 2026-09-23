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
