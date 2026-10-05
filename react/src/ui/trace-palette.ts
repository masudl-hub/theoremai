/**
 * The trace panel's colours, taken from Theorem's landscape stills rather than
 * the stock hues: deep royal navy, antique brass, fjord teal, heather, warm
 * stone, and moss and oxblood kept for how a step ended. Each is a
 * light-dark pair, deep in light mode and softened, not brightened, in dark.
 *
 * @module
 */

export const TRACE_HUE = {
  /** Royal navy: the model. */
  navy: 'light-dark(#152350, #2b4596)',
  /** Antique brass: tools. */
  brass: 'light-dark(#6f5520, #b39150)',
  /** Deep fjord teal: the host. */
  fjord: 'light-dark(#24595c, #5f9a9c)',
  /** Moss green: what succeeded. */
  moss: 'light-dark(#3d5f2c, #7c9f5a)',
  /** Heather: Theorem itself (guardrails, gates, the turn). */
  heather: 'light-dark(#54447e, #9585bf)',
  /** Warm stone: the person, and time nothing else accounts for. */
  stone: 'light-dark(#6d6861, #a39d93)',
  /** Oxblood: whatever failed. */
  oxblood: 'light-dark(#8e2a28, #cd5f55)',
} as const;
