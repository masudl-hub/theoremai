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
import { Field } from '@astryxdesign/core/Field';
import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TreeList } from '@astryxdesign/core/TreeList';
import { type SearchableItem, type SearchSource, Typeahead } from '@astryxdesign/core/Typeahead';
import { VStack } from '@astryxdesign/core/VStack';
import { IconBrandVscode, IconSearch, IconSettings, IconWand, IconX } from '@tabler/icons-react';
import { type ReactNode, useId, useState } from 'react';
import { editorLabel, STUDIO_EDITORS } from '../editors.ts';
import { IconCursor } from './brand-icons.tsx';
import { NAV_WIDTH } from './studio-nav.ts';
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
	confirmations: 'Confirmations',
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
		words: 'editor automatic vs code vscode cursor',
	},
	{ id: 'watch', label: 'Watch files', section: 'files', words: 'reload save' },
	{ id: 'files-toast', label: 'Tell me when files change', section: 'files', words: 'note notify' },
	{ id: 'ask-shared', label: 'Ask before changing a shared value', section: 'confirmations', words: 'confirm asking' },
	{ id: 'ask-writes', label: 'Ask before a tool writes', section: 'confirmations', words: 'confirm asking destructive run' },
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

/** One group of settings: what it is about on the left, its controls on the right. Titled as the editor titles a section. */
function Group({ title, about, children }: { title: string; about: string; children: ReactNode }) {
	return (
		<Grid columns={{ minWidth: 320 }} gap={10}>
			<VStack gap={1}>
				<Text type="label" weight="semibold">
					{title}
				</Text>
				<Text type="supporting" color="secondary">
					{about}
				</Text>
			</VStack>
			<VStack gap={5}>{children}</VStack>
		</Grid>
	);
}

const AUTOMATIC = 'automatic';

/** Where files open: the studio's own pick, or one of the two editors Settings offers. */
const EDITOR_CHOICES: readonly { value: string; label: string; icon: IconType }[] = [
	{ value: AUTOMATIC, label: 'Automatic', icon: IconWand },
	...STUDIO_EDITORS.filter((editor) => editor.choice).map((editor) => ({
		value: editor.command,
		label: editor.label,
		icon: editor.command === 'cursor' ? IconCursor : IconBrandVscode,
	})),
];

/** What Automatic opens files in, in the builder's words. */
function automaticNote(automatic: string | undefined): string {
	return automatic
		? `Automatic opens ${editorLabel(automatic)}.`
		: 'Automatic opens the editor the studio was started with.';
}

function EditorChoice({ automatic }: { automatic: string | undefined }) {
	const editor = usePref('editor');
	const id = useId();
	return (
		<Field label="Open files in" description={automaticNote(automatic)} inputID={id} isGroupLabel>
			<SegmentedControl
				label="Open files in"
				size="sm"
				value={editor || AUTOMATIC}
				onChange={(next) => {
					setPref('editor', next === AUTOMATIC ? '' : next);
				}}
			>
				{EDITOR_CHOICES.map((choice) => (
					<SegmentedControlItem
						key={choice.value}
						value={choice.value}
						label={choice.label}
						icon={<Icon icon={choice.icon} size="sm" />}
					/>
				))}
			</SegmentedControl>
		</Field>
	);
}

/** Watching the project's files: absent when the studio command was started without it. */
export interface WatchChoice {
	on: boolean;
	set: (on: boolean) => void;
}

function FilesSettings({ project, watch }: { project: ProjectSession; watch: WatchChoice | undefined }) {
	const filesToast = usePref('filesToast');
	return (
		<>
			<Group
				title="Your editor"
				about="Where a file opens when you follow a setting to the line that sets it."
			>
				<EditorChoice automatic={project.editor} />
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

function ConfirmationSettings({ shared }: { shared: SharedAsking }) {
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
		case 'confirmations':
			return <ConfirmationSettings shared={props.shared} />;
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

/** The nav's head, as the studio's tree and the docs head theirs: the name, what is open, then the search. */
function SettingsNavHead({ project, version }: { project: ProjectSession; version: string }) {
	return (
		<VStack gap={4}>
			<VStack gap={1}>
				<Heading level={3}>studio settings</Heading>
				<Text type="supporting" color="secondary">
					{`${project.name} · @theoremjs/agents ${version}`}
				</Text>
			</VStack>
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
		</VStack>
	);
}

/** Settings, inside the studio's panel: the panel widens over the preview to hold them. */
export function StudioSettings(props: StudioSettingsProps) {
	const isNarrow = useMediaQuery('(max-width: 768px)');
	const { section } = useSettingsDoor();
	return (
		<Section variant="transparent" height="100%" padding={0}>
			<Layout
				height="fill"
				contentWidth="min(100%, 72rem)"
				start={
					isNarrow ? undefined : (
						<Section variant="transparent" width={NAV_WIDTH} height="100%" padding={4} dividers={['end']}>
							<VStack gap={4} height="100%">
								<SettingsNavHead project={props.project} version={props.version} />
								<TreeList
									density="compact"
									aria-label="Settings"
									items={SETTINGS_SECTIONS.map((each) => ({
										id: each,
										label: SECTION_LABELS[each],
										isSelected: section === each,
										onClick: () => {
											showSettingsSection(each);
										},
									}))}
								/>
							</VStack>
						</Section>
					)
				}
				content={
					<LayoutContent padding={0}>
						<Section variant="transparent" padding={3} dividers={['bottom']}>
							<HStack gap={2} vAlign="center">
								<StackItem size="fill">
									<Heading level={4} maxLines={1}>
										{SECTION_LABELS[section]}
									</Heading>
								</StackItem>
								<IconButton
									label="Close settings"
									variant="ghost"
									icon={<Icon icon={IconX} size="sm" />}
									tooltip="Back to the studio"
									onClick={closeSettings}
								/>
							</HStack>
						</Section>
						<Section variant="transparent" padding={3}>
							<VStack gap={4}>
								{isNarrow && <SettingsNavHead project={props.project} version={props.version} />}
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
						</Section>
					</LayoutContent>
				}
			/>
		</Section>
	);
}
