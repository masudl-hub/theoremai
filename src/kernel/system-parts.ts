import { TheoremError } from '../guardrails/error.ts';
import type { SystemPiece, SystemPrompt } from './types.ts';

/** The system prompt as sent, and the private stretches of it no reply may repeat. */
interface BoundSystem {
  text: string;
  private: readonly string[];
}

const SOURCE_SEPARATOR = '\n\n';

function partProblem(part: unknown): string | undefined {
  if (typeof part === 'string') return undefined;
  if (typeof part !== 'object' || part === null || Array.isArray(part)) {
    return 'must be a string or { private: string }'; // lexicon-exempt: developer contract error
  }
  const keys = Object.keys(part);
  if (keys.length !== 1 || keys[0] !== 'private') {
    return 'must have exactly one key, private'; // lexicon-exempt: developer contract error
  }
  const text = (part as { private: unknown }).private;
  if (typeof text !== 'string') return 'must be a string'; // lexicon-exempt: developer contract error
  if (text === '') return 'must not be empty'; // lexicon-exempt: developer contract error
  return undefined;
}

/** What is wrong with `prompt` as a system prompt, `where` naming it, or undefined. */
function systemPromptProblem(prompt: unknown, where: string): string | undefined {
  if (typeof prompt === 'string') return undefined;
  if (!Array.isArray(prompt)) return `${where} must be a string or an array of parts`; // lexicon-exempt: developer contract error
  if (prompt.length === 0) return `${where} must not be an empty array`; // lexicon-exempt: developer contract error
  for (const [at, part] of prompt.entries()) {
    const problem = partProblem(part);
    if (!problem) continue;
    const path = typeof part === 'object' && part !== null && 'private' in part ? '.private' : '';
    return `${where}[${at}]${path} ${problem}`;
  }
  return undefined;
}

/** `where` names the prompt in the error, e.g. `Profile sol identity.system`. */
function assertSystemPrompt(prompt: unknown, where: string): asserts prompt is SystemPrompt {
  const problem = systemPromptProblem(prompt, where);
  if (problem) throw new TheoremError('config', problem);
}

/** Rewrites each part's text with `rewrite`, keeping its mark. */
function mapSystemPrompt(
  prompt: SystemPrompt,
  where: string,
  rewrite: (text: string) => string,
): SystemPrompt {
  assertSystemPrompt(prompt, where);
  if (typeof prompt === 'string') return rewrite(prompt);
  return prompt.map((part) =>
    typeof part === 'string' ? rewrite(part) : { private: rewrite(part.private) },
  );
}

/** One prompt's pieces: all private unless some part is `{ private }`. */
function systemPieces(prompt: SystemPrompt): SystemPiece[] {
  if (typeof prompt === 'string') return [{ text: prompt, private: true }];
  const marked = prompt.some((part) => typeof part !== 'string');
  return prompt.map((part) =>
    typeof part === 'string'
      ? { text: part, private: !marked }
      : { text: part.private, private: true },
  );
}

/** Joins prompts from different sources a blank line apart, leaving out empty ones. */
function joinSystemPieces(sources: readonly (readonly SystemPiece[])[]): SystemPiece[] {
  const joined: SystemPiece[] = [];
  for (const pieces of sources) {
    if (!pieces.some((piece) => piece.text)) continue;
    if (joined.length > 0) joined.push({ text: SOURCE_SEPARATOR, private: true });
    joined.push(...pieces);
  }
  return joined;
}

function systemText(pieces: readonly SystemPiece[]): string {
  return pieces.map((piece) => piece.text).join('');
}

/**
 * The wire text and its private stretches: private pieces next to each other
 * read as one stretch, since a reply repeating across them repeats private text.
 */
function boundSystem(pieces: readonly SystemPiece[]): BoundSystem {
  const stretches: string[] = [];
  let open = '';
  for (const piece of pieces) {
    if (piece.private) {
      open += piece.text;
      continue;
    }
    if (open.trim()) stretches.push(open);
    open = '';
  }
  if (open.trim()) stretches.push(open);
  return { text: systemText(pieces), private: stretches };
}

/** `pieces` with Theorem's notes after them, each note private whatever the host marked. */
function bindSystem(pieces: readonly SystemPiece[], notes: readonly string[]): BoundSystem {
  return boundSystem(
    joinSystemPieces([pieces, ...notes.map((text) => (text ? [{ text, private: true }] : []))]),
  );
}

export type { BoundSystem };
export {
  assertSystemPrompt,
  bindSystem,
  boundSystem,
  joinSystemPieces,
  mapSystemPrompt,
  systemPieces,
  systemPromptProblem,
  systemText,
};
