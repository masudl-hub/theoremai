import { useCallback, useRef, useState } from 'react';
import { attachmentIssueText, describeError, type LexiconOverrides, lexiconText } from '../../../mod.ts';
import type { ProfileInputsInterface } from '../../../src/interface/mod.ts';
import { canStageVoice } from '../client/composer-attachments';
import {
	ComposerVoiceRecorder,
	isVoiceRecorderFailure,
	type VoiceRecorderFailureCode,
} from '../client/voice-recorder';

/** A voice note that could not be recorded or staged. */
export type VoiceFailure = {
	/** A recorder failure, or `too_many_files` when the message is already full. */
	code: VoiceRecorderFailureCode | 'too_many_files';
	/** What the user reads: the profile lexicon's `voice.<code>` (or the file-limit line). */
	error: string;
	/** Raw detail for the builder; never shown to the user. */
	errorInternal?: string;
};

function voiceFailure(
	err: unknown,
	fallback: VoiceRecorderFailureCode,
	lexicon: LexiconOverrides,
): VoiceFailure {
	const code = isVoiceRecorderFailure(err) ? err.code : fallback;
	const internal = describeError(err);
	return {
		code,
		error: lexiconText(`voice.${code}`, {}, lexicon),
		...(internal && internal !== code ? { errorInternal: internal } : {}),
	};
}

export function useComposerVoice(args: {
	inputs: ProfileInputsInterface;
	/** The interface's `lexicon`: the profile's wording for voice failures. */
	lexicon: LexiconOverrides;
	pendingFiles: readonly File[];
	onVoiceStaged?: (file: File) => void;
	onVoiceClear?: () => void;
}) {
	const [recording, setRecording] = useState(false);
	const [inputLevel, setInputLevel] = useState(0);
	const [failure, setFailure] = useState<VoiceFailure | null>(null);
	const recorderRef = useRef<ComposerVoiceRecorder | null>(null);
	const onVoiceStagedRef = useRef(args.onVoiceStaged);
	const onVoiceClearRef = useRef(args.onVoiceClear);
	onVoiceStagedRef.current = args.onVoiceStaged;
	onVoiceClearRef.current = args.onVoiceClear;

	const ensureRecorder = useCallback((): ComposerVoiceRecorder => {
		recorderRef.current ??= new ComposerVoiceRecorder(args.inputs.voice?.accept ?? [], (level) => {
			setInputLevel(level);
		});
		return recorderRef.current;
	}, [args.inputs.voice?.accept]);

	const startRecording = useCallback(async () => {
		setFailure(null);
		const maxFiles = args.inputs.maxFiles;
		if (!canStageVoice({ fileCount: args.pendingFiles.length, maxFiles })) {
			setFailure({
				code: 'too_many_files',
				error: attachmentIssueText({ code: 'too_many_files', params: { maxFiles } }, args.lexicon),
			});
			return;
		}
		onVoiceClearRef.current?.();
		try {
			await ensureRecorder().start();
			setRecording(true);
		} catch (err) {
			setRecording(false);
			setFailure(voiceFailure(err, 'unavailable', args.lexicon));
		}
	}, [args.inputs.maxFiles, args.lexicon, args.pendingFiles.length, ensureRecorder]);

	const stopRecording = useCallback(async () => {
		setFailure(null);
		try {
			const file = await ensureRecorder().stop();
			setRecording(false);
			setInputLevel(0);
			onVoiceStagedRef.current?.(file);
		} catch (err) {
			setRecording(false);
			setInputLevel(0);
			setFailure(voiceFailure(err, 'failed', args.lexicon));
		}
	}, [args.lexicon, ensureRecorder]);

	const toggleRecording = useCallback(async () => {
		if (recording) {
			await stopRecording();
			return;
		}
		await startRecording();
	}, [recording, startRecording, stopRecording]);

	const discardRecordingOrVoice = useCallback(() => {
		if (recording) {
			ensureRecorder().cancel();
			setRecording(false);
			setInputLevel(0);
		}
		onVoiceClearRef.current?.();
	}, [ensureRecorder, recording]);

	const disposeRecorder = useCallback(() => {
		recorderRef.current?.dispose();
	}, []);

	return {
		recording,
		inputLevel,
		failure,
		setFailure,
		toggleRecording,
		discardRecordingOrVoice,
		disposeRecorder,
	};
}
