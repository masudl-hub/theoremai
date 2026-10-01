const CIRCULAR = '[circular]';

export interface ScanText {
  text: string;
  /** True when the payload could not be rendered and was not inspected. */
  unscannable: boolean;
}

/**
 * A guardrail must never be the thing that throws: cycles and bigints still get inspected, and
 * only a payload that defeats that (a throwing `toJSON`) comes back `unscannable` so the caller can fail closed.
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

/** Discards `unscannable`: only for callers to whom an unrenderable payload is the same as no match. */
function scanTextOf(value: unknown): string {
  return textForScan(value).text;
}

export { CIRCULAR, scanTextOf, textForScan };
