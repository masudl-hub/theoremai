import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { VStack } from '@astryxdesign/core/VStack';
import { IconTimeline } from '@tabler/icons-react';
import type { ReactNode, RefObject } from 'react';
import type { ProfileObservabilityView } from '../../../src/interface/mod.ts';
import { useLabels } from './labels-provider';
import { SidePanel, SidePanelToggle, useSidePanel } from './SidePanel';

/**
 * The trace inspector, offered when the profile records traces: a header
 * toggle and a Layout `end` panel, closed at first. Turn traces are not wired
 * yet, so the panel shows its empty state.
 */
export function useTraceInspector(
	iface: { observability?: ProfileObservabilityView },
	layoutRef: RefObject<HTMLDivElement | null>,
): { toggle: ReactNode; panel: ReactNode } {
	const t = useLabels();
	const { id, open, toggle, resizable } = useSidePanel(layoutRef, false);
	const labels = {
		name: t('@theorem.panel.trace.name'),
		show: t('@theorem.panel.trace.show'),
		hide: t('@theorem.panel.trace.hide'),
		resize: t('@theorem.panel.trace.resize'),
	};
	if (iface.observability?.record !== true) return { toggle: null, panel: null };
	return {
		toggle: <SidePanelToggle labels={labels} icon={<Icon icon={IconTimeline} />} panelId={id} open={open} onToggle={toggle} />,
		panel: (
			<SidePanel id={id} labels={labels} resizable={resizable} open={open}>
				<VStack height="100%" vAlign="center">
					<EmptyState
						icon={<Icon icon={IconTimeline} size="lg" color="secondary" />}
						title={t('@theorem.panel.trace.empty.title')}
						description={t('@theorem.panel.trace.empty.description')}
						isCompact
					/>
				</VStack>
			</SidePanel>
		),
	};
}
