import { Center } from '@astryxdesign/core/Center';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { IconPlugConnectedX } from '@tabler/icons-react';

/** Shown in place of the studio when no local server has a project open. */
export function StudioNoProject() {
	return (
		<Center style={{ height: '100%' }}>
			<EmptyState
				headingLevel={1}
				icon={<Icon icon={IconPlugConnectedX} size="lg" />}
				title="No project is open"
				description="Start the studio server in your project (studio/server/serve.ts with your setup file), then reload."
			/>
		</Center>
	);
}
