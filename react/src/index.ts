/**
 * Headless React bindings for Theorem — hooks and a transport, no styling.
 *
 * - `@theoremjs/react`         hooks + transport (this entry)
 * - `@theoremjs/react/ui`      Astryx chat UI built on these hooks
 * - `@theoremjs/react/server`  `@theoremjs/web/server`: `createTheoremHandler` (and `createTheoremDecisionHandler`, `createTheoremEmbeddingHandler`, `createTheoremHostHandler`) for the host side
 *
 * @module
 */

export * from '@theoremjs/web/client';
export {
  type EmbeddingIndex,
  type IndexProgress,
  useEmbeddingIndex,
} from './hooks/use-embedding-index.ts';
export {
  type SendTextOptions,
  type SentTurn,
  type UseTheoremChatOptions,
  useTheoremChat,
} from './hooks/use-theorem-chat.ts';
export { type TheoremDecisionState, useTheoremDecision } from './hooks/use-theorem-decision.ts';
export {
  type TheoremEmbeddingState,
  useTheoremEmbedding,
} from './hooks/use-theorem-embedding.ts';
export {
  type TheoremHostCall,
  type TheoremHostState,
  useTheoremHost,
} from './hooks/use-theorem-host.ts';
export { type TheoremInterfaceState, useTheoremInterface } from './hooks/use-theorem-interface.ts';
