/**
 * The default UI's words, as an Astryx i18n catalog under `@theorem.*` keys:
 * the same mechanism that words Astryx's own components (`@astryx.*`), so one
 * override table replaces any line on screen, per locale. Messages are ICU
 * (`{handle}`, `{n, plural, …}`); `params` names the values each one is given.
 * Failures are worded by the profile lexicon, not here.
 *
 * @module
 */

import { IntlMessageFormat } from 'intl-messageformat';
import type { ComposerDrawerSummary } from '../client/composer-drawer.ts';
import type { LiveState } from '../client/live/live-state.ts';
import type { WorkStatus } from '../client/transcript-groups.ts';

type LabelEntry = { defaultMessage: string; description: string; params?: readonly string[] };

export const THEOREM_UI_CATALOG = {
	'@theorem.agent.handle': {
		defaultMessage: '@{handle}',
		description: "The agent's name above its messages, on the landing and in captions.",
		params: ['handle'],
	},

	'@theorem.chat.greeting': { defaultMessage: 'What are we working on?', description: 'Chat landing heading, before the first message.' },
	'@theorem.chat.loading': { defaultMessage: 'Loading…', description: 'Spinner label while the profile loads.' },
	'@theorem.chat.live_unsupported.title': {
		defaultMessage: "Live profiles aren't supported here",
		description: 'Shown when TheoremChat is pointed at a live profile.',
	},
	'@theorem.chat.live_unsupported.description': {
		defaultMessage: 'Use LiveRunner from @theoremai/react/live.',
		description: 'Where to go instead, under the live-profile warning.',
	},

	'@theorem.composer.placeholder': {
		defaultMessage: 'Message @{handle}',
		description: 'Empty composer placeholder.',
		params: ['handle'],
	},
	'@theorem.composer.listening': { defaultMessage: 'Listening…', description: 'Composer placeholder while a voice note records.' },
	'@theorem.composer.attach': { defaultMessage: 'Attach files', description: 'Paperclip button.' },
	'@theorem.composer.record': { defaultMessage: 'Record voice', description: 'Microphone button, idle.' },
	'@theorem.composer.stop_recording': { defaultMessage: 'Stop recording', description: 'Microphone button, recording.' },
	'@theorem.composer.send_options': { defaultMessage: 'More send options', description: 'Menu button beside send.' },
	'@theorem.composer.model': { defaultMessage: 'Model', description: 'Model selector (screen readers).' },
	'@theorem.composer.effort': { defaultMessage: 'Effort', description: 'Effort selector (screen readers).' },
	'@theorem.composer.menu.queue': { defaultMessage: 'Queue', description: 'Send menu item.' },
	'@theorem.composer.menu.queue.description': {
		defaultMessage: 'Send after the current run finishes.',
		description: 'Send menu item detail.',
	},
	'@theorem.composer.menu.steer': { defaultMessage: 'Steer current run', description: 'Send menu item.' },
	'@theorem.composer.menu.steer.description': {
		defaultMessage: 'Inject at the next inject-capable stage (pre_turn / post_tool / before_end).',
		description: 'Send menu item detail.',
	},
	'@theorem.composer.menu.send_now': { defaultMessage: 'Send now', description: 'Send menu item.' },
	'@theorem.composer.menu.send_now.description': {
		defaultMessage: 'Stop or leave the gate, then send this message.',
		description: 'Send menu item detail.',
	},
	'@theorem.composer.menu.stash': { defaultMessage: 'Stash', description: 'Send menu item.' },
	'@theorem.composer.menu.stash.description': {
		defaultMessage: 'Save in the composer for later.',
		description: 'Send menu item detail.',
	},
	'@theorem.composer.hint.stash-selected-draft.message': {
		defaultMessage: 'Replacing this?',
		description: 'Hint when the whole draft is selected and could be stashed.',
	},
	'@theorem.composer.hint.stash-selected-draft.action': { defaultMessage: 'Stash it', description: 'The hint\'s button.' },
	'@theorem.composer.drawer.steer': { defaultMessage: 'steering', description: 'Drawer header when only steering messages wait.' },
	'@theorem.composer.drawer.queue': { defaultMessage: 'queued', description: 'Drawer header when only queued messages wait.' },
	'@theorem.composer.drawer.stash': { defaultMessage: 'stashed', description: 'Drawer header when only stashed messages wait.' },
	'@theorem.composer.drawer.attached': { defaultMessage: 'attached', description: 'Drawer header when only files wait.' },
	'@theorem.composer.drawer.steer.count': { defaultMessage: '{n} steering', description: 'One part of a mixed drawer header.', params: ['n'] },
	'@theorem.composer.drawer.queue.count': { defaultMessage: '{n} queued', description: 'One part of a mixed drawer header.', params: ['n'] },
	'@theorem.composer.drawer.stash.count': { defaultMessage: '{n} stashed', description: 'One part of a mixed drawer header.', params: ['n'] },
	'@theorem.composer.drawer.attached.count': {
		defaultMessage: '{n} attached',
		description: 'One part of a mixed drawer header.',
		params: ['n'],
	},
	'@theorem.composer.drawer.separator': { defaultMessage: ' · ', description: 'Between the parts of a mixed drawer header.' },
	'@theorem.composer.pending.steer': { defaultMessage: 'Steer', description: 'Badge on a waiting steering message.' },
	'@theorem.composer.pending.queue': { defaultMessage: 'Queued', description: 'Badge on a waiting queued message.' },
	'@theorem.composer.pending.stash': { defaultMessage: 'Stashed', description: 'Badge on a waiting stashed message.' },
	'@theorem.composer.pending.edit': { defaultMessage: 'Edit', description: 'Waiting message: back into the composer.' },
	'@theorem.composer.pending.queue_action': { defaultMessage: 'Queue', description: 'Stashed message: queue it.' },
	'@theorem.composer.pending.send_now': { defaultMessage: 'Send now', description: 'Waiting message: send it now.' },
	'@theorem.composer.pending.move_up': { defaultMessage: 'Move up', description: 'Waiting message: earlier.' },
	'@theorem.composer.pending.move_down': { defaultMessage: 'Move down', description: 'Waiting message: later.' },
	'@theorem.composer.pending.remove': { defaultMessage: 'Remove', description: 'Waiting message: discard.' },

	'@theorem.transcript.copy': { defaultMessage: 'Copy', description: 'Copy a message.' },
	'@theorem.transcript.copied': { defaultMessage: 'Copied', description: 'Right after copying a message.' },
	'@theorem.transcript.now': { defaultMessage: 'now', description: 'Message time during its first minute.' },
	'@theorem.transcript.generated_image': { defaultMessage: 'Generated image', description: 'Alt text for a generated image.' },
	'@theorem.transcript.generated_video': { defaultMessage: 'Generated video', description: 'Alt text for a generated video.' },
	'@theorem.transcript.open_generated_image': { defaultMessage: 'Open generated image', description: 'Opens the image full size.' },
	'@theorem.transcript.generating_image': { defaultMessage: 'Generating image', description: 'Placeholder while an image generates.' },
	'@theorem.transcript.sources': { defaultMessage: 'Sources', description: 'The row of source chips (screen readers).' },
	'@theorem.transcript.copy_text.tool': {
		defaultMessage: 'Tool: {name}',
		description: 'A tool call in copied message text.',
		params: ['name'],
	},
	'@theorem.transcript.copy_text.media': {
		defaultMessage: '[{mimeType} media]',
		description: 'Media without a link, in copied message text.',
		params: ['mimeType'],
	},
	'@theorem.transcript.working': { defaultMessage: 'Working…', description: 'Turn status while running, start unknown.' },
	'@theorem.transcript.working_for': {
		defaultMessage: 'Working for {duration}',
		description: 'Turn status while running.',
		params: ['duration'],
	},
	'@theorem.transcript.worked': { defaultMessage: 'Worked', description: 'Turn status once done, duration unknown.' },
	'@theorem.transcript.worked_for': {
		defaultMessage: 'Worked for {duration}',
		description: 'Turn status once done.',
		params: ['duration'],
	},

	'@theorem.duration.milliseconds': { defaultMessage: '{ms}ms', description: 'Under a second.', params: ['ms'] },
	'@theorem.duration.seconds': { defaultMessage: '{seconds}s', description: 'Under a minute.', params: ['seconds'] },
	'@theorem.duration.minutes': { defaultMessage: '{minutes}m', description: 'Whole minutes.', params: ['minutes'] },
	'@theorem.duration.minutes_seconds': {
		defaultMessage: '{minutes}m {seconds}s',
		description: 'Minutes and seconds.',
		params: ['minutes', 'seconds'],
	},

	'@theorem.gate.approval.badge': { defaultMessage: 'Approval required', description: 'Tool approval card badge.' },
	'@theorem.gate.approval.title': { defaultMessage: 'Tool:', description: 'Before the tool name on the approval card.' },
	'@theorem.gate.approval.input': { defaultMessage: 'Input arguments', description: 'Expands the arguments the tool would run with.' },
	'@theorem.gate.approval.deny': { defaultMessage: 'Deny', description: 'Approval card button.' },
	'@theorem.gate.approval.approve': { defaultMessage: 'Approve', description: 'Approval card button.' },
	'@theorem.gate.approval.denied': { defaultMessage: 'Denied', description: 'After denying.' },
	'@theorem.gate.approval.approved_session': {
		defaultMessage: 'Approved for this session',
		description: 'After approving a tool whose consent lasts the session.',
	},
	'@theorem.gate.approval.approved_once': { defaultMessage: 'Approved once', description: 'After approving a single run.' },
	'@theorem.gate.tag.confirmation': { defaultMessage: 'confirmation', description: 'Gate kind tag.' },
	'@theorem.gate.tag.permission': { defaultMessage: 'permission', description: 'Gate kind tag.' },
	'@theorem.gate.tag.auth': { defaultMessage: 'auth', description: 'Gate kind tag.' },
	'@theorem.gate.tag.auto': { defaultMessage: 'auto', description: 'Tool permission tag.' },
	'@theorem.gate.tag.session_consent': { defaultMessage: 'session_consent', description: 'Tool permission tag.' },
	'@theorem.gate.tag.always_confirm': { defaultMessage: 'always_confirm', description: 'Tool permission tag.' },
	'@theorem.gate.tag.bearer': { defaultMessage: 'bearer', description: 'Credential type tag.' },
	'@theorem.gate.tag.api_key': { defaultMessage: 'api_key', description: 'Credential type tag.' },
	'@theorem.gate.tag.oauth2': { defaultMessage: 'oauth2', description: 'Credential type tag.' },
	'@theorem.gate.auth.badge': { defaultMessage: 'Sign-in required', description: 'Credential card badge.' },
	'@theorem.gate.auth.title': { defaultMessage: 'Authentication:', description: 'Before the tool name on the credential card.' },
	'@theorem.gate.auth.message': {
		defaultMessage: 'This tool requires valid authentication credentials to proceed.',
		description: "When the tool's challenge carries no message of its own.",
	},
	'@theorem.gate.auth.resource': { defaultMessage: 'Resource: {resource}', description: 'What the credential is for.', params: ['resource'] },
	'@theorem.gate.auth.no_oauth': {
		defaultMessage: 'No OAuth authorization endpoint is configured.',
		description: 'OAuth tool without an authorization URL.',
	},
	'@theorem.gate.auth.authorize': { defaultMessage: 'Authorize with provider', description: 'Opens the OAuth sign-in.' },
	'@theorem.gate.auth.provided': {
		defaultMessage: 'Credential provided for {slot}',
		description: 'After submitting a credential or finishing an OAuth sign-in.',
		params: ['slot'],
	},
	'@theorem.gate.auth.api_key': { defaultMessage: 'API key', description: 'Secret field label, API-key tools.' },
	'@theorem.gate.auth.bearer': { defaultMessage: 'Bearer token', description: 'Secret field label, bearer tools.' },
	'@theorem.gate.auth.secret_placeholder': {
		defaultMessage: "Secret for slot ''{slot}''",
		description: 'Secret field placeholder.',
		params: ['slot'],
	},
	'@theorem.gate.auth.submit': { defaultMessage: 'Submit & continue', description: 'Sends the credential.' },

	'@theorem.voice_note.name': {
		defaultMessage: 'voice.{format}',
		description: "A voice note's name, by audio format (webm, wav, mp3, m4a, ogg).",
		params: ['format'],
	},
	'@theorem.voice_note.unnamed': { defaultMessage: 'voice note', description: "A voice note's name when its format is unknown." },
	'@theorem.voice_note.play': { defaultMessage: 'Play {name}', description: 'Voice note, paused.', params: ['name'] },
	'@theorem.voice_note.pause': { defaultMessage: 'Pause {name}', description: 'Voice note, playing.', params: ['name'] },
	'@theorem.voice_note.remove': { defaultMessage: 'Remove {name}', description: 'Unstages a voice note.', params: ['name'] },

	'@theorem.panel.trace.name': { defaultMessage: 'Trace', description: 'Trace side panel (screen readers).' },
	'@theorem.panel.trace.show': { defaultMessage: 'Show trace', description: 'Trace panel toggle, closed.' },
	'@theorem.panel.trace.hide': { defaultMessage: 'Hide trace', description: 'Trace panel toggle, open.' },
	'@theorem.panel.trace.resize': { defaultMessage: 'Resize trace', description: 'Trace panel drag handle.' },
	'@theorem.panel.trace.empty.title': { defaultMessage: 'No trace yet', description: 'Empty trace panel.' },
	'@theorem.panel.trace.empty.description': {
		defaultMessage: 'Spans for each turn will show here.',
		description: 'Empty trace panel.',
	},
	'@theorem.panel.trace.summary': {
		defaultMessage: '{traces, plural, one {# trace} other {# traces}} · {spans, plural, one {# span} other {# spans}}',
		description: 'Trace panel line under the search: how many traces and spans it holds.',
		params: ['traces', 'spans'],
	},
	'@theorem.panel.trace.separator': { defaultMessage: ' · ', description: 'Between facts on one trace panel line.' },
	'@theorem.panel.trace.search': { defaultMessage: 'Search spans', description: 'Trace panel search (screen readers).' },
	'@theorem.panel.trace.search.placeholder': {
		defaultMessage: 'Filter by type, status, model, text…',
		description: 'Trace panel search, empty.',
	},
	'@theorem.panel.trace.search.text': { defaultMessage: 'Any text', description: 'Search field matching any text a span holds.' },
	'@theorem.panel.trace.search.text.description': {
		defaultMessage: 'Names, values and stored text.',
		description: 'What the any-text search field matches.',
	},
	'@theorem.panel.trace.no_match': { defaultMessage: 'No spans match', description: 'Trace panel, when the search matches nothing.' },
	'@theorem.panel.trace.back': { defaultMessage: 'All spans', description: 'Leaves a span for the span list.' },
	'@theorem.panel.trace.show_text': { defaultMessage: 'Show text', description: 'Reveals stored text, JSON or messages.' },
	'@theorem.panel.trace.hide_text': { defaultMessage: 'Hide text', description: 'Hides revealed stored text.' },
	'@theorem.panel.trace.other': { defaultMessage: 'Other', description: 'Group for attributes the trace catalog does not name.' },
	'@theorem.panel.trace.yes': { defaultMessage: 'Yes', description: 'A true trace value.' },
	'@theorem.panel.trace.no': { defaultMessage: 'No', description: 'A false trace value.' },
	'@theorem.panel.trace.tokens': { defaultMessage: 'Tokens', description: 'Card of token counts.' },
	'@theorem.panel.trace.errors': { defaultMessage: 'Errors', description: 'Card counting failed spans.' },
	'@theorem.panel.trace.at_least': {
		defaultMessage: 'At least {value}',
		description: 'A total some calls did not report.',
		params: ['value'],
	},
	'@theorem.panel.trace.about': {
		defaultMessage: 'About {value}',
		description: 'A total with estimated counts.',
		params: ['value'],
	},
	'@theorem.panel.trace.offset': {
		defaultMessage: '+{duration}',
		description: 'When an event happened, after its span started.',
		params: ['duration'],
	},
	'@theorem.panel.trace.unit.milliseconds': { defaultMessage: 'ms', description: 'Unit of a search field in milliseconds.' },
	'@theorem.panel.trace.unit.seconds': { defaultMessage: 's', description: 'Unit of a search field in seconds.' },
	'@theorem.panel.trace.unit.usd': { defaultMessage: 'USD', description: 'Unit of a search field in US dollars.' },
	'@theorem.panel.captions.name': { defaultMessage: 'Captions', description: 'Captions side panel (screen readers).' },
	'@theorem.panel.captions.show': { defaultMessage: 'Show captions', description: 'Captions panel toggle, closed.' },
	'@theorem.panel.captions.hide': { defaultMessage: 'Hide captions', description: 'Captions panel toggle, open.' },
	'@theorem.panel.captions.resize': { defaultMessage: 'Resize captions', description: 'Captions panel drag handle.' },
	'@theorem.panel.captions.empty.title': { defaultMessage: 'No captions yet', description: 'Empty captions panel.' },
	'@theorem.panel.captions.empty.description': {
		defaultMessage: 'What you and the agent say will show here.',
		description: 'Empty captions panel.',
	},

	'@theorem.live.greeting': { defaultMessage: 'Ready when you are.', description: 'Live landing heading, before a call.' },
	'@theorem.live.start_voice_call': { defaultMessage: 'Start voice call', description: 'Live landing, voice profiles.' },
	'@theorem.live.start_call': { defaultMessage: 'Start call', description: 'Starts or restarts a call.' },
	'@theorem.live.start_video_call': { defaultMessage: 'Start video call', description: 'Live landing, video profiles.' },
	'@theorem.live.microphone': { defaultMessage: 'Microphone', description: 'Mic toggle.' },
	'@theorem.live.mute': { defaultMessage: 'Mute', description: 'Mic toggle tooltip, unmuted.' },
	'@theorem.live.unmute': { defaultMessage: 'Unmute', description: 'Mic toggle tooltip, muted.' },
	'@theorem.live.camera': { defaultMessage: 'Camera', description: 'Camera toggle.' },
	'@theorem.live.camera_on': { defaultMessage: 'Turn camera on', description: 'Camera toggle tooltip, off.' },
	'@theorem.live.camera_off': { defaultMessage: 'Turn camera off', description: 'Camera toggle tooltip, on.' },
	'@theorem.live.flip_camera': { defaultMessage: 'Flip camera', description: 'Switches front and back camera.' },
	'@theorem.live.end_call': { defaultMessage: 'End call', description: 'Hangs up.' },
	'@theorem.live.controls': { defaultMessage: 'Call controls', description: 'The control toolbar (screen readers).' },
	'@theorem.live.new_session': { defaultMessage: 'New session', description: 'Captions divider between calls.' },
	'@theorem.live.camera_preview': { defaultMessage: 'Camera preview', description: 'Self-view (screen readers).' },
	'@theorem.live.state.calling_tool': { defaultMessage: 'calling {tool}', description: 'Call status: a tool runs.', params: ['tool'] },
	'@theorem.live.state.connecting': { defaultMessage: 'connecting', description: 'Call status.' },
	'@theorem.live.state.requesting_mic': { defaultMessage: 'requesting mic', description: 'Call status.' },
	'@theorem.live.state.speaking': { defaultMessage: 'speaking', description: 'Call status: the agent speaks.' },
	'@theorem.live.state.connected': { defaultMessage: 'connected', description: 'Call status.' },
	'@theorem.live.state.muted': { defaultMessage: 'muted', description: 'Call status.' },
	'@theorem.live.state.listening': { defaultMessage: 'listening', description: 'Call status.' },
	'@theorem.live.state.error': { defaultMessage: 'error', description: 'Call status.' },
	'@theorem.live.state.ended': { defaultMessage: 'ended', description: 'Call status.' },
} as const satisfies Record<`@theorem.${string}`, LabelEntry>;

