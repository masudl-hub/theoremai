import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { VStack } from '@astryxdesign/core/VStack';
import { IconX } from '@tabler/icons-react';
import { voiceFormatFromMime } from '../client/voice-label';
import { voiceNoteName } from './labels';
import { useLabels } from './labels-provider';
import { InkWaveform } from '../components/InkWaveform';
import { useVoicePlayback } from '../components/use-voice-playback';

/** Astryx Thumbnail's height, so voice notes sit level with image attachments. */
const VOICE_NOTE_HEIGHT = 64;
const VOICE_NOTE_WIDTH = 160;

export type VoiceNoteProps = {
	src: string;
	mimeType?: string;
	label?: string;
	/** Composer only: removes the staged note. */
	onRemove?: () => void;
};

/**
 * Voice note as an Astryx ClickableCard holding the ink waveform (the one live
 * uses): click to play or pause; the bars move while it plays.
 */
export function VoiceNote({ src, mimeType = 'audio/webm', label, onRemove }: VoiceNoteProps) {
	const t = useLabels();
	const { playing, outputLevel, toggle, audioProps } = useVoicePlayback();
	const name = label ?? voiceNoteName(t, voiceFormatFromMime(mimeType));
	const remove = t('@theorem.voice_note.remove', { name });

	return (
		<HStack gap={1} vAlign="center">
			<ClickableCard
				label={t(playing ? '@theorem.voice_note.pause' : '@theorem.voice_note.play', { name })}
				onClick={() => {
					void toggle();
				}}
				padding={0}
				width={VOICE_NOTE_WIDTH}
				height={VOICE_NOTE_HEIGHT}
			>
				{/* Bars stand on the card's bottom edge, in the icon colour (no Stack colour prop). */}
				<VStack
					width="100%"
					height="100%"
					paddingInline={2}
					paddingBlockStart={2}
					style={{ color: 'var(--color-icon-primary)' }}
					aria-hidden="true"
				>
					<InkWaveform
						frozen={!playing}
						outputLevel={outputLevel}
						status={playing ? 'speaking' : 'ready'}
						variant="pill"
					/>
				</VStack>
			</ClickableCard>
			{onRemove ? (
				<IconButton label={remove} tooltip={remove} variant="ghost" size="sm" icon={<Icon icon={IconX} />} onClick={onRemove} />
			) : null}
			{/* biome-ignore lint/a11y/useMediaCaption: voice note; played via the card */}
			<audio {...audioProps} src={src} hidden />
		</HStack>
	);
}
