import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { StackItem } from '@astryxdesign/core/Stack';
import { TextInput } from '@astryxdesign/core/TextInput';
import { VStack } from '@astryxdesign/core/VStack';
import {
	IconEye,
	IconEyeOff,
	IconKey,
	IconPlayerEject,
	IconPlus,
	IconTrash,
} from '@tabler/icons-react';
import { isKeySlotName } from '../../mod.ts';
import {
	type ModelBindingDraft,
	modelBindingViolation,
	type StudioConnectionMode,
	sectionNote,
} from '../mod.ts';
import {
	keyKind,
	type ListedProfileType,
	type ListedProvider,
	listLocalStudioModels,
	listProviderModels,
	localStudioConfig,
	type ProviderModel,
	STUDIO_KEY_SLOT_CAP,
	type StudioBrowserConnection,
	type StudioBrowserRuntime,
	studioVault,
} from '../browser.ts';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { IconGemini, IconOpenRouter } from './brand-icons';
import { InspectorSection } from './inspector';

type BrowserKeyVault = Readonly<Record<string, string | undefined>>;
const withoutSlot = (vault: BrowserKeyVault, slot: string): BrowserKeyVault =>
	Object.fromEntries(Object.entries(vault).filter(([name]) => name !== slot));
type KeyEntry = { id: string; slot: string };

type LocalModels = {
	status: 'idle' | 'loading' | 'ready' | 'error';
	ids: string[];
	error?: string;
};

/** The models a local server offers at `local`, listed again shortly after the endpoint settles. */
function useLocalModels(hasLocal: boolean, local: StudioBrowserConnection['local']): LocalModels {
	const [localModels, setLocalModels] = useState<LocalModels>({ status: 'idle', ids: [] });
	useEffect(() => {
		if (!hasLocal || !local.baseUrl.trim()) {
			setLocalModels({ status: 'idle', ids: [] });
			return;
		}
		const controller = new AbortController();
		setLocalModels({ status: 'loading', ids: [] });
		const timer = globalThis.setTimeout(() => {
			void listLocalStudioModels(
				local,
				AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
			)
				.then((ids) => {
					if (!controller.signal.aborted) setLocalModels({ status: 'ready', ids });
				})
				.catch(() => {
					if (!controller.signal.aborted)
						setLocalModels({
							status: 'error',
							ids: [],
							error: 'Couldn’t load models. Check the endpoint and local server.',
						});
				});
		}, 350);
		return () => {
			globalThis.clearTimeout(timer);
			controller.abort();
		};
	}, [hasLocal, local]);
	return localModels;
}

/** Local when every model is local; your keys when any is local, keyed or not hosted; else the demo. */
function connectionMode(
	models: Parameters<typeof useStudioConnection>[0],
	hasLocal: boolean,
	hasKeys: boolean,
): StudioConnectionMode {
	if (hasLocal && models.every((model) => model.provider === 'local')) return 'local';
	const hasProvidedModels = models.every(
		(model) => modelBindingViolation({ ...model, builtInTools: model.builtInTools ?? [] }) === null,
	);
	return hasLocal || hasKeys || !hasProvidedModels ? 'byok' : 'demo';
}

/** The local server's config; an invalid edit refuses execution rather than falling back to the hosted demo. */
function localRuntimeConfig(
	local: StudioBrowserConnection['local'],
): ReturnType<typeof localStudioConfig> {
	try {
		return localStudioConfig(local);
	} catch (error) {
		return {
			baseUrl: local.baseUrl,
			fetch: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
		};
	}
}

/**
 * The key rows: one per slot the draft names or key the vault holds. Typing a slot name in the
 * editor must not leave a row behind for every prefix. Unnamed rows stay until removed.
 */
function useKeyEntries(slots: readonly string[]) {
	const [entries, setEntries] = useState<KeyEntry[]>([]);
	useEffect(() => {
		setEntries((current) => [
			...current.filter((entry) => !entry.slot || slots.includes(entry.slot)),
			...slots
				.filter((slot) => !current.some((entry) => entry.slot === slot))
				.map((slot) => ({ id: crypto.randomUUID(), slot })),
		]);
	}, [slots]);
	return [entries, setEntries] as const;
}

