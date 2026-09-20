import {
	loadPlaygroundRunPayload,
	readPlaygroundRunIdFromUrl,
} from './client/index';
import { TheoremRunAppView } from './TheoremRunAppView';
import {
	type TheoremRunAppProps,
	useTheoremRunAppModel,
} from './use-theorem-run-app-model';

export type { TheoremRunAppProps };

export function TheoremRunApp({
	missingPayloadHref = '/#playground',
	playgroundHref = '/#playground',
	readRunId = readPlaygroundRunIdFromUrl,
	loadPayload = loadPlaygroundRunPayload,
}: TheoremRunAppProps) {
	const model = useTheoremRunAppModel({
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
			<TheoremRunAppView {...model} />
		</>
	);
}
