/**
 * Astryx UI for Theorem — `<TheoremChat />` plus the pieces it is built from.
 *
 * Styling is Astryx: pass `theme` (any `defineTheme` result, e.g. one that
 * `extends: theoremTheme`) or wrap your app in your own `<Theme>`.
 *
 * @module
 */

// Astryx's documented order: reset → components → theme. The reset lives in
// `@layer reset`, so any unlayered host CSS still wins over it.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './built/theme.css';

export { ChatComposerBar, type ChatComposerBarProps } from './ChatComposerBar';
export { ChatTranscript, type ChatTranscriptProps } from './ChatTranscript';
export { DEFAULT_CHAT_MAX_WIDTH, TheoremChat, type TheoremChatProps } from './TheoremChat';
export {
	ApprovalCard,
	type ApprovalCardProps,
	AuthChallengeCard,
	type AuthChallengeCardProps,
	type ToolDecision,
} from './ToolGateCard';
export { tablerIcons, theoremTheme } from './built/theorem';
export { TheoremThemeProvider, type TheoremThemeProviderProps } from './theme';
