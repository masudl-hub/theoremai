import {
	InternationalizationContext,
	InternationalizationProvider,
	type MessagesByLocale,
	type Overrides,
	useTranslator,
} from '@astryxdesign/core/i18n';
import { type ReactNode, use, useMemo } from 'react';
import { assertLabelOverrides, type LabelText, THEOREM_UI_CATALOG, type TheoremLabels } from './labels';

/** Message tables this module built, by the base language their catalog sits under. */
const WITH_CATALOG = new WeakMap<MessagesByLocale, string>();

/** `en-GB` → `en`: the last step of Astryx's locale fallback chain. */
function baseLanguage(locale: string): string {
	try {
		return new Intl.Locale(locale).language;
	} catch {
		return locale.split('-')[0] ?? locale;
	}
}

/**
 * The host's messages with Theorem's catalog under the locale's base language,
 * beneath the host's own entries there — so a host translation wins and a
 * missing one falls back to the default line, never to the raw key.
 */
function withCatalog(messages: MessagesByLocale, locale: string): MessagesByLocale {
	const base = baseLanguage(locale);
	if (WITH_CATALOG.get(messages) === base) return messages;
	const next: MessagesByLocale = { ...messages, [base]: { ...THEOREM_UI_CATALOG, ...messages[base] } };
	WITH_CATALOG.set(next, base);
	return next;
}

/** The host's overrides, then `labels` over them, locale by locale. */
function withLabels(host: Overrides | undefined, labels: TheoremLabels | undefined): Overrides | undefined {
	if (!labels) return host;
	const merged: Record<string, Record<string, string>> = {};
	for (const [locale, table] of [...Object.entries(host ?? {}), ...Object.entries(labels)]) {
		merged[locale] = { ...merged[locale], ...table };
	}
	return merged;
}

export type TheoremLabelsProviderProps = {
	/** Replacements by locale for any `@theorem.*` or `@astryx.*` line; checked on mount. */
	labels?: TheoremLabels;
	children: ReactNode;
};

/**
 * Makes Theorem's lines resolvable under the host's Astryx locale, messages
 * and overrides (or Astryx's `en` default), adding `labels` on top. Every
 * exported component renders one, so none shows a raw key; nested ones pass
 * straight through.
 */
export function TheoremLabelsProvider({ labels, children }: TheoremLabelsProviderProps) {
	const host = use(InternationalizationContext);
	const messages = useMemo(() => withCatalog(host.messages, host.locale), [host.messages, host.locale]);
	const overrides = useMemo(() => {
		assertLabelOverrides(host.overrides ?? {}, false);
		if (labels) assertLabelOverrides(labels, true);
		return withLabels(host.overrides, labels);
	}, [host.overrides, labels]);
	if (messages === host.messages && overrides === host.overrides) return <>{children}</>;
	return (
		<InternationalizationProvider locale={host.locale} dir={host.direction} messages={messages} overrides={overrides}>
			{children}
		</InternationalizationProvider>
	);
}

/** The default UI's words, from the nearest Theorem labels provider. */
export function useLabels(): LabelText {
	return useTranslator();
}
