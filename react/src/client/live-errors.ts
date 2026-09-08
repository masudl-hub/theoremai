/** Whether a DOM/media error indicates the user denied microphone access. */
export function isPermissionDeniedError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const name = 'name' in err && typeof err.name === 'string' ? err.name : '';
	return (
		name === 'NotAllowedError' ||
		name === 'PermissionDeniedError' ||
		/permission|not allowed|denied/i.test(err.message)
	);
}
