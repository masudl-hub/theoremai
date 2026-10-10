import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Center } from '@astryxdesign/core/Center';
import { Dialog } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Toolbar } from '@astryxdesign/core/Toolbar';
import type { DefinedTheme } from '@astryxdesign/core/theme';
import { VStack } from '@astryxdesign/core/VStack';
import {
  IconCameraRotate,
  IconMessage,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhone,
  IconPhoneOff,
  IconVideo,
  IconVideoOff,
} from '@tabler/icons-react';
import type { LiveProfileInterface } from '@theoremjs/agents/interface';
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import type { LiveCallOptions } from '../client/live/live-page-tool.ts';
import type { LiveToolGatePrompt } from '../client/live/live-tool.ts';
import type { LiveFacingMode } from '../client/live/live-video.ts';
import type { LiveConnection } from '../client/live-client.ts';
import type { ToolGateResolution } from '../client/tool-resume.ts';
import { InkWaveform } from '../components/InkWaveform.tsx';
import { useLiveRunnerModel } from '../components/live/use-live-runner-model.ts';
import { LiveCaptionsPanel } from './LiveCaptionsPanel.tsx';
import { liveStateLabel, type TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import {
  PANEL_BOTTOM,
  PANEL_EDGE,
  SidePanel,
  SidePanelHeader,
  SidePanelToggle,
  useSidePanel,
} from './SidePanel.tsx';
import { DEFAULT_CHAT_MAX_WIDTH } from './TheoremChat.tsx';
import { ApprovalCard, AuthChallengeCard, GATE_CARD_WIDTH } from './ToolGateCard.tsx';
import { useTraceInspector, WithTrace } from './TraceInspectorPanel.tsx';
import { TheoremThemeProvider } from './theme.tsx';

export type LiveRunnerProps = {
  iface: LiveProfileInterface;
  /** What the call opens: a profile the host registered, or an open message for the relay. */
  connection: () => LiveConnection | Promise<LiveConnection>;
  /** Astryx theme, as on `TheoremChat`. Omit to inherit the host's `<Theme>` or use `theoremTheme`. */
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  /** Replacement lines by locale, as on `TheoremChat`. */
  labels?: TheoremLabels;
  /**
   * Drive the trace from the host's own control. The built-in toggle hides.
   * The open trace takes the call's place, unless this page is inside
   * `TracePlacement value="panel"`, where it docks. Omit to keep the toggle.
   * Needs a profile that records traces.
   */
  trace?: boolean;
} & LiveCallOptions;

type LiveModel = ReturnType<typeof useLiveRunnerModel>;

/** The waveform's box: it rests on the stage floor rather than filling the stage. */
const WAVE_MAX_WIDTH = 720;
const WAVE_HEIGHT = 320;

/**
 * Live (voice / video) runner on Astryx. Before a call: a landing like the
 * chat's, offering a voice or video call. In a call: the agent tag and state
 * over the ink waveform, captions in a right-hand chat column, call controls
 * in a toolbar, and tool gates in a dialog. Offers the trace inspector when
 * the profile records traces.
 */
export function LiveRunner({ theme, mode, labels, ...props }: LiveRunnerProps) {
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <LiveRunnerBody {...props} />
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}

function LiveRunnerBody({
  iface,
  connection,
  trace,
  slots,
  context,
  pageTools,
}: Omit<LiveRunnerProps, 'theme' | 'mode' | 'labels'>) {
  const t = useLabels();
  const model = useLiveRunnerModel(iface, connection, { slots, context, pageTools });
  // why: Both panels size against the whole live layout, so a third means the same for each.
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const inspector = useTraceInspector(iface, model.traces, trace);
  const captions = useSidePanel(layoutRef, true);
  const captionLabels = {
    name: t('@theorem.panel.captions.name'),
    show: t('@theorem.panel.captions.show'),
    hide: t('@theorem.panel.captions.hide'),
    resize: t('@theorem.panel.captions.resize'),
  };
  const captionsToggle = (
    <SidePanelToggle
      labels={captionLabels}
      icon={<Icon icon={IconMessage} />}
      panelId={captions.id}
      open={captions.open}
      onToggle={captions.toggle}
    />
  );

  if (!model.callStarted) {
    return (
      <WithTrace inspector={inspector}>
        <Layout
          ref={layoutRef}
          height="fill"
          header={<SidePanelHeader>{inspector.toggle}</SidePanelHeader>}
          content={
            <LayoutContent padding={0}>
              <LiveLanding model={model} />
            </LayoutContent>
          }
        />
      </WithTrace>
    );
  }

  return (
    <>
      <WithTrace inspector={inspector}>
        <Layout
          ref={layoutRef}
          height="fill"
          header={<SidePanelHeader>{inspector.toggle}</SidePanelHeader>}
          content={
            <LayoutContent padding={0}>
              <Layout
                height="fill"
                end={
                  <SidePanel
                    id={captions.id}
                    labels={captionLabels}
                    resizable={captions.resizable}
                    open={captions.open}
                  >
                    <LiveCaptions model={model} />
                  </SidePanel>
                }
                content={
                  <LayoutContent padding={0}>
                    <VStack height="100%" paddingInline={PANEL_EDGE} paddingBlockEnd={PANEL_BOTTOM}>
                      <LiveStage model={model} captionsToggle={captionsToggle} />
                    </VStack>
                  </LayoutContent>
                }
              />
            </LayoutContent>
          }
        />
      </WithTrace>
      <LiveToolGateDialog
        prompt={model.gatePrompt}
        agent={t('@theorem.agent.handle', { handle: model.handle })}
        onResolve={model.resolveGateDecision}
      />
    </>
  );
}

/**
 * Before a call: the chat landing's greeting, with call buttons where the
 * composer would be. Video starts camera and mic together.
 */
function LiveLanding({ model }: { model: LiveModel }) {
  const t = useLabels();
  return (
    <VStack minHeight="100%" vAlign="center" gap={8} paddingInline={3}>
      <Center axis="horizontal" width="100%">
        <VStack width="100%" maxWidth={DEFAULT_CHAT_MAX_WIDTH} gap={8}>
          <VStack gap={1}>
            <Text type="large" as="h2">
              {t('@theorem.agent.handle', { handle: model.handle })}
            </Text>
            <Text type="display-2" as="h1">
              {t('@theorem.live.greeting')}
            </Text>
          </VStack>
          <HStack gap={2} wrap="wrap">
            <Button
              label={t(
                model.voiceAvailable
                  ? '@theorem.live.start_voice_call'
                  : '@theorem.live.start_call',
              )}
              variant="primary"
              icon={<Icon icon={IconPhone} />}
              onClick={() => model.startCall({ video: false })}
            />
            {model.videoAvailable ? (
              <Button
                label={t('@theorem.live.start_video_call')}
                variant="secondary"
                icon={<Icon icon={IconVideo} />}
                onClick={() => model.startCall({ video: true })}
              />
            ) : null}
          </HStack>
        </VStack>
      </Center>
    </VStack>
  );
}

/**
 * The agent tag and state over the resting waveform, then the call controls,
 * all in one column the waveform's width.
 */
function LiveStage({ model, captionsToggle }: { model: LiveModel; captionsToggle: ReactNode }) {
  const t = useLabels();
  const ref = useEnterMotion<HTMLElement>();
  return (
    <VStack ref={ref} height="100%" hAlign="center">
      <VStack width="100%" maxWidth={WAVE_MAX_WIDTH} height="100%" gap={3}>
        <VStack gap={0.5}>
          <Text type="label" color="secondary">
            {t('@theorem.agent.handle', { handle: model.handle })}
          </Text>
          <Text size="sm" color="secondary">
            {liveStateLabel(t, model.liveState, model.activeTool)}
          </Text>
        </VStack>
        {model.failure ? <Banner status="error" title={model.failure.error} /> : null}
        {model.sessionEnded ? <Banner status="info" title={model.sessionEnded} /> : null}
        <StackItem size="fill">
          <VStack height="100%" vAlign="end">
            {/* why: Bars stand on the stage floor, in the icon colour (no Stack colour prop). */}
            <VStack
              width="100%"
              height={WAVE_HEIGHT}
              style={{ color: 'var(--color-icon-primary)' }}
              aria-hidden="true"
            >
              <InkWaveform
                status={model.status}
                levelsRef={model.levelsRef}
                toolActive={model.toolActive}
                variant="hero"
              />
            </VStack>
          </VStack>
        </StackItem>
        <LiveControls model={model} captionsToggle={captionsToggle} />
      </VStack>
    </VStack>
  );
}

/**
 * Eases the call view in from the landing: Astryx has no enter-transition
 * helper, so this animates with its `--duration-medium` / `--ease-standard`.
 */
function useEnterMotion<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const tokens = getComputedStyle(el);
    const duration = Number.parseFloat(tokens.getPropertyValue('--duration-medium')) || 410;
    el.animate(
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration, easing: tokens.getPropertyValue('--ease-standard').trim() || 'ease-out' },
    );
  }, []);
  return ref;
}

