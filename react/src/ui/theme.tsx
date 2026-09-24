import { type DefinedTheme, Theme, ThemeContext } from '@astryxdesign/core/theme';
import { type ReactNode, use } from 'react';
import { theoremTheme } from './built/theorem';

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