/** The default UI's catalog: each line's default message, description and values. */
export type TheoremUiCatalog = typeof THEOREM_UI_CATALOG;

/** Every line the default UI writes. */
export type TheoremLabelKey = keyof TheoremUiCatalog;

/** The values a label's message is formatted with; none for a plain line. */
export type TheoremLabelValues<K extends TheoremLabelKey> = TheoremUiCatalog[K] extends { params: readonly (infer P extends string)[] }
	? Record<P, string | number>
	: undefined;

/** Words a label; the default UI gets one from Astryx's `useTranslator`. */
export type LabelText = <K extends TheoremLabelKey>(key: K, values?: TheoremLabelValues<K>) => string;

/**
 * One locale's replacements: any `@theorem.*` line, and any of Astryx's own
 * (`@astryx.*`, see `@astryxdesign/core/locales/en.json`).
 */
export type TheoremLabelOverrides = { readonly [K in TheoremLabelKey]?: string } & {
	readonly [key: `@astryx.${string}`]: string;
};

/** Replacements by locale (`en`, `en-GB`, `de`, …), as Astryx's `overrides`. */
export type TheoremLabels = { readonly [locale: string]: TheoremLabelOverrides | undefined };

/** A single kind is just its word ("queued"); a mix spells out each count ("2 queued · 1 attached"). */
export function composerDrawerLabel(t: LabelText, summary: ComposerDrawerSummary): string {
	const [only] = summary.parts;
	if (summary.parts.length === 1 && only) return t(`@theorem.composer.drawer.${only.kind}`);
	return summary.parts
		.map((part) => t(`@theorem.composer.drawer.${part.kind}.count`, { n: part.n }))
		.join(t('@theorem.composer.drawer.separator'));
}

