/**
 * Stress / matrix turn synthesis for the THEORUM CLI.
 *
 * Custom tools come from `profile.tools.allow` (visibility via loadTier).
 * Provider builtins come from `model.config.*.builtInTools`. `--search` /
 * `--map` only verify those ids are listed on the selected model.
 *
 * @module
 */

import type { Profile, TurnBlob, TurnRequest } from '../../kernel/types.ts';
import { FIXTURE_PNG_BASE64, FIXTURE_WAV_BASE64, getFixtureForMime } from './fixtures.ts';

export interface MatrixOptions {
  lite?: boolean;
  /** Requires googleSearch on the selected model's builtInTools. */
  search?: boolean;
  /** Requires googleMaps on the selected model's builtInTools. */
  map?: boolean;
  mode?: string;
  attachmentPaths?: string[];
  voicePath?: string;
}

export function synthesizeLiteCombo(profile: Profile): TurnRequest {
  const select = profile.model.select?.fast ? 'fast' : undefined;
  return {
    profile: profile.id,
    select,
    input: {
      text: `Ping test for profile ${profile.id}. Respond concisely with confirmation.`,
    },
  };
}

function resolveStressReasoning(profile: Profile): string | undefined {
  if (profile.model.select?.smart) {
    return 'smart';
  }
  if (profile.model.select) {
    const keys = Object.keys(profile.model.select);
    return keys[keys.length - 1];
  }
  return undefined;
}

function resolveStressAttachments(profile: Profile): TurnBlob[] {
  if (profile.type === 'speech' || !profile.inputs) {
    return [];
  }
  const attachments: TurnBlob[] = [];
  const accept = profile.inputs.attachments?.accept;
  if (accept && accept.length > 0) {
    const preferredMimes = ['image/png', 'application/pdf', 'text/plain'];
    const chosenMime = preferredMimes.find((m) => accept.includes(m)) ?? accept[0];
    const fixture = getFixtureForMime(chosenMime);
    if (fixture) {
      attachments.push(fixture);
    } else {
      attachments.push({ mimeType: 'image/png', data: FIXTURE_PNG_BASE64 });
    }
  }
  return attachments;
}

function resolveStressVoice(profile: Profile): TurnBlob[] {
  if (profile.type === 'speech' || !profile.inputs) {
    return [];
  }
  const voice: TurnBlob[] = [];
  if (profile.inputs.voice?.accept && profile.inputs.voice.accept.length > 0) {
    voice.push({ mimeType: 'audio/wav', data: FIXTURE_WAV_BASE64 });
  }
  return voice;
}

export function synthesizeStressCombo(profile: Profile): TurnRequest {
  const select = resolveStressReasoning(profile);
  const attachments = resolveStressAttachments(profile);
  const voice = resolveStressVoice(profile);
  const promptText = `Execute comprehensive test turn for profile ${profile.id}. Validate all instructions and produce required outputs.`;

  return {
    profile: profile.id,
    select,
    input: {
      text: promptText,
      attachments: attachments.length > 0 ? attachments : undefined,
      voice: voice.length > 0 ? voice : undefined,
    },
  };
}

export function synthesizeMatrixCombos(
  profile: Profile,
): Array<{ name: string; req: TurnRequest }> {
  return [
    {
      name: 'Lite (connectivity)',
      req: synthesizeLiteCombo(profile),
    },
    {
      name: 'Stress (all modalities + primary tools)',
      req: synthesizeStressCombo(profile),
    },
  ];
}

/** Ensure CLI grounding flags match model builtInTools. */
function assertGroundingFlagsOnModel(profile: Profile, options: MatrixOptions): void {
  const select = options.mode ?? (profile.model.select?.fast ? 'fast' : undefined);
  const modelId =
    select && profile.model.select?.[select]
      ? profile.model.select[select]
      : profile.model.allow[0];
  const builtins = new Set(profile.model.config[modelId]?.builtInTools ?? []);
  if (options.search === true && !builtins.has('googleSearch')) {
    throw new Error(`--search requires googleSearch on model.config.${modelId}.builtInTools`);
  }
  if (options.map === true && !builtins.has('googleMaps')) {
    throw new Error(`--map requires googleMaps on model.config.${modelId}.builtInTools`);
  }
}

export function buildCustomTurnRequest(profile: Profile, options: MatrixOptions): TurnRequest {
  if (options.lite) {
    return synthesizeLiteCombo(profile);
  }

  const base = synthesizeStressCombo(profile);
  if (options.mode) {
    base.select = options.mode;
  }

  if (options.search !== undefined || options.map !== undefined) {
    assertGroundingFlagsOnModel(profile, options);
  }

  return base;
}
