const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Compact relative time label for transcript chrome (e.g. "3m ago"). */
export function formatRelativeTime(at: number, now = Date.now()): string {
	const age = Math.max(0, now - at);
	if (age < MINUTE_MS) return 'just now';
	const min = Math.floor(age / MINUTE_MS);
	if (min < 60) return `${String(min)}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${String(hr)}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${String(day)}d ago`;
	return new Date(at).toLocaleDateString();
}

/** Ms until `formatRelativeTime` would return a different label. */
export function msUntilRelativeTimeChange(at: number, now = Date.now()): number {
	const age = Math.max(0, now - at);
	if (age < MINUTE_MS) return MINUTE_MS - age;
	if (age < HOUR_MS) return MINUTE_MS - (age % MINUTE_MS);
	if (age < DAY_MS) return HOUR_MS - (age % HOUR_MS);
	if (age < WEEK_MS) return DAY_MS - (age % DAY_MS);
	return DAY_MS - (age % DAY_MS);
}
