import type { PlaygroundRunPayload } from '../run-payload';

export async function postPlaygroundJson<T>(
	url: string,
	body: unknown,
	failureLabel: string,
): Promise<T> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(payload.error ?? `${failureLabel} (${String(response.status)})`);
	}

	return (await response.json()) as T;
}

export async function registerPlaygroundLiveProfile(
	payload: PlaygroundRunPayload,
): Promise<string> {
	const data = await postPlaygroundJson<{ profileId: string }>(
		'/api/playground/live/register',
		{
			profile: payload.profile,
			customTools: payload.customTools,
		},
		'Live register failed',
	);
	return data.profileId;
}