/** The runtime the runner executes on, or null for the demo; each new one aborts the last. */
function useConnectionRuntime(
	mode: StudioConnectionMode,
	hasLocal: boolean,
	vault: BrowserKeyVault,
	local: StudioBrowserConnection['local'],
	remoteTools: boolean,
	slots: readonly string[],
): StudioBrowserRuntime | null {
	const connection = useMemo(() => {
		if (mode === 'demo') return null;
		const controller = new AbortController();
		const localConfig = hasLocal ? localRuntimeConfig(local) : undefined;
		const slotted = studioVault(slots, vault);
		return {
			controller,
			runtime: {
				mode,
				signal: controller.signal,
				remoteTools: hasLocal ? remoteTools : true,
				providers: { vault: slotted, ...(localConfig ? { local: localConfig } : {}) },
				decision: { vault: slotted },
			} satisfies StudioBrowserRuntime,
		};
	}, [mode, hasLocal, vault, local, remoteTools, slots]);
	useEffect(
		() => () => {
			connection?.controller.abort();
		},
		[connection],
	);
	return connection?.runtime ?? null;
}

/** Models select execution; the vault and connection settings remain in this tab's memory. */
export function useStudioConnection(
	models: readonly (Pick<ModelBindingDraft, 'protocol' | 'provider' | 'apiId'> & {
		builtInTools?: string[];
	})[],
	initialBaseUrl = 'http://127.0.0.1:11434',
	namedSlots: readonly string[] = [],
) {
	const [vault, setVault] = useState<BrowserKeyVault>({});
	const [local, setLocal] = useState<StudioBrowserConnection['local']>({
		baseUrl: initialBaseUrl,
	});
	const [remoteTools, setRemoteTools] = useState(false);
	const slotNames = [...new Set([...namedSlots, ...Object.keys(vault)])].join('\n');
	const slots = useMemo(() => (slotNames ? slotNames.split('\n') : []), [slotNames]);
	const [entries, setEntries] = useKeyEntries(slots);
	const hasLocal = models.some((model) => model.provider === 'local');
	const localModels = useLocalModels(hasLocal, local);
	const hasKeys = Object.values(vault).some((key) => Boolean(key?.trim()));
	const mode = connectionMode(models, hasLocal, hasKeys);
	const runtime = useConnectionRuntime(mode, hasLocal, vault, local, remoteTools, slots);
	// One object while nothing in it changes, so panes that only read the connection can sit out a render.
	return useMemo(
		() => ({
			entries,
			setEntries,
			localModels,
			mode,
			runtime,
			vault,
			setVault,
			slots,
			local,
			setLocal,
			remoteTools,
			setRemoteTools,
		}),
		[entries, setEntries, localModels, mode, runtime, vault, slots, local, remoteTools],
	);
}

export type StudioConnectionState = ReturnType<typeof useStudioConnection>;

export type ProviderModels =
	| { status: 'idle' | 'loading'; models: ProviderModel[] }
	| { status: 'ready'; models: ProviderModel[] }
	| { status: 'error'; models: ProviderModel[]; error: string };

/** Lists already fetched this tab, by provider, profile type and key; a list barely changes. */
const listed = new Map<string, ProviderModel[]>();

/**
 * The models a provider offers for this profile type, listed with the key in the slot the model
 * reads. OpenRouter lists without a key; Gemini waits for one.
 */
