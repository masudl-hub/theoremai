import type { ComposerMenuAction } from '../../../src/interface/mod.ts';

/** Shared composer field / action callbacks for InterfaceComposer + InterfaceRunner. */
export type ComposerFieldHandlers = {
	onDraftTextChange?: (text: string) => void;
	onFilesSelected?: (files: File[]) => void;
	onAttachmentRemove?: (index: number) => void;
	onVoiceStaged?: (file: File) => void;
	onVoiceClear?: () => void;
	onSubmit?: () => void;
	onStop?: () => void;
	onMenuAction?: (action: ComposerMenuAction) => void;
};

export type ComposerPendingHandlers = {
	onPendingRemove?: (id: string) => void;
	onPendingMove?: (id: string, direction: 'up' | 'down') => void;
	onPendingQueue?: (id: string) => void;
	onPendingSendNow?: (id: string) => void;
	onPendingRestore?: (id: string) => void;
};