/** Wall-clock duration, matching Seance's builder-trace formatter: "850ms", "3.2s", "12s", "1m 5s". */
export function workDuration(t: LabelText, durationMs: number): string {
	const ms = Math.max(0, durationMs);
	if (ms < 1_000) return t('@theorem.duration.milliseconds', { ms: Math.round(ms) });
	if (ms < 10_000) return t('@theorem.duration.seconds', { seconds: Math.round(ms / 100) / 10 });
	if (ms < 60_000) return t('@theorem.duration.seconds', { seconds: Math.round(ms / 1_000) });
	return minutesAndSeconds(t, Math.floor(ms / 60_000), Math.round((ms % 60_000) / 1_000));
}

/** Whole-second ticker while a turn runs: "0s", "12s", "1m 5s". */
function liveDuration(t: LabelText, durationMs: number): string {
	const total = Math.floor(Math.max(0, durationMs) / 1_000);
	if (total < 60) return t('@theorem.duration.seconds', { seconds: total });
	return minutesAndSeconds(t, Math.floor(total / 60), total % 60);
}

function minutesAndSeconds(t: LabelText, minutes: number, seconds: number): string {
	if (seconds === 0) return t('@theorem.duration.minutes', { minutes });
	return t('@theorem.duration.minutes_seconds', { minutes, seconds });
}

