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
export {
	COMPOSER_MENU_ACTION_DESCRIPTIONS,
	COMPOSER_MENU_ACTION_LABELS,
	COMPOSER_PRIMARY_LABELS,
} from './components/composer-labels';
export { attachmentIssueText } from './client/attachment-issues';
export { type UseTheoremChatOptions, useTheoremChat } from './hooks/use-theorem-chat';
export { type TheoremInterfaceState, useTheoremInterface } from './hooks/use-theorem-interface';
