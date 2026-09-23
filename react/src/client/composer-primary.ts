import {
	type ComposerMenuAction,
	type ComposerPrimaryAction,
	type ComposerProfileInterface,
	type ComposerRunPhase,
	resolveComposerMenuActions,
	resolveComposerPrimary,
	userDraftHasPayload,
} from '../../../src/interface/mod.ts';

function fileSpecs(files: readonly File[]) {
	return files.map((file) => ({
		name: file.name,
		mimeType: file.type || 'application/octet-stream',
		sizeBytes: file.size,
	}));
}

export type ComposerActionState = {
	primary: ComposerPrimaryAction;
	menuActions: ComposerMenuAction[];
	/** Send is off while recording, with nothing to act on, or with an empty draft to send or queue. */
	primaryDisabled: boolean;
};

/** The composer's primary button and send menu for the current draft and run phase. */
export function composerActionState(args: {
	iface: ComposerProfileInterface;
	phase: ComposerRunPhase;
	draftText: string;
	pendingFiles: readonly File[];
	pendingVoice: readonly File[];
	recording: boolean;
}): ComposerActionState {
	const allowSteering = 'allowSteering' in args.iface && Boolean(args.iface.allowSteering);
	const hasPayload = userDraftHasPayload({
		...(args.draftText.trim() ? { text: args.draftText } : {}),
		...(args.pendingFiles.length ? { attachments: fileSpecs(args.pendingFiles) } : {}),
		...(args.pendingVoice.length ? { voice: fileSpecs(args.pendingVoice) } : {}),
	});
	const context = { phase: args.phase, hasPayload, allowSteering };
	const primary = resolveComposerPrimary(context);
	const needsPayload = primary === 'send' || primary === 'queue';
	return {
		primary,
		menuActions: resolveComposerMenuActions(context),
		primaryDisabled: args.recording || primary === 'none' || (needsPayload && !hasPayload),
	};
}
