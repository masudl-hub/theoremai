import { Card } from '@astryxdesign/core/Card';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { LayoutHeader, LayoutPanel } from '@astryxdesign/core/Layout';
import {
	ResizeHandle,
	type ResizableRegion,
	type UseResizableSingleConfig,
	useResizable,
} from '@astryxdesign/core/Resizable';
import { VStack } from '@astryxdesign/core/VStack';
import { type ReactNode, type RefObject, useCallback, useId, useState } from 'react';

/**
 * `useResizable` sizing for side panels: a third of the layout (pass the
 * Layout as `containerRef` so the percentages resolve), dragged between a
 * readable minimum and half.
 */
const SIDE_PANEL_SIZING = {
	defaultSize: '33%',
	minSize: 280,
	maxSize: '50%',
} as const satisfies UseResizableSingleConfig;

/** Whether a side panel is wide enough for two readable columns: twice its minimum. */
export function isSidePanelWide(size: number): boolean {
	return size >= SIDE_PANEL_SIZING.minSize * 2;
}

/** A side panel's open state and size. `containerRef` is the Layout its percentages resolve against. */
export function useSidePanel(containerRef: RefObject<HTMLDivElement | null>, initiallyOpen: boolean) {
	const id = useId();
	const [open, setOpen] = useState(initiallyOpen);
	const toggle = useCallback(() => setOpen((value) => !value), []);
	const resizable = useResizable({ ...SIDE_PANEL_SIZING, containerRef });
	return { id, open, toggle, resizable };
}

/** The Layout header row: side panel toggles, at the end. */
export function SidePanelHeader({ children }: { children?: ReactNode }) {
	return (
		<LayoutHeader hasDivider={false}>
			<HStack hAlign="end" gap={1}>
				{children}
			</HStack>
		</LayoutHeader>
	);
}

/** A side panel's words: its name, and its toggle and drag handle actions. */
export type SidePanelLabels = { name: string; show: string; hide: string; resize: string };

/** Shows or hides one side panel (`panelId` from useSidePanel). */
export function SidePanelToggle({
	labels,
	icon,
	panelId,
	open,
	onToggle,
}: {
	labels: SidePanelLabels;
	icon: ReactNode;
	panelId: string;
	open: boolean;
	onToggle: () => void;
}) {
	const action = open ? labels.hide : labels.show;
	return (
		<IconButton
			label={action}
			tooltip={action}
			variant="ghost"
			aria-expanded={open}
			aria-controls={panelId}
			icon={icon}
			onClick={onToggle}
		/>
	);
}

export type SidePanelProps = {
	id?: string;
	labels: SidePanelLabels;
	/** From `useResizable`: the panel's width and its handle's drag state. */
	resizable: ResizableRegion;
	/**
	 * Closed panels stay mounted at zero width and inert, so the theme can ease
	 * their width; their content renders only while open, so it never reflows
	 * into the collapsing width.
	 */
	open?: boolean;
	/** Card padding; 0 for content that brings its own (e.g. ChatLayout). */
	padding?: 0;
	children?: ReactNode;
};

/**
 * A Layout `end` panel as Astryx's IDE template builds one (a reversed
 * `ResizeHandle` before a `LayoutPanel` sized by `useResizable`), holding a
 * raised card inset from the layout edge and bottom instead of a flat pane.
 * For more than one panel, nest Layouts, one panel each, as the template does.
 */
export function SidePanel({ id, labels, resizable, open = true, padding, children }: SidePanelProps) {
	return (
		<>
			{open ? (
				<ResizeHandle
					direction="horizontal"
					isReversed
					hasDivider={false}
					isAlwaysVisible={false}
					resizable={resizable.props}
					label={labels.resize}
				/>
			) : null}
			<LayoutPanel
				id={id}
				label={labels.name}
				role="complementary"
				width={open ? resizable.size : 0}
				hasDivider={false}
				padding={0}
				isScrollable={false}
				inert={!open}
			>
				<VStack height="100%" paddingInlineEnd={3} paddingBlockEnd={3}>
					<Card elevation="med" height="100%" padding={padding}>
						{open ? children : null}
					</Card>
				</VStack>
			</LayoutPanel>
		</>
	);
}
