import {
	loadPlaygroundRunPayload,
	readPlaygroundRunIdFromUrl,
} from './client/index';
import { TheorumRunAppView } from './TheorumRunAppView';
import {
	type TheorumRunAppProps,
	useTheorumRunAppModel,
} from './use-theorum-run-app-model';

export type { TheorumRunAppProps };

export function TheorumRunApp({
	missingPayloadHref = '/#playground',
	playgroundHref = '/#playground',
	readRunId = readPlaygroundRunIdFromUrl,
	loadPayload = loadPlaygroundRunPayload,
}: TheorumRunAppProps) {
	const model = useTheorumRunAppModel({
		missingPayloadHref,
		playgroundHref,
		readRunId,
		loadPayload,
	});

	return (
		<>
			<a className="iface-run-link" href={model.playgroundHref}>
				← Playground
			</a>
			<TheorumRunAppView {...model} />
		</>
	);
}
