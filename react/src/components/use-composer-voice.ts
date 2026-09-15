import { useCallback, useRef, useState } from 'react';
import type { ProfileInputsInterface } from 'theorum/interface';
import { canStageVoice } from '../client/composer-attachments';
import { ComposerVoiceRecorder, isVoiceRecorderFailure } from '../client/voice-recorder';

function voiceErrMessage(err: unknown, fallback: string): string {
	if (isVoiceRecorderFailure(err)) return err.message;
	if (err instanceof Error) return err.message;
	return fallback;
}

export function useComposerVoice(args: {
	inputs: ProfileInputsInterface;
	pendingFiles: readonly File[];
	onVoiceStaged?: (file: File) => void;
	onVoiceClear?: () => void;
}) {
	const [recording, setRecording] = useState(false);
	const [inputLevel, setInputLevel] = useState(0);
	const [voiceError, setVoiceError] = useState('');
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
		setVoiceError('');
		if (!canStageVoice({ fileCount: args.pendingFiles.length, maxFiles: args.inputs.maxFiles })) {
			const limit = args.inputs.maxFiles ?? 0;
			setVoiceError(`${String(limit)} is the limit.`);
			return;
		}
		onVoiceClearRef.current?.();
		try {
			await ensureRecorder().start();
			setRecording(true);
		} catch (err) {
			setRecording(false);
			setVoiceError(voiceErrMessage(err, 'Microphone unavailable'));
		}
	}, [args.inputs.maxFiles, args.pendingFiles.length, ensureRecorder]);

	const stopRecording = useCallback(async () => {
		setVoiceError('');
		try {
			const file = await ensureRecorder().stop();
			setRecording(false);
			setInputLevel(0);
			onVoiceStagedRef.current?.(file);
		} catch (err) {
			setRecording(false);
			setInputLevel(0);
			setVoiceError(voiceErrMessage(err, 'Recording failed'));
		}
	}, [ensureRecorder]);

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
		voiceError,
		setVoiceError,
		toggleRecording,
		discardRecordingOrVoice,
		disposeRecorder,
	};
}
