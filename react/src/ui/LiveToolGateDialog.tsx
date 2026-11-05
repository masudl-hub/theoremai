import { Dialog } from '@astryxdesign/core/Dialog';
import type { CSSProperties } from 'react';
import type { LiveCall } from '../components/live/use-live-call.ts';
import { useLabels } from './labels-provider.tsx';
import { ApprovalCard, AuthChallengeCard, GATE_CARD_WIDTH } from './ToolGateCard.tsx';

/** The dialog takes the card's corner (the bubble's --radius-chat), so none of its surface shows past the card. */
const GATE_DIALOG_CORNER: CSSProperties = {
  borderRadius: 'var(--radius-chat, var(--radius-container))',
};

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
      // why: The card is the one chat shows, a tint made for a page. The dialog's own surface,
      // the card's size and radius, is that page; over the bare backdrop the tint goes grey.
      width={GATE_CARD_WIDTH}
      padding={0}
      style={GATE_DIALOG_CORNER}
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
