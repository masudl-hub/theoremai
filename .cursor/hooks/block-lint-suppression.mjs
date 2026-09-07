#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import {
	CONFIG_FILE_PATTERN,
	CONFIG_WEAKEN_PATTERNS,
	findSuppressionReason,
	matchesAny,
} from './_suppression.mjs';

function readStdinJson() {
	const text = readFileSync(0, 'utf8').trim();
	if (!text) return {};
	return JSON.parse(text);
}

function deny(message) {
	process.stdout.write(
		JSON.stringify({
			permission: 'deny',
			user_message: message,
			agent_message: `${message} Ask the user if you believe the lint rule is wrong.`,
		}),
	);
}

function allow() {
	process.stdout.write(JSON.stringify({ permission: 'allow' }));
}

function main() {
	let payload;
	try {
		payload = readStdinJson();
	} catch (error) {
		console.error('[block-lint-suppression] invalid stdin JSON:', error);
		allow();
		return;
	}

	const hookEvent = payload.hook_event_name ?? '';
	const toolName = payload.tool_name ?? '';
	const toolInput = payload.tool_input ?? payload;
	const command = payload.command ?? toolInput.command ?? '';
	const E = 'eslint';
	const D = 'disable';
	const B = 'biome';
	const I = 'ignore';
	const TS = '@ts';

	if (hookEvent === 'beforeShellExecution' || toolName === 'Shell') {
		const shellText = command;
		const shellBlock = new RegExp(`\\b${E}-${D}\\b|\\b${B}-${I}\\b|\\b${TS}-ignore\\b`);
		if (shellBlock.test(shellText)) {
			deny('Shell commands must not inject lint suppressions.');
			return;
		}
		if (/\.eslintrc|eslint\.config|biome\.json/.test(shellText) && /(?:sed|perl|echo|tee|>>|>)/.test(shellText)) {
			deny('Shell commands must not rewrite lint configuration.');
			return;
		}
		allow();
		return;
	}

	if (hookEvent !== 'preToolUse') {
		allow();
		return;
	}

	const writeTools = new Set(['Write', 'StrReplace', 'EditNotebook', 'ApplyPatch', 'search_replace']);
	if (!writeTools.has(toolName)) {
		allow();
		return;
	}

	const filePath =
		toolInput.path ?? toolInput.file_path ?? toolInput.target_notebook ?? toolInput.filePath ?? '';

	// Audit only the text the agent is actually adding, not the existing file content
	// that the IDE may include in the tool payload.
	const auditText =
		(toolName === 'Write' || toolName === 'TabWrite'
			? toolInput.contents ?? toolInput.content
			: toolInput.new_string ?? toolInput.newString) ?? '';
	const hit = findSuppressionReason(auditText, filePath);
	if (hit) {
		if (hit.reason.includes('suppression')) {
			deny(`Adding lint suppressions (${E}-${D}, ${B}-${I}, ${TS}-ignore, etc.) is not allowed.`);
			return;
		}
		deny('Weakening lint configuration (disabling rules, clearing rules, ignorePatterns) is not allowed.');
		return;
	}

	if (CONFIG_FILE_PATTERN.test(filePath)) {
		const candidates = [toolInput.contents, toolInput.content, toolInput.new_string, toolInput.newString].filter(
			(value) => typeof value === 'string',
		);
		for (const text of candidates) {
			if (matchesAny(text, CONFIG_WEAKEN_PATTERNS)) {
				deny('Weakening lint configuration (disabling rules, clearing rules, ignorePatterns) is not allowed.');
				return;
			}
		}
	}

	allow();
}

main();
