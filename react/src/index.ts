/**
 * Headless React bindings for Theorem — hooks and a transport, no styling.
 *
 * - `@theoremai/react`         hooks + transport (this entry)
 * - `@theoremai/react/ui`      Astryx chat UI built on these hooks
 * - `@theoremai/react/server`  `createTheoremHandler` for the host side
 *
 * @module
 */

export * from './client/index';
export { type UseTheoremChatOptions, useTheoremChat } from './hooks/use-theorem-chat';
export { type TheoremInterfaceState, useTheoremInterface } from './hooks/use-theorem-interface';
