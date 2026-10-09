import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Popover } from '@astryxdesign/core/Popover';
import { IconActivity, IconKey } from '@tabler/icons-react';
import { useState, useSyncExternalStore } from 'react';
import { type ModelBinding, resolveObservabilityPolicy } from '../../mod.ts';
import { TheoremThemeProvider, TracePlacement } from '../../react/src/ui/index.ts';
import { studioKeySlots } from '../browser.ts';
import type { StudioRunPayload } from '../mod.ts';
import { ProjectContext } from './lib/studio-project.ts';
import type { StudioRunOpened } from './lib/studio-run-open.ts';
import { StudioKeys, useStudioConnection } from './studio-connection.tsx';
import { StudioRunner } from './studio-runner.tsx';
import './studio-run.css';

/** A model binding as the connection reads it. */
type ConnectionModel = Parameters<typeof useStudioConnection>[0][number];

/** The width below which these controls keep only their icon. */
const PHONE = '(width < 768px)';

function usePhone() {
	return useSyncExternalStore(
		(change) => {
			const query = globalThis.matchMedia(PHONE);
			query.addEventListener('change', change);
			return () => {
				query.removeEventListener('change', change);
			};
		},
		() => globalThis.matchMedia(PHONE).matches,
		() => false,
	);
}

/** Whether this run records traces, so the page can offer them. */
function recordsTrace(payload: StudioRunPayload): boolean {
	return resolveObservabilityPolicy(payload.profile.observability).record;
}

/** The name the page and the document title use. A host has no handle: it's named by its id. */
export function studioRunTitle(payload: StudioRunPayload): string {
	return 'identity' in payload.profile ? payload.profile.identity.handle : payload.agentId;
}

/** `payload` with each `from` slot, on its agent and the agents it calls, renamed to `to`. */
function withRenamedSlot(current: StudioRunPayload, from: string, to: string): StudioRunPayload {
	const rename = <T extends { keySlot?: string; fallbackKeySlot?: string }>(value: T): T => ({
		...value,
		...(value.keySlot === from ? { keySlot: to } : {}),
		...(value.fallbackKeySlot === from ? { fallbackKeySlot: to } : {}),
	});
	const renamed = (profile: StudioRunPayload['profile']): StudioRunPayload['profile'] =>
		profile.type === 'host'
			? profile
			: {
					...profile,
					models: Object.fromEntries(
						Object.entries<ModelBinding>(profile.models).map(([id, model]) => [id, rename(model)]),
					),
				};
	return {
		...current,
		profile: renamed(current.profile),
		...(current.dependencies
			? {
					dependencies: current.dependencies.map((dependency) => ({
						...dependency,
						profile: renamed(dependency.profile),
					})),
				}
			: {}),
	};
}

/** `payload` with `slot` as its agent's key, unless it is a host or has a key already. */
function withAddedSlot(current: StudioRunPayload, slot: string): StudioRunPayload {
	if (current.profile.type === 'host') return current;
	return {
		...current,
		profile: {
			...current.profile,
			models: Object.fromEntries(
				Object.entries<ModelBinding>(current.profile.models).map(([id, binding]) => [
					id,
					binding.keySlot ? binding : { ...binding, keySlot: slot },
				]),
			),
		},
	};
}

/** The Keys button and the popover it opens. */
function KeysPopover({
	connection,
	isOpen,
	onOpenChange,
	onAddSlot,
	onRenameSlot,
	phone,
}: {
	connection: ReturnType<typeof useStudioConnection>;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onAddSlot: (slot: string) => void;
	onRenameSlot: (from: string, to: string) => void;
	phone: boolean;
}) {
	return (
		<Popover
			label="Keys"
			placement="below"
			alignment="end"
			width={360}
			isOpen={isOpen}
			onOpenChange={onOpenChange}
			content={
				<StudioKeys connection={connection} onAddSlot={onAddSlot} onRenameSlot={onRenameSlot} />
			}
		>
			<Button
				label="Keys"
				isIconOnly={phone}
				icon={<Icon icon={IconKey} size="sm" />}
				aria-pressed={isOpen}
			/>
		</Popover>
	);
}

/**
 * An agent opened in a tab of its own: the runner fills the page, with View trace and Keys above it.
 * `opened` is what `openStudioRun` returned for this tab.
 */
export function StudioRunScreen({ opened }: { opened: StudioRunOpened }) {
	const [payload, setPayload] = useState(opened.payload);
	// The agent and the agents it calls each read their own key slots.
	const profiles = [
		payload.profile,
		...(payload.dependencies ?? []).map((dependency) => dependency.profile),
	];
	const models = profiles.flatMap((profile) =>
		profile.type === 'host'
			? []
			: Object.values<ModelBinding>(profile.models).map(
					(binding): ConnectionModel => ({
						...binding,
						protocol:
							profile.type === 'decision'
								? 'decision'
								: binding.provider === 'google'
									? profile.type === 'live'
										? 'geminiLive'
										: 'geminiInteractions'
									: 'openAi',
					}),
				),
	);
	const connection = useStudioConnection(
		models,
		payload.localBaseUrl,
		profiles.flatMap((profile) => studioKeySlots(profile)),
	);
	const [keysOpen, setKeysOpen] = useState(payload.connectionMode === 'byok');
	const traced = recordsTrace(payload);
	const [traceOpen, setTraceOpen] = useState(false);
	const phone = usePhone();
	const { mode, runtime } = connection;
	const title = studioRunTitle(payload);
	const renameSlot = (from: string, to: string) => {
		setPayload((current) => withRenamedSlot(current, from, to));
	};

	return (
		<TheoremThemeProvider mode="dark">
			{/* The draft exists only in the browser, so the title is set after hydration. */}
			<title>{`${title} · theorem studio`}</title>
			<TracePlacement value="panel">
				<div className="run-page">
					<div className="run-controls">
						{traced ? (
							<Button
								label={traceOpen ? 'Hide trace' : 'View trace'}
								isIconOnly={phone}
								icon={<Icon icon={IconActivity} size="sm" />}
								aria-pressed={traceOpen}
								onClick={() => {
									setTraceOpen((open) => !open);
								}}
							/>
						) : null}
						<KeysPopover
							connection={connection}
							isOpen={keysOpen}
							onOpenChange={setKeysOpen}
							onAddSlot={(slot) => {
								setPayload((current) => withAddedSlot(current, slot));
							}}
							onRenameSlot={renameSlot}
							phone={phone}
						/>
					</div>
					<ProjectContext.Provider value={opened.project}>
						<StudioRunner
							key={mode}
							payload={payload}
							mode={mode}
							runtime={runtime}
							trace={traced ? traceOpen : undefined}
							flush
							columns
							className="run-chat"
						/>
					</ProjectContext.Provider>
				</div>
			</TracePlacement>
		</TheoremThemeProvider>
	);
}
