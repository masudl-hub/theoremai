#!/usr/bin/env node
/**
 * Cursor afterFileEdit / afterTabFileEdit / postToolUse hook.
 * Tracks edited files for conversation-scoped lint, and audits suppressions.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { recordEditedFile } from './_edited-files.mjs';

function readStdinJson() {
	const text = readFileSync(0, 'utf8').trim();
	if (!text) return {};
	return JSON.parse(text);
}

function respondEmpty() {
	process.stdout.write('{}');
}

function filePathFromToolInput(toolInput) {
	if (!toolInput || typeof toolInput !== 'object') return '';
	return (
		toolInput.path ??
		toolInput.file_path ??
		toolInput.target_notebook ??
		toolInput.filePath ??
		''
	);
}

function main() {
	let payload;
	try {
		payload = readStdinJson();
	} catch (error) {
		console.error('[audit-file-edit] invalid stdin JSON:', error);
		respondEmpty();
		return;
	}

	const hookEvent = payload.hook_event_name ?? '';
	const conversationId = payload.conversation_id ?? payload.session_id;

	if (hookEvent === 'postToolUse') {
		const writeTools = new Set([
			'Write',
			'StrReplace',
			'EditNotebook',
			'ApplyPatch',
			'search_replace',
			'TabWrite',
		]);
		if (!writeTools.has(payload.tool_name ?? '')) {
			respondEmpty();
			return;
		}
		const editedPath = filePathFromToolInput(payload.tool_input);
		recordEditedFile(conversationId, editedPath);
		respondEmpty();
		return;
	}

	if (hookEvent === 'afterFileEdit' || hookEvent === 'afterTabFileEdit') {
		recordEditedFile(conversationId, payload.file_path ?? '');
		respondEmpty();
		return;
	}

	respondEmpty();
}

main();