export function useProviderModels(
	provider: ListedProvider | undefined,
	type: ListedProfileType,
	secret: string | undefined,
): ProviderModels {
	const key = secret?.trim() ?? '';
	const id = provider ? [provider, type, key].join('\n') : '';
	const [state, setState] = useState<ProviderModels & { id: string }>({
		id: '',
		status: 'idle',
		models: [],
	});
	useEffect(() => {
		const cached = listed.get(id);
		if (!provider || cached) {
			setState({ id, status: cached ? 'ready' : 'idle', models: cached ?? [] });
			return;
		}
		if (provider === 'google' && !key) {
			setState({ id, status: 'idle', models: [] });
			return;
		}
		const controller = new AbortController();
		setState({ id, status: 'loading', models: [] });
		const timer = globalThis.setTimeout(() => {
			void listProviderModels(
				provider,
				type,
				key || undefined,
				AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
			)
				.then((models) => {
					listed.set(id, models);
					if (!controller.signal.aborted) setState({ id, status: 'ready', models });
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						setState({
							id,
							status: 'error',
							models: [],
							error: error instanceof Error ? error.message : 'Couldn’t list models.',
						});
				});
		}, 350);
		return () => {
			globalThis.clearTimeout(timer);
			controller.abort();
		};
	}, [id, provider, type, key]);
	// Until the effect catches up with a new key, the old list isn't this key's.
	return state.id === id ? state : { status: provider ? 'loading' : 'idle', models: [] };
}

/** What a slot holds, for a slot picker: the service its key is for, or that it is empty. */
export function slotDescription(secret: string | undefined): string {
	if (!secret?.trim()) return 'No key yet';
	const kind = keyKind(secret);
	return kind ? KEY_KINDS[kind].label : 'Key';
}

/** The icon follows the pasted key; a key whose service its prefix doesn't show gets a plain key. */
const KEY_KINDS = {
	google: { icon: IconGemini, label: 'Gemini key' },
	openrouter: { icon: IconOpenRouter, label: 'OpenRouter key' },
};

/** Key mappings use the editor's own section and compact controls. */
export function StudioKeys({
	connection,
	onRenameSlot,
	onAddSlot,
	onRemoveSlot,
}: {
	connection: StudioConnectionState;
	onRenameSlot?: (from: string, to: string) => void;
	onAddSlot?: (slot: string) => void;
	onRemoveSlot?: (slot: string) => void;
}) {
	return (
		<InspectorSection note={sectionNote('connection')}>
			<VStack gap={2}>
				{connection.entries.map((entry) => (
					<KeyRow
						key={entry.id}
						entry={entry}
						connection={connection}
						onRenameSlot={onRenameSlot}
						onAddSlot={onAddSlot}
						onRemoveSlot={onRemoveSlot}
					/>
				))}
				<HStack>
					<IconButton
						label="Add key"
						variant="ghost"
						size="sm"
						icon={<Icon icon={IconPlus} size="sm" />}
						isDisabled={connection.entries.length >= STUDIO_KEY_SLOT_CAP}
						onClick={() => {
							connection.setEntries((current) => [
								...current,
								{ id: crypto.randomUUID(), slot: '' },
							]);
						}}
					/>
				</HStack>
			</VStack>
		</InspectorSection>
	);
}

interface KeyRowProps {
	entry: KeyEntry;
	connection: StudioConnectionState;
	onRenameSlot?: (from: string, to: string) => void;
	onAddSlot?: (slot: string) => void;
	onRemoveSlot?: (slot: string) => void;
}

function KeyRow({ entry, connection, onRenameSlot, onAddSlot, onRemoveSlot }: KeyRowProps) {
	const secret = Object.hasOwn(connection.vault, entry.slot)
		? (connection.vault[entry.slot] ?? '')
		: '';
	const { name, setName, error, rename } = useSlotName(
		entry,
		connection,
		secret,
		onRenameSlot,
		onAddSlot,
	);
	const [visible, setVisible] = useState(false);
	return (
		<HStack gap={2} vAlign="center">
			<StackItem size="static">
				<KeyKindIcon secret={secret} />
			</StackItem>
			<StackItem size="fill">
				<TextInput
					label="Key name"
					hasAutoFocus={!entry.slot}
					isLabelHidden
					size="sm"
					value={name}
					placeholder="Key name"
					onChange={setName}
					onBlur={rename}
					status={error ? { type: 'error', message: error } : undefined}
				/>
			</StackItem>
			<StackItem size="fill">
				<KeySecretInput entry={entry} connection={connection} secret={secret} visible={visible} />
			</StackItem>
			<StackItem size="static">
				<KeyRowActions
					entry={entry}
					connection={connection}
					visible={visible}
					setVisible={setVisible}
					onRemoveSlot={onRemoveSlot}
				/>
			</StackItem>
		</HStack>
	);
}

