import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import {
  IconArrowsDiagonal,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
} from '@tabler/icons-react';
import { InkWaveform } from '../components/InkWaveform.tsx';
import type { LiveCall } from '../components/live/use-live-call.ts';
import { useSecondTicker } from '../hooks/use-second-ticker.ts';
import { LiveVideoPreview } from './LiveVideoPreview.tsx';
import { liveDuration, liveStateLabel, type TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type LiveCallTileProps = {
  /** The call to draw, from `useLiveCall`: the same call `LiveRunner` draws. */
  call: LiveCall;
  /**
   * Called when the person asks to open the call full size, from the tile or
   * its expand control. The host decides what that means, such as going back
   * to the call's page.
   */
  onExpand: () => void;
  /** Astryx theme, as on `LiveRunner`. */
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  /** Replacement lines by locale, as on `LiveRunner`. */
  labels?: TheoremLabels;
};

/**
 * A small view of a running call: the camera preview, or the ink waveform
 * when the camera is off, then the call time, mute, end, and expand. It fills
 * the box the host gives it; the host places it.
 */
export function LiveCallTile({ theme, mode, labels, ...props }: LiveCallTileProps) {
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <LiveCallTileBody {...props} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}

function LiveCallTileBody({
  call,
  onExpand,
}: Omit<LiveCallTileProps, 'theme' | 'mode' | 'labels'>) {
  const t = useLabels();
  return (
    <ClickableCard
      label={t('@theorem.live.expand')}
      onClick={onExpand}
      padding={0}
      elevation="high"
      width="100%"
    >
      <VStack>
        <TileMedia call={call} />
        <HStack gap={1} vAlign="center" padding={2}>
          <StackItem size="fill">
            <TileTime call={call} />
          </StackItem>
          <TileControls call={call} onExpand={onExpand} />
        </HStack>
      </VStack>
    </ClickableCard>
  );
}

/** The camera preview while the camera is on; otherwise the ink waveform. */
function TileMedia({ call }: { call: LiveCall }) {
  if (call.isVideoOn && call.videoPreview) {
    return <LiveVideoPreview video={call.videoPreview} facingMode={call.videoFacingMode} />;
  }
  return (
    <AspectRatio ratio={4 / 3}>
      <VStack height="100%" vAlign="center" padding={4} aria-hidden="true">
        <InkWaveform
          status={call.status}
          levelsRef={call.levelsRef}
          toolActive={call.toolActive}
          variant="pill"
        />
      </VStack>
    </AspectRatio>
  );
}

/** How long the call has run, or its state before it connects and after it ends. */
function TileTime({ call }: { call: LiveCall }) {
  const t = useLabels();
  const since = call.sessionActive ? call.connectedAt : null;
  const now = useSecondTicker(since !== null);
  return (
    <Text type="supporting" hasTabularNumbers maxLines={1}>
      {since === null
        ? liveStateLabel(t, call.liveState, call.activeTool)
        : liveDuration(t, now - since)}
    </Text>
  );
}

function TileControls({ call, onExpand }: { call: LiveCall; onExpand: () => void }) {
  const t = useLabels();
  return (
    <>
      {call.voiceAvailable ? (
        <ToggleButton
          label={t('@theorem.live.microphone')}
          tooltip={t(call.isMuted ? '@theorem.live.unmute' : '@theorem.live.mute')}
          isIconOnly
          size="sm"
          isPressed={!call.isMuted}
          isDisabled={!call.sessionActive}
          icon={<Icon icon={IconMicrophone} />}
          pressedIcon={<Icon icon={IconMicrophoneOff} />}
          onPressedChange={call.handleToggleMic}
        />
      ) : null}
      <IconButton
        label={t('@theorem.live.end_call')}
        tooltip={t('@theorem.live.end_call')}
        variant="destructive"
        size="sm"
        isDisabled={!call.sessionActive}
        icon={<Icon icon={IconPhoneOff} />}
        onClick={call.handleEnd}
      />
      <IconButton
        label={t('@theorem.live.expand')}
        tooltip={t('@theorem.live.expand')}
        variant="ghost"
        size="sm"
        icon={<Icon icon={IconArrowsDiagonal} />}
        onClick={onExpand}
      />
    </>
  );
}
