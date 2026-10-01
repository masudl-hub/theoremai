/**
 * Astryx UI for Theorem — `<TheoremChat />` plus the pieces it is built from,
 * `<TheoremDecision />` for decision profiles, and `<TheoremHost />` for host
 * profiles.
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

export type { InkWaveStatus } from '../client/ink-waveform.ts';
export { InkWaveform, type InkWaveformProps } from '../components/InkWaveform.tsx';
export { ChatComposerBar, type ChatComposerBarProps } from './ChatComposerBar.tsx';
export { ChatTranscript, type ChatTranscriptProps } from './ChatTranscript.tsx';
export { TheoremDecisionAnswers, type TheoremDecisionAnswersProps } from './DecisionAnswers.tsx';
export { TheoremDecision, type TheoremDecisionProps } from './TheoremDecision.tsx';
export { TheoremHost, type TheoremHostProps } from './TheoremHost.tsx';
export {
	DEFAULT_CHAT_MAX_WIDTH,
	TheoremChat,
	type TheoremChatHandle,
	type TheoremChatProps,
} from './TheoremChat.tsx';
export {
	ApprovalCard,
	type ApprovalCardProps,
	AuthChallengeCard,
	type AuthChallengeCardProps,
	type ToolDecision,
} from './ToolGateCard.tsx';
export { ToolResult } from './ToolResult.tsx';
export { tablerIcons, theoremTheme } from './built/theorem.js';
export { useDisclosureMotion } from './disclosure-motion.ts';
export {
	composerDrawerLabel,
	type LabelText,
	liveStateLabel,
	THEOREM_UI_CATALOG,
	type TheoremLabelKey,
	type TheoremLabelOverrides,
	type TheoremLabels,
	type TheoremLabelValues,
	type TheoremUiCatalog,
	voiceNoteName,
	workStatusLabel,
} from './labels.ts';
export { TheoremLabelsProvider, type TheoremLabelsProviderProps, useLabels } from './labels-provider.tsx';
export { TheoremThemeProvider, type TheoremThemeProviderProps } from './theme.tsx';