/** The pasted key's service, or a plain key. */
function KeyKindIcon({ secret }: { secret: string }) {
	const kind = keyKind(secret);
	return (
		<Icon
			icon={kind ? KEY_KINDS[kind].icon : IconKey}
			size="sm"
			color="secondary"
			label={kind ? KEY_KINDS[kind].label : 'Key'}
		/>
	);
}

/** The key itself, written to the vault under the row's slot; disabled until the slot has a name. */
function KeySecretInput({
	entry,
	connection,
	secret,
	visible,
}: {
	entry: KeyEntry;
	connection: StudioConnectionState;
	secret: string;
	visible: boolean;
}) {
	return (
		<TextInput
			label="API key"
			isLabelHidden
			size="sm"
			type={visible ? 'text' : 'password'}
			value={secret}
			placeholder="API key"
			autoComplete="off"
			isDisabled={!entry.slot}
			onChange={(value) => {
				connection.setVault((current) => ({
					...current,
					[entry.slot]: value.trim() || undefined,
				}));
			}}
		/>
	);
}

/** A row's slot name as typed, committed on blur once it is valid and free. */
function useSlotName(
	entry: KeyEntry,
	connection: StudioConnectionState,
	secret: string,
	onRenameSlot: ((from: string, to: string) => void) | undefined,
	onAddSlot: ((slot: string) => void) | undefined,
) {
	const [name, setName] = useState(entry.slot);
	useEffect(() => {
		setName(entry.slot);
	}, [entry.slot]);
	const [error, setError] = useState<string>();
	const rename = () => {
		if (name === entry.slot) return;
		if (!isKeySlotName(name)) {
			setError('Use a valid slot name, up to 32 characters.');
			return;
		}
		if (connection.entries.some((other) => other.id !== entry.id && other.slot === name)) {
			setError('This key name already exists.');
			return;
		}
		connection.setVault((current) => ({
			...withoutSlot(current, entry.slot),
			[name]: secret || undefined,
		}));
		connection.setEntries((current) =>
			current.map((other) => (other.id === entry.id ? { ...other, slot: name } : other)),
		);
		if (entry.slot) onRenameSlot?.(entry.slot, name);
		else onAddSlot?.(name);
		setError(undefined);
	};
	return { name, setName, error, rename };
}

/** Show or hide the key, and remove the row (or, where the profile names its slot, clear the key). */
function KeyRowActions({
	entry,
	connection,
	visible,
	setVisible,
	onRemoveSlot,
}: {
	entry: KeyEntry;
	connection: StudioConnectionState;
	visible: boolean;
	setVisible: Dispatch<SetStateAction<boolean>>;
	onRemoveSlot?: (slot: string) => void;
}) {
	// Where the profile can't drop a slot it names (the run tab), its row stays and only the key goes.
	const removable = onRemoveSlot !== undefined || !entry.slot;
	return (
		<HStack gap={1}>
			<IconButton
				label={visible ? 'Hide key' : 'Show key'}
				variant="ghost"
				size="sm"
				icon={<Icon icon={visible ? IconEyeOff : IconEye} size="sm" />}
				onClick={() => {
					setVisible((current) => !current);
				}}
			/>
			<IconButton
				label={removable ? 'Remove key' : 'Clear key'}
				variant="ghost"
				size="sm"
				icon={<Icon icon={removable ? IconTrash : IconPlayerEject} size="sm" />}
				onClick={() => {
					connection.setVault((current) => withoutSlot(current, entry.slot));
					if (!removable) return;
					connection.setEntries((current) => current.filter((other) => other.id !== entry.id));
					onRemoveSlot?.(entry.slot);
				}}
			/>
		</HStack>
	);
}