/**
 * Mic, camera, captions and call controls, centred under the stage. Icons show
 * what a click does, as End call does: a slash means "turn this off".
 */
function LiveControls({ model, captionsToggle }: { model: LiveModel; captionsToggle: ReactNode }) {
  const t = useLabels();
  const inactive = !model.sessionActive;
  const controls: ReactNode[] = [];

  if (model.voiceAvailable) {
    controls.push(
      <ToggleButton
        key="mic"
        label={t('@theorem.live.microphone')}
        tooltip={t(model.isMuted ? '@theorem.live.unmute' : '@theorem.live.mute')}
        isIconOnly
        isPressed={!model.isMuted}
        isDisabled={inactive}
        icon={<Icon icon={IconMicrophone} />}
        pressedIcon={<Icon icon={IconMicrophoneOff} />}
        onPressedChange={model.handleToggleMic}
      />,
    );
  }
  if (model.videoAvailable) {
    controls.push(
      <ToggleButton
        key="video"
        label={t('@theorem.live.camera')}
        tooltip={t(model.isVideoOn ? '@theorem.live.camera_off' : '@theorem.live.camera_on')}
        isIconOnly
        isPressed={model.isVideoOn}
        isDisabled={inactive}
        icon={<Icon icon={IconVideo} />}
        pressedIcon={<Icon icon={IconVideoOff} />}
        onPressedChange={() => {
          void model.handleToggleVideo();
        }}
      />,
    );
    if (model.isVideoOn) {
      controls.push(
        <IconButton
          key="flip"
          label={t('@theorem.live.flip_camera')}
          tooltip={t('@theorem.live.flip_camera')}
          variant="ghost"
          isDisabled={inactive}
          icon={<Icon icon={IconCameraRotate} />}
          onClick={() => {
            void model.handleFlipCamera();
          }}
        />,
      );
    }
  }
  controls.push(
    <Fragment key="captions">{captionsToggle}</Fragment>,
    model.canRestart ? (
      <IconButton
        key="call"
        label={t('@theorem.live.start_call')}
        tooltip={t('@theorem.live.start_call')}
        variant="primary"
        icon={<Icon icon={IconPhone} />}
        onClick={() => {
          void model.handleRestart();
        }}
      />
    ) : (
      <IconButton
        key="call"
        label={t('@theorem.live.end_call')}
        tooltip={t('@theorem.live.end_call')}
        variant="destructive"
        isDisabled={inactive}
        icon={<Icon icon={IconPhoneOff} />}
        onClick={model.handleEnd}
      />
    ),
  );

  return (
    <Toolbar
      label={t('@theorem.live.controls')}
      dividers={['top']}
      centerContent={
        <HStack gap={2} vAlign="center">
          {controls}
        </HStack>
      }
    />
  );
}

