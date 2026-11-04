import { Dialog } from '@astryxdesign/core/Dialog';
import type { CSSProperties } from 'react';
import type { LiveCall } from '../components/live/use-live-call.ts';
import { useLabels } from './labels-provider.tsx';
import { ApprovalCard, AuthChallengeCard, GATE_CARD_WIDTH } from './ToolGateCard.tsx';

/** Room around the gate card for its shadow. */
const GATE_DIALOG_PADDING = 4;
const GATE_DIALOG_WIDTH = GATE_CARD_WIDTH + 2 * GATE_DIALOG_PADDING * 4;
/** The dialog draws no surface of its own: the card is the one chat shows, alone. */
const GATE_DIALOG_BARE: CSSProperties = { background: 'transparent', boxShadow: 'none' };

/**
 * Tool approvals and credential prompts, as a dialog that must be answered. It shows the card
 * chat shows inline and nothing else, and closes on the answer. `LiveRunner` and
 * `LiveCallTile` both show it, so a gate is answered wherever the call is drawn.
 */
export function LiveToolGateDialog({ call }: { call: LiveCall }) {
  const t = useLabels();
  const prompt = call.gatePrompt;
  const onResolve = call.resolveGateDecision;
  const agent = t('@theorem.agent.handle', { handle: call.handle });
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
