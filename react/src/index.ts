/**
 * Headless React bindings for Theorem — hooks and a transport, no styling.
 *
 * - `@theoremjs/react`         hooks + transport (this entry)
 * - `@theoremjs/react/ui`      Astryx chat UI built on these hooks
 * - `@theoremjs/react/server`  `createTheoremHandler` for the host side
 *
 * @module
 */

export * from './client/index';
export { type UseTheoremChatOptions, useTheoremChat } from './hooks/use-theorem-chat';
export { type TheoremInterfaceState, useTheoremInterface } from './hooks/use-theorem-interface';
