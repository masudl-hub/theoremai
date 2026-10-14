import type { TheoremLabels } from '@theoremjs/react/ui';

/**
 * The studio's own lines: a credential typed at a sign-in gate serves one call and is never
 * saved, and a message's delivery status reads in lower case like the rest.
 */
export const STUDIO_LABELS: TheoremLabels = {
	en: {
		'@theorem.gate.auth.secret_note': "Used for this call only. theorem doesn't store it.",
		'@astryx.chat.status.sending': 'sending',
		'@astryx.chat.status.sent': 'sent',
		'@astryx.chat.status.delivered': 'delivered',
		'@astryx.chat.status.read': 'read',
	},
};
