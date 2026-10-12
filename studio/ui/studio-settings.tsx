/**
 * Settings for the studio open on a project: where every choice about how the studio behaves is
 * made. Choices are kept in this browser, keys in this tab, and nothing is written to the project.
 */
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Divider } from '@astryxdesign/core/Divider';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutHeader, LayoutPanel } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { type SearchableItem, type SearchSource, Typeahead } from '@astryxdesign/core/Typeahead';
import { VStack } from '@astryxdesign/core/VStack';
import { IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { editorLabel, STUDIO_EDITORS } from '../editors.ts';
import { setPref, type StudioPrefs, usePref } from './lib/studio-prefs.ts';
import type { ProjectSession } from './lib/studio-project.ts';
import {
	closeSettings,
	openSettings,
	SETTINGS_SECTIONS,
	type SettingsSection,
	showSettingsSection,
	useSettingsDoor,
} from './lib/studio-settings.ts';

const SECTION_LABELS: Record<SettingsSection, string> = {
	files: 'Files',
	asking: 'Asking',
	keys: 'Keys',
	project: 'Project',
	about: 'About',
};

/** Every setting by name, for the search: choosing one opens its section. `words` is what else a builder might type. */
const SETTINGS: readonly (SearchableItem & { section: SettingsSection; words?: string })[] = [
	{
		id: 'editor',
		label: 'Open files in',
		section: 'files',
		words: `editor ${STUDIO_EDITORS.map((editor) => editor.label).join(' ')}`,
	},
	{ id: 'watch', label: 'Watch files', section: 'files', words: 'reload save' },
	{ id: 'files-toast', label: 'Tell me when files change', section: 'files', words: 'note notify' },
	{ id: 'ask-shared', label: 'Ask before changing a shared value', section: 'asking', words: 'confirm' },
	{ id: 'ask-writes', label: 'Ask before a tool writes', section: 'asking', words: 'confirm destructive run' },
	{ id: 'keys', label: 'Model keys', section: 'keys', words: 'api key provider' },
	{ id: 'open-project', label: 'Open project and setup file', section: 'project' },
	{ id: 'clear-chats', label: "Clear this tab's chats", section: 'project', words: 'conversation reset' },
	{ id: 'discard', label: 'Discard unsaved edits', section: 'project', words: 'revert reset' },
	{ id: 'version', label: 'Package version', section: 'about' },
	{ id: 'address', label: 'Studio address', section: 'about', words: 'url port server' },
];

const settingsSource: SearchSource<SearchableItem> = {
	search: (query) => {
		const asked = query.toLowerCase();
		return SETTINGS.filter((setting) =>
			`${setting.label} ${setting.words ?? ''}`.toLowerCase().includes(asked),
		);
	},
	bootstrap: () => [...SETTINGS],
};

/** The door to Settings at the foot of the shell's rail. Nothing shows until a screen can open them. */
export function SettingsRailButton() {
	const door = useSettingsDoor();
	if (!door.ready) return null;
	return (
		<IconButton
			label="Settings"
			variant="ghost"
			icon={<Icon icon={IconSettings} />}
			tooltip={door.open ? 'Back to the studio' : 'Settings'}
			aria-pressed={door.open}
			onClick={() => {
				if (door.open) closeSettings();
				else openSettings();
			}}
		/>
	);
}

/** One group of settings: what it is about on the left, its controls on the right. */
function Group({ title, about, children }: { title: string; about: string; children: ReactNode }) {
	return (
		<Grid columns={{ minWidth: 320 }} gap={10}>
			<VStack gap={1}>
				<Heading level={3}>{title}</Heading>
				<Text type="supporting" color="secondary">
					{about}
				</Text>
			</VStack>
			<VStack gap={5}>{children}</VStack>
		</Grid>
	);
}

const AUTOMATIC = 'automatic';

/** The editors to choose from: the studio's own pick, the common ones, then the rest. */
function editorOptions(automatic: string | undefined) {
	const option = ({ command, label }: (typeof STUDIO_EDITORS)[number]) => ({ value: command, label });
	return [
		{
			value: AUTOMATIC,
			label: automatic ? `Automatic (${editorLabel(automatic)})` : 'Automatic',
			description: 'The editor the studio command was started with, or your $VISUAL or $EDITOR.',
		},
		{
			type: 'section' as const,
			title: 'Common',
			options: STUDIO_EDITORS.filter((editor) => editor.common).map(option),
		},
		{
			type: 'section' as const,
			title: 'More',
			options: STUDIO_EDITORS.filter((editor) => !editor.common).map(option),
		},
	];
}

/** Watching the project's files: absent when the studio command was started without it. */
export interface WatchChoice {
	on: boolean;
	set: (on: boolean) => void;
}

function FilesSettings({ project, watch }: { project: ProjectSession; watch: WatchChoice | undefined }) {
	const editor = usePref('editor');
	const filesToast = usePref('filesToast');
	return (
		<>
			<Group
				title="Your editor"
				about="Where a file opens when you follow a setting to the line that sets it."
			>
				<Selector
					label="Open files in"
					hasSearch
					placement="below"
					options={editorOptions(project.editor)}
					value={editor || AUTOMATIC}
					onChange={(next) => {
						setPref('editor', next === AUTOMATIC ? '' : next);
					}}
				/>
			</Group>
			<Divider />
			<Group
				title="Changes from your files"
				about="What the studio does when your editor saves a file your setup reads."
			>
				<CheckboxInput
					label="Watch files"
					description="Take in what your editor saves, as it saves. Your unsaved studio edits are kept."
					value={watch?.on ?? false}
					isDisabled={!watch}
					disabledMessage="The studio command was started with --no-watch."
					onChange={(on) => watch?.set(on)}
				/>
				<CheckboxInput
					label="Tell me when files change"
					description="A short note each time a save in your editor changed a setting here."
					value={filesToast === 'on'}
					onChange={(on) => {
						setPref('filesToast', on ? 'on' : 'off');
					}}
				/>
			</Group>
		</>
	);
}

/** Whether changing a shared value asks first, as the store holds it. */
export interface SharedAsking {
	asks: boolean;
	set: (asks: boolean) => void;
}

const isAskWrites = (value: string): value is StudioPrefs['askWrites'] =>
	value === 'always' || value === 'destructive';

function AskingSettings({ shared }: { shared: SharedAsking }) {
	const askWrites = usePref('askWrites');
	return (
		<>
			<Group
				title="Shared values"
				about="A value several agents share changes on every one of them."
			>
				<CheckboxInput
					label="Ask before changing a shared value"
					description="Shows which agents and files the change reaches, before it is made."
					value={shared.asks}
					onChange={shared.set}
				/>
			</Group>
			<Divider />
			<Group
				title="Tools that write"
				about="A real run of a tool that writes can change something outside the studio."
			>
				<RadioList
					label="Ask before a run"
					value={askWrites}
					onChange={(next) => {
						if (isAskWrites(next)) setPref('askWrites', next);
					}}
				>
					<RadioListItem
						value="always"
						label="Every tool that writes"
						description="Shows the input the run would send, each time."
					/>
					<RadioListItem
						value="destructive"
						label="Only destructive tools"
						description="Tools that read and write run straight away. Tools marked destructive still ask."
					/>
				</RadioList>
			</Group>
		</>
	);
}

/** What the Project section can do to this tab; an action is absent when there is nothing for it to do. */
export interface TabActions {
	clearChats: () => void;
	discard: (() => void) | undefined;
}

function ProjectSettings({ project, actions }: { project: ProjectSession; actions: TabActions }) {
	const [clearing, setClearing] = useState(false);
	return (
		<>
			<Group title="Open project" about="What the studio command opened. The studio reads it from your files.">
				<MetadataList>
					<MetadataListItem label="Project">{project.name}</MetadataListItem>
					{project.setup && <MetadataListItem label="Setup file">{project.setup}</MetadataListItem>}
					<MetadataListItem label="Agents">{String(project.profiles.length)}</MetadataListItem>
				</MetadataList>
			</Group>
			<Divider />
			<Group title="This tab" about="What this tab holds that your files do not.">
				<VStack gap={1}>
					<HStack>
						<Button
							label="Clear this tab's chats"
							variant="secondary"
							onClick={() => {
								setClearing(true);
							}}
						/>
					</HStack>
					<Text type="supporting" color="secondary">
						Every agent's preview conversation starts again.
					</Text>
				</VStack>
				<VStack gap={1}>
					<HStack>
						<Button
							label="Discard unsaved edits"
							variant="secondary"
							isDisabled={!actions.discard}
							onClick={actions.discard}
						/>
					</HStack>
					<Text type="supporting" color="secondary">
						{actions.discard
							? 'The studio opens your files as they are. Undo brings the edits back.'
							: 'Nothing here differs from your files.'}
					</Text>
				</VStack>
			</Group>
			<AlertDialog
				isOpen={clearing}
				onOpenChange={setClearing}
				title="Clear this tab's chats?"
				description="Every agent's preview conversation in this tab is removed. This can't be undone."
				actionLabel="Clear chats"
				actionVariant="destructive"
				onAction={() => {
					actions.clearChats();
					setClearing(false);
				}}
			/>
		</>
	);
}

function AboutSettings({ project, version }: { project: ProjectSession; version: string }) {
	return (
		<Group
			title="This studio"
			about="Settings are kept in this browser. Keys stay in this tab. Neither is written to your project."
		>
			<MetadataList>
				<MetadataListItem label="Package">{`@theoremjs/agents ${version}`}</MetadataListItem>
				<MetadataListItem label="Studio address">{`${location.origin}/studio/`}</MetadataListItem>
				<MetadataListItem label="Project server">{new URL(project.endpoint, location.href).origin}</MetadataListItem>
			</MetadataList>
		</Group>
	);
}

export interface StudioSettingsProps {
	project: ProjectSession;
	/** The `@theoremjs/agents` version the studio runs. */
	version: string;
	watch: WatchChoice | undefined;
	shared: SharedAsking;
	actions: TabActions;
	/** The key slots, as the studio's Keys panel shows them. */
	keys: ReactNode;
}

function SectionBody({ section, ...props }: StudioSettingsProps & { section: SettingsSection }) {
	switch (section) {
		case 'files':
			return <FilesSettings project={props.project} watch={props.watch} />;
		case 'asking':
			return <AskingSettings shared={props.shared} />;
		case 'keys':
			return (
				<Group
					title="Model keys"
					about="Your own keys, to run an agent with. Never saved, never written to your project."
				>
					{props.keys}
				</Group>
			);
		case 'project':
			return <ProjectSettings project={props.project} actions={props.actions} />;
		default:
			return <AboutSettings project={props.project} version={props.version} />;
	}
}

const isSection = (value: string): value is SettingsSection =>
	(SETTINGS_SECTIONS as readonly string[]).includes(value);

function SettingsHeader() {
	return (
		<LayoutHeader hasDivider>
			<HStack vAlign="center" gap={2}>
				<StackItem size="fill">
					<Heading level={1}>Settings</Heading>
				</StackItem>
				<Typeahead
					label="Search"
					isLabelHidden
					placeholder="Search settings..."
					searchSource={settingsSource}
					value={null}
					onChange={(item) => {
						const found = SETTINGS.find((setting) => setting.id === item?.id);
						if (found) showSettingsSection(found.section);
					}}
					hasEntriesOnFocus
					startIcon={IconSearch}
				/>
				<IconButton
					label="Close settings"
					variant="ghost"
					icon={<Icon icon={IconX} size="sm" />}
					tooltip="Back to the studio"
					onClick={closeSettings}
				/>
			</HStack>
		</LayoutHeader>
	);
}

/** Settings, in the studio's place in the shell, on the shell's own ground. */
export function StudioSettings(props: StudioSettingsProps) {
	const isNarrow = useMediaQuery('(max-width: 768px)');
	const { section } = useSettingsDoor();
	return (
		<Section variant="transparent" height="100%" padding={0}>
			<Layout
				height="fill"
				contentWidth={1440}
				header={<SettingsHeader />}
				start={
					isNarrow ? undefined : (
						<LayoutPanel hasDivider={false} width={260} padding={2}>
							<List density="balanced">
								{SETTINGS_SECTIONS.map((each) => (
									<ListItem
										key={each}
										label={SECTION_LABELS[each]}
										isSelected={section === each}
										onClick={() => {
											showSettingsSection(each);
										}}
									/>
								))}
							</List>
						</LayoutPanel>
					)
				}
				content={
					<LayoutContent padding={4}>
						<VStack gap={4}>
							{isNarrow && (
								<VStack hAlign="center">
									<TabList
										value={section}
										onChange={(next) => {
											if (isSection(next)) showSettingsSection(next);
										}}
									>
										{SETTINGS_SECTIONS.map((each) => (
											<Tab key={each} value={each} label={SECTION_LABELS[each]} />
										))}
									</TabList>
								</VStack>
							)}
							<SectionBody section={section} {...props} />
						</VStack>
					</LayoutContent>
				}
			/>
		</Section>
	);
}