/**
 * Captions drawn by the chat's own transcript, with the text composer in its
 * dock when the profile takes text.
 */
function LiveCaptions({ model }: { model: LiveModel }) {
  return (
    <LiveCaptionsPanel
      handle={model.handle}
      captions={model.captions}
      pastCalls={model.pastCalls}
      draftText={model.textDraft}
      onDraftTextChange={model.setTextDraft}
      onSubmit={model.handleSendText}
      isDisabled={!model.sessionActive}
      showComposer={model.textAvailable}
      leading={
        model.videoPreview ? (
          <LiveVideoPreview video={model.videoPreview} facingMode={model.videoFacingMode} />
        ) : null
      }
    />
  );
}

/**
 * The camera preview, at the top of the captions panel. The capture element comes
 * from the session client, so it is mounted imperatively; it sits one level
 * below AspectRatio, so it carries its own fill and mirror styles.
 */
function LiveVideoPreview({
  video,
  facingMode,
}: {
  video: HTMLVideoElement;
  facingMode: LiveFacingMode;
}) {
  const t = useLabels();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    Object.assign(video.style, {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      display: 'block',
    });
    host.replaceChildren(video);
    return () => {
      if (video.parentElement === host) host.removeChild(video);
    };
  }, [video]);

  useEffect(() => {
    video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : '';
  }, [video, facingMode]);

  return (
    <AspectRatio ratio={4 / 3} fit="cover">
      <div ref={hostRef} aria-label={t('@theorem.live.camera_preview')} role="img" />
    </AspectRatio>
  );
}

/** Room around the gate card for its shadow. */
const GATE_DIALOG_PADDING = 4;
const GATE_DIALOG_WIDTH = GATE_CARD_WIDTH + 2 * GATE_DIALOG_PADDING * 4;
/** The dialog draws no surface of its own: the card is the one chat shows, alone. */
const GATE_DIALOG_BARE: CSSProperties = { background: 'transparent', boxShadow: 'none' };

/**
 * Tool approvals and credential prompts, as a dialog that must be answered. It shows the card
 * chat shows inline and nothing else, and closes on the answer.
 */
function LiveToolGateDialog({
  prompt,
  agent,
  onResolve,
}: {
  prompt: LiveToolGatePrompt | null;
  agent: string;
  onResolve: (resolution: ToolGateResolution) => void;
}) {
  return (
    <Dialog
      isOpen={prompt !== null}
      purpose="required"
      width={GATE_DIALOG_WIDTH}
      padding={GATE_DIALOG_PADDING}
      style={GATE_DIALOG_BARE}
      // why: "required" disables dismissal; should one slip through, it denies.
      onOpenChange={(open) => {
        if (!open) onResolve({ action: 'deny' });
      }}
    >
      {prompt ? (
        prompt.gate.kind === 'auth' ? (
          <AuthChallengeCard
            gate={prompt.gate}
            toolName={prompt.gate.tool}
            onAuthenticated={(secret) => {
              onResolve({ action: 'auth', secret });
            }}
          />
        ) : (
          <ApprovalCard
            gate={prompt.gate}
            toolName={prompt.gate.tool}
            agent={agent}
            input={prompt.input}
            onDecision={(action) => {
              onResolve({ action });
            }}
          />
        )
      ) : null}
    </Dialog>
  );
}
