/**
 * Serialization for guardrail scanning.
 *
 * Detectors work on strings, so non-text event payloads (structured output, tool
 * arguments, grounding metadata) must be flattened before they can be inspected.
 * A guardrail must never be the thing that throws, so this never propagates a
 * serializer error: cycles and bigints are represented rather than fatal, and a
 * payload that still cannot be rendered is reported so the caller can fail closed.
 *
 * @module
 */

/** Marker substituted for a repeated reference so a cycle terminates. */
const CIRCULAR = '[circular]';

/**
 * Best-effort text representation for scanning. `unscannable` is true only when
 * serialization could not safely render the payload for inspection.
 */
export interface ScanText {
  text: string;
  /** True when the payload could not be rendered and was not inspected. */
  unscannable: boolean;
}

/**
 * Flatten an arbitrary payload to text for detector scanning.
 *
 * Cycles collapse to `[circular]` and bigints render as digits, so the common
 * unserializable shapes still get inspected instead of aborting the turn. Only a
 * payload that defeats that (a throwing `toJSON`, for instance) comes back
 * `unscannable`.
 */
function textForScan(value: unknown): ScanText {
  if (value === undefined) {
    return { text: '', unscannable: false };
  }
  if (typeof value === 'string') {
    return { text: value, unscannable: false };
  }
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'bigint') {
        return val.toString();
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return CIRCULAR;
        }
        seen.add(val);
      }
      return val;
    });
    return { text: json ?? '', unscannable: false };
  } catch {
    return { text: '', unscannable: true };
  }
}

/**
 * Scan-ready text, discarding the unscannable signal.
 *
 * For callers whose only question is "does this contain X" and for whom an
 * unrenderable payload is the same as no match.
 */
function scanTextOf(value: unknown): string {
  return textForScan(value).text;
}

export { CIRCULAR, scanTextOf, textForScan };
