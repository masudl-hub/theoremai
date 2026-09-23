/**
 * Structured output parse shared by every provider that asks for JSON text.
 *
 * @module
 */

export type ParsedStructuredOutput =
  | { ok: true; structured: unknown }
  | { ok: false; error: string };

/** Parse model text as structured JSON. Invalid JSON is a hard failure — never silent skip. */
function parseStructuredOutput(text: string): ParsedStructuredOutput {
  try {
    return { ok: true, structured: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'structured output was not valid JSON' }; // lexicon-exempt: developer contract / internal diagnostic — not end-user or model copy (P2)
  }
}

export { parseStructuredOutput };
