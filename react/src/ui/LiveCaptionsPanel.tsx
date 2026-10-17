import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { StackItem } from '@astryxdesign/core/Stack';
import { VStack } from '@astryxdesign/core/VStack';
import { IconSubtitles } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import {
  type LiveCaptionState,
  type LiveCaptionTurn,
  liveCaptionStreaming,
  liveCaptionTranscript,
} from '../client/live/live-captions.ts';
import { ChatComposerBar } from './ChatComposerBar.tsx';
import { ChatTranscript } from './ChatTranscript.tsx';
import { TheoremLabelsProvider, useLabels } from './labels-provider.tsx';
import { PanelScroll } from './SidePanel.tsx';

export type LiveCaptionsPanelProps = {
  /** Profile handle. The transcript shows it as the agent's name. */
  handle: string;
  captions: LiveCaptionState;
  pastCalls: readonly (readonly LiveCaptionTurn[])[];
  draftText: string;
  onDraftTextChange: (text: string) => void;
  onSubmit: (text: string) => void;
  /** Off while no call is connected. */
  isDisabled: boolean;
  /** Omit the text field when the profile takes no text. */
  showComposer?: boolean;
  /** Drawn above the transcript. The live runner puts the camera here. */
  leading?: ReactNode;
};

/**
 * The live call's captions: the chat transcript, an empty state, and the text
 * composer. The same panel the live runner docks on the right.
 */
export function LiveCaptionsPanel(props: LiveCaptionsPanelProps) {
  return (
    <TheoremLabelsProvider>
      <LiveCaptionsBody {...props} />
    </TheoremLabelsProvider>
  );
}

function LiveCaptionsBody({
  handle,
  captions,
  pastCalls,
  draftText,
  onDraftTextChange,
  onSubmit,
  isDisabled,
  showComposer = true,
  leading,
}: LiveCaptionsPanelProps) {
  const t = useLabels();
  const agentName = t('@theorem.agent.handle', { handle });
  const { blocks, callStarts } = liveCaptionTranscript(pastCalls, captions);
  const newSession = t('@theorem.live.new_session');
  const dividers = Object.fromEntries(callStarts.map((id) => [id, newSession]));
  const composer = showComposer ? (
    <ChatComposerBar
      handle={handle}
      draftText={draftText}
      onDraftTextChange={onDraftTextChange}
      onSubmit={onSubmit}
      isDisabled={isDisabled}
    />
  ) : null;

  return (
    <VStack height="100%">
      {leading}
      <StackItem size="fill">
        {blocks.length > 0 ? (
          <PanelScroll label={t('@theorem.panel.captions.name')}>
            <ChatTranscript
              blocks={blocks}
              dividers={dividers}
              handle={agentName}
              streaming={liveCaptionStreaming(captions)}
            />
          </PanelScroll>
        ) : (
          <VStack height="100%" vAlign="center" padding={4}>
            <EmptyState
              icon={<Icon icon={IconSubtitles} size="lg" color="secondary" />}
              title={t('@theorem.panel.captions.empty.title')}
              description={t('@theorem.panel.captions.empty.description')}
              isCompact
            />
          </VStack>
        )}
      </StackItem>
      {composer}
    </VStack>
  );
}
