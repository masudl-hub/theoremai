/**
 * The names of the sensitive-data groups and how a profile switches them, apart from the patterns
 * that find them: what reads or shows a profile's settings has no need of the patterns.
 *
 * @module
 */

/**
 * The families of sensitive data, each switched on its own: a profile can
 * redact credentials and card numbers but leave network addresses alone.
 */
const SENSITIVE_GROUPS = [
  'ids',
  'financial',
  'network',
  'credentials',
  'email',
  'phone',
  'bank_account',
] as const;

/**
 * The groups that are data an agent works with (an address to write to, a number to call). They
 * are read and flagged; their matches are taken out only where a profile says so, never by a
 * clean that has no profile in hand.
 */
const WORKING_GROUPS: readonly SensitiveGroup[] = ['email', 'phone', 'bank_account'];

/** The groups a text is cleaned of when no profile says how: every group but the working ones. */
const SCRUBBED_GROUPS: readonly SensitiveGroup[] = SENSITIVE_GROUPS.filter(
  (group) => !WORKING_GROUPS.includes(group),
);

/** A group of sensitive-value checks: ids, financial, network, credentials, email, phone, or bank_account. */
type SensitiveGroup = (typeof SENSITIVE_GROUPS)[number];

/** Per group, whether it runs. A group left out keeps its default. */
type SensitiveSwitches = Partial<Record<SensitiveGroup, boolean>>;

/** `true` runs every group, `false` none; an object switches the groups it names. */
type SensitiveSelection = boolean | SensitiveSwitches;

/** Every group's switch, defaults applied. */
type SensitiveGroups = Readonly<Record<SensitiveGroup, boolean>>;

export type { SensitiveGroup, SensitiveGroups, SensitiveSelection, SensitiveSwitches };
export { SCRUBBED_GROUPS, SENSITIVE_GROUPS, WORKING_GROUPS };
