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
const SENSITIVE_GROUPS = ['ids', 'financial', 'network', 'credentials'] as const;

/** A group of sensitive-value checks: ids, financial, network, or credentials. */
type SensitiveGroup = (typeof SENSITIVE_GROUPS)[number];

/** Per group, whether it runs. A group left out keeps its default. */
type SensitiveSwitches = Partial<Record<SensitiveGroup, boolean>>;

/** `true` runs every group, `false` none; an object switches the groups it names. */
type SensitiveSelection = boolean | SensitiveSwitches;

/** Every group's switch, defaults applied. */
type SensitiveGroups = Readonly<Record<SensitiveGroup, boolean>>;

export type { SensitiveGroup, SensitiveGroups, SensitiveSelection, SensitiveSwitches };
export { SENSITIVE_GROUPS };
