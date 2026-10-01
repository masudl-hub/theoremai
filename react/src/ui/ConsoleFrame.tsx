import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useLabels } from './labels-provider.tsx';
import { RAISED, SidePanelHeader } from './SidePanel.tsx';
import { type TraceInspector, WithTrace } from './TraceInspectorPanel.tsx';

export type ConsoleFrameProps = {
	inspector: TraceInspector;
	maxWidth: string;
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
};

/**
 * A console's page, for decisions and hosts alike: the trace's toggle in the
 * header, and one raised panel, flush with the host's, scrolling inside.
 */
export function ConsoleFrame({ inspector, maxWidth, className, style, children }: ConsoleFrameProps) {
	return (
		<WithTrace inspector={inspector}>
			<Layout
				height="fill"
				className={className}
				style={style}
				header={inspector.toggle ? <SidePanelHeader>{inspector.toggle}</SidePanelHeader> : undefined}
				content={
					<LayoutContent padding={0} isScrollable={false}>
						<VStack height="100%" paddingInline={3}>
							<Card variant="transparent" height="100%" padding={0} style={{ ...RAISED, overflowY: 'auto' }}>
								<Center axis="horizontal" width="100%">
									<VStack width="100%" maxWidth={maxWidth} gap={3} padding={4}>
										{children}
									</VStack>
								</Center>
							</Card>
						</VStack>
					</LayoutContent>
				}
			/>
		</WithTrace>
	);
}

/** ⌘/Ctrl+Enter runs the console's request. */
function runShortcut(run: () => void): (event: KeyboardEvent) => void {
	return (event) => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			run();
		}
	};
}

export type ConsoleView = 'fields' | 'json';

export type RequestCardProps = {
	title: string;
	/** The view shown: fields only while the request parses. */
	view: ConsoleView;
	hasFields: boolean;
	onView: (next: ConsoleView) => void;
	/** Runs on ⌘/Ctrl+Enter anywhere in the card. */
	onRun: () => void;
	children: ReactNode;
};

/** The request's card: its heading with the Fields/JSON switch, then the request and its run bar. */
export function RequestCard({ title, view, hasFields, onView, onRun, children }: RequestCardProps) {
	const t = useLabels();
	return (
		<Card variant="muted" padding={4} style={{ background: 'var(--color-background-surface)' }}>
			<VStack gap={3} onKeyDown={runShortcut(onRun)}>
				<HStack gap={2} hAlign="between" vAlign="center">
					<Text type="supporting" color="secondary" as="h3">
						{title}
					</Text>
					<SegmentedControl
						label={t('@theorem.decision.view')}
						size="sm"
						value={view}
						onChange={(next) => {
							onView(next === 'json' ? 'json' : 'fields');
						}}
					>
						<SegmentedControlItem value="fields" label={t('@theorem.decision.fields')} isDisabled={!hasFields} />
						<SegmentedControlItem value="json" label={t('@theorem.data.json')} />
					</SegmentedControl>
				</HStack>
				{children}
			</VStack>
		</Card>
	);
}

/** The field reads as code: the body font is swapped for the code font inside it. */
const CODE_FONT = { '--font-family-body': 'var(--font-family-code)' } as CSSProperties;

/** The request as JSON text, marked while it doesn't parse. */
export function JsonRequest({ label, text, isInvalid, onChange }: { label: string; text: string; isInvalid: boolean; onChange: (next: string) => void }) {
	return (
		<TextArea
			label={label}
			isLabelHidden
			value={text}
			onChange={onChange}
			rows={8}
			hasSpellCheck={false}
			status={isInvalid ? { type: 'error' } : undefined}
			style={CODE_FONT}
		/>
	);
}

export type RunBarProps = {
	/** The shortcut, or what the request still lacks. */
	note: string | null;
	isReady: boolean;
	isRunning: boolean;
	runLabel: string;
	runningLabel: string;
	stopLabel: string;
	onRun: () => void;
	onStop: () => void;
};

/** A note on the request, Stop while it runs, and Run. */
export function RunBar({ note, isReady, isRunning, runLabel, runningLabel, stopLabel, onRun, onStop }: RunBarProps) {
	return (
		<HStack gap={3} hAlign="between" vAlign="center">
			<Text type="supporting" color="secondary" style={isReady ? undefined : { color: 'var(--color-error)' }} hasTabularNumbers>
				{note}
			</Text>
			<HStack gap={2} vAlign="center">
				{isRunning ? <Button label={stopLabel} variant="ghost" onClick={onStop} /> : null}
				<Button label={isRunning ? runningLabel : runLabel} variant="primary" isLoading={isRunning} isDisabled={!isReady} onClick={onRun} />
			</HStack>
		</HStack>
	);
}
