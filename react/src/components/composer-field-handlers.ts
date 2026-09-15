import type { ComposerMenuAction } from 'theorum/interface';

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
