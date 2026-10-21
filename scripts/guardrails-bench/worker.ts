/// <reference lib="deno.worker" />
/** labels-exempt-file: benchmark runner — not runtime user or model copy (P2) */

import type { ProbeOutcome } from '../../studio/guardrail-bench.ts';
import type { ProbeBoundary } from '../../studio/guardrail-probe.ts';
import { benchAgent, probeOne } from './probe.ts';

export interface BatchRequest {
  batch: number;
  boundary: ProbeBoundary;
  samples: { text: string; system?: string }[];
}

export type BatchReply =
  | { batch: number; outcomes: ProbeOutcome[] }
  | { batch: number; error: string };

const agent = benchAgent();

self.onmessage = async (message: MessageEvent<BatchRequest>) => {
  const { batch, boundary, samples } = message.data;
  try {
    const outcomes: ProbeOutcome[] = [];
    for (const { text, system } of samples) {
      outcomes.push(await probeOne(agent, boundary, text, system));
    }
    self.postMessage({ batch, outcomes } satisfies BatchReply);
  } catch (error) {
    self.postMessage({
      batch,
      error: error instanceof Error ? error.message : String(error),
    } satisfies BatchReply);
  }
};
