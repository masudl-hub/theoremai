/**
 * Astryx UI for Theorem — `<TheoremChat />` plus the pieces it is built from,
 * `<TheoremDecision />` for decision profiles, `<TheoremEmbedding />` for
 * embedding profiles, and `<TheoremHost />` for host profiles.
 *
 * Styling is Astryx: pass `theme` (any `defineTheme` result, e.g. one that
 * `extends: theoremTheme`) or wrap your app in your own `<Theme>`.
 *
 * @module
 */

// why: Astryx's documented order: reset → components → theme. The reset lives in
// `@layer reset`, so any unlayered host CSS still wins over it.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './built/theme.css';

export type {
  LiveCallOptions,
  PageTool,
  PageToolAnswer,
  PageTools,
} from '@theoremjs/web/client';
export type { InkWaveStatus } from '../client/ink-waveform.ts';
export { useLiveCaptionLog } from '../client/live/use-live-caption-log.ts';
export {
  InkWaveform,
  type InkWaveformProps,
  type InkWaveLevels,
} from '../components/InkWaveform.tsx';
export { useLiveRunnerModel } from '../components/live/use-live-runner-model.ts';
export { theoremTheme } from './built/theorem.js';
export {
  ChatComposerBar,
  type ChatComposerBarProps,
  EFFORT_ICON,
  type LiveComposerBarProps,
} from './ChatComposerBar.tsx';
export { ChatTranscript, type ChatTranscriptProps } from './ChatTranscript.tsx';
export {
  ConsoleFrame,
  type ConsoleFrameProps,
  type ConsolePageProps,
  RequestCard,
  ResponseColumn,
  RunBar,
  useBytes,
} from './ConsoleFrame.tsx';
export { TheoremDecisionAnswers, type TheoremDecisionAnswersProps } from './DecisionAnswers.tsx';
export { useDisclosureMotion } from './disclosure-motion.ts';
export { EmbeddingSpaceView, type EmbeddingSpaceViewProps } from './EmbeddingSpace.tsx';
export { tablerIcons } from './icons.ts';
export { LiveCaptionsPanel, type LiveCaptionsPanelProps } from './LiveCaptionsPanel.tsx';
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
export {
  TheoremLabelsProvider,
  type TheoremLabelsProviderProps,
  useLabels,
} from './labels-provider.tsx';
export { PaneFailure, PaneLoading, PaneState } from './PaneState.tsx';
export { InPlace, PaneLayout, PanePanel, Prose, RaisedPane } from './SidePanel.tsx';
export {
  DEFAULT_CHAT_MAX_WIDTH,
  TheoremChat,
  type TheoremChatHandle,
  type TheoremChatProps,
} from './TheoremChat.tsx';
export { TheoremDecision, type TheoremDecisionProps } from './TheoremDecision.tsx';
export { TheoremEmbedding, type TheoremEmbeddingProps } from './TheoremEmbedding.tsx';
export { TheoremHost, type TheoremHostProps } from './TheoremHost.tsx';
export {
  ApprovalCard,
  type ApprovalCardProps,
  AuthChallengeCard,
  type AuthChallengeCardProps,
  type ToolDecision,
} from './ToolGateCard.tsx';
export { ToolResult } from './ToolResult.tsx';
export { TraceGuardrailsView, TracePlacement, useTraceInspector } from './TraceInspectorPanel.tsx';
export { TheoremThemeProvider, type TheoremThemeProviderProps } from './theme.tsx';