/** "Working for 12s" while streaming (when the start is known), "Worked for 3.2s" after. */
export function workStatusLabel(t: LabelText, status: WorkStatus | null): string {
	if (!status) return '';
	if (status.phase === 'working') {
		return status.elapsedMs === undefined
			? t('@theorem.transcript.working')
			: t('@theorem.transcript.working_for', { duration: liveDuration(t, status.elapsedMs) });
	}
	return status.elapsedMs === undefined
		? t('@theorem.transcript.worked')
		: t('@theorem.transcript.worked_for', { duration: workDuration(t, status.elapsedMs) });
}

/** A live call's status line; `calling_tool` names the tool. */
export function liveStateLabel(t: LabelText, state: LiveState, toolName: string | null): string {
	if (state === 'calling_tool') return t('@theorem.live.state.calling_tool', { tool: toolName ?? '' });
	return t(`@theorem.live.state.${state}`);
}

/** A voice note's name from its audio format; the unnamed line when the format is unknown. */
export function voiceNoteName(t: LabelText, format: string | undefined): string {
	return format ? t('@theorem.voice_note.name', { format }) : t('@theorem.voice_note.unnamed');
}

const CATALOG_KEYS: ReadonlySet<string> = new Set(Object.keys(THEOREM_UI_CATALOG));

