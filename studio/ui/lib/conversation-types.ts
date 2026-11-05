/** The types that run one call or one session at a time, with no conversation of turns. */
const NOT_A_CONVERSATION: ReadonlySet<string> = new Set(['decision', 'host', 'embedding', 'live']);

/**
 * Whether a profile of `type` runs as a conversation of turns: a chat in the preview, a trace
 * that replays, and `createTheoremHandler` in exported code.
 */
export const runsAsConversation = (type: string): boolean => !NOT_A_CONVERSATION.has(type);
