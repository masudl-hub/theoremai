const E = 'eslint';
const D = 'disable';
const B = 'biome';
const I = 'ignore';
const TS = '@ts';
const F = 'fallow';

export const SUPPRESSION_PATTERNS = [
	new RegExp(`\\b${E}-${D}(?:-next-line|-line)?\\b`),
	new RegExp(`\\b${B}-${I}\\b`),
	new RegExp(`\\b${TS}-ignore\\b`),
	new RegExp(`\\b${TS}-nocheck\\b`),
	new RegExp(`\\b${F}-${I}\\b`),
];

export const CONFIG_WEAKEN_PATTERNS = [
	/"off"\s*[,}]/,
	/"warn"\s*[,}]/,
	/ignorePatterns\s*:/,
	/rules\s*:\s*\{\s*\}/,
];

export const CONFIG_FILE_PATTERN =
	/(?:^|[\\/])(?:biome\.json(?:c)?|eslint\.config\.(?:js|mjs|cjs|ts)|\.eslintrc(?:\.(?:js|json|yaml|yml))?)$/;

export function matchesAny(text, patterns) {
	return patterns.some((pattern) => pattern.test(text));
}

export function findSuppressionReason(text, filePath = '') {
	if (matchesAny(text, SUPPRESSION_PATTERNS)) {
		return `lint suppression comment (${E}-${D}, ${B}-${I}, ${TS}-ignore, etc.)`;
	}
	if (CONFIG_FILE_PATTERN.test(filePath) && matchesAny(text, CONFIG_WEAKEN_PATTERNS)) {
		return 'weakened lint configuration (disabled rules, ignorePatterns, etc.)';
	}
	return null;
}

export function auditEdits(filePath, edits) {
	for (const edit of edits ?? []) {
		const reason = findSuppressionReason(edit.new_string ?? '', filePath);
		if (reason) {
			return { filePath, reason, snippet: edit.new_string ?? '' };
		}
	}
	return null;
}

export function auditToolInput(_toolName, toolInput) {
	if (!toolInput || typeof toolInput !== 'object') return null;

	const filePath =
		toolInput.path ??
		toolInput.file_path ??
		toolInput.target_notebook ??
		toolInput.filePath ??
		'';

	const candidates = [
		toolInput.contents,
		toolInput.content,
		toolInput.new_string,
		toolInput.newString,
		toolInput.text,
		toolInput.code,
	].filter((value) => typeof value === 'string');

	for (const text of candidates) {
		const reason = findSuppressionReason(text, filePath);
		if (reason) {
			return { filePath, reason, snippet: text };
		}
	}

	return null;
}
