import type { TranscriptBlock } from '../../../src/interface/mod.ts';
import type { LabelText } from './labels.ts';

/** Plain text copied from a transcript block. */
export function transcriptBlockCopyText(t: LabelText, block: TranscriptBlock): string {
	switch (block.kind) {
		case 'user-text':
			return block.text;
		case 'user-attachment':
		case 'user-voice':
			return block.name;
		case 'thought':
			return block.text;
		case 'text':
			return block.text;
		case 'tool': {
			const lines = [t('@theorem.transcript.copy_text.tool', { name: block.tool.name })];
			if (block.tool.output !== undefined) {
				lines.push(JSON.stringify(block.tool.output, null, 2));
			} else if (block.tool.failure !== undefined) {
				lines.push(JSON.stringify(block.tool.failure, null, 2));
			}
			return lines.join('\n\n');
		}
		case 'structured':
			return JSON.stringify(block.value, null, 2);
		case 'media':
			return block.url ?? t('@theorem.transcript.copy_text.media', { mimeType: block.mimeType });
		case 'grounding':
			return JSON.stringify(block.grounding, null, 2);
		case 'evidence':
			return JSON.stringify(block.evidence, null, 2);
		case 'error':
			return block.message;
		case 'turn-done':
			return '';
	}
}
