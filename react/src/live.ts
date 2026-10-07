/**
 * Live (voice / video) runner, on the Astryx UI in the Theorem theme.
 *
 * @module
 */

// why: Astryx's documented order: reset → components → theme.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './ui/built/theme.css';

export type {
  LiveCallOptions,
  LivePageTool,
  LivePageToolAnswer,
  LivePageTools,
} from './client/live/live-page-tool.ts';
export type { LiveConnection } from './client/live-client.ts';
export type { LiveRunnerProps } from './ui/LiveRunner.tsx';
export { LiveRunner } from './ui/LiveRunner.tsx';