function catalogParams(key: string): readonly string[] {
	const entry: LabelEntry | undefined = (THEOREM_UI_CATALOG as Record<string, LabelEntry>)[key];
	return entry?.params ?? [];
}

/**
 * Checks a label table before it renders: every `@theorem.*` key must exist
 * and its message must format with that key's values only; with `strict`
 * (the `labels` prop), every other key must be an `@astryx.*` line whose
 * message parses. A host's own Astryx overrides are checked for `@theorem.*`
 * keys only, since the rest may be the host app's own strings. Throws, naming
 * the locale and key, so a typo fails at mount instead of showing a raw key or
 * crashing mid-render.
 */
export function assertLabelOverrides(labels: TheoremLabels, strict: boolean): void {
	for (const [locale, table] of Object.entries(labels)) {
		if (!isLocale(locale)) throw new Error(`Theorem labels: ${locale}: not a BCP 47 locale`); // lexicon-exempt: builder contract error
		for (const [key, message] of Object.entries(table ?? {})) {
			if (!strict && !key.startsWith('@theorem.')) continue;
			const problem = labelProblem(locale, key, message);
			if (problem) throw new Error(`Theorem labels: ${locale} ${key}: ${problem}`); // lexicon-exempt: builder contract error
		}
	}
}

function isLocale(locale: string): boolean {
	try {
		return Intl.getCanonicalLocales(locale).length === 1;
	} catch {
		return false;
	}
}

function labelProblem(locale: string, key: string, message: unknown): string | undefined {
	if (typeof message !== 'string') return 'the message must be a string';
	const theorem = key.startsWith('@theorem.');
	if (!theorem && !key.startsWith('@astryx.')) return 'keys start with @theorem. or @astryx.';
	if (theorem && !CATALOG_KEYS.has(key)) return 'no such label';
	let format: IntlMessageFormat;
	try {
		format = new IntlMessageFormat(message, locale);
	} catch (error) {
		return `not a valid ICU message (${String(error)})`;
	}
	if (!theorem) return undefined;
	const params = catalogParams(key);
	try {
		format.format(Object.fromEntries(params.map((name) => [name, 1])));
	} catch (error) {
		const allowed = params.length > 0 ? `may only use ${params.map((name) => `{${name}}`).join(', ')}` : 'takes no values';
		return `the message ${allowed} (${String(error)})`;
	}
	return undefined;
}
