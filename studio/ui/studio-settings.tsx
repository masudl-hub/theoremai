/**
 * Settings for the studio open on a project: where every choice about how the studio behaves is
 * made. Choices are kept in this browser, keys in this tab, and nothing is written to the project.
 */
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Divider } from '@astryxdesign/core/Divider';
import { Field } from '@astryxdesign/core/Field';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { useMediaQuery } from '@astryxdesign/core/hooks';
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
import {
  IconBrandVscode,
  IconDeviceDesktopCode,
  IconPlus,
  IconSearch,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { editorLabel, STUDIO_EDITORS } from '../editors.ts';
import type { StudioActingAs, StudioPeopleOffer, StudioPerson } from '../people.ts';
import { IconCursor } from './brand-icons.tsx';
import { freshPerson, listPeople, useActingAs } from './lib/acting-as.ts';
import { type StudioPrefs, setPref, usePref } from './lib/studio-prefs.ts';
import type { ProjectSession } from './lib/studio-project.ts';
import {
  closeSettings,
  openSettings,
  SETTINGS_SECTIONS,
  type SettingsSection,
  showSettingsSection,
  useSettingsDoor,
} from './lib/studio-settings.ts';
import { NAV_WIDTH } from './studio-nav.ts';

const SECTION_LABELS: Record<SettingsSection, string> = {
  files: 'Files',
  confirmations: 'Confirmations',
  keys: 'Keys',
  people: 'People',
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
  {
    id: 'ask-shared',
    label: 'Ask before changing a shared value',
    section: 'confirmations',
    words: 'confirm asking',
  },
  {
    id: 'ask-writes',
    label: 'Ask before a tool writes',
    section: 'confirmations',
    words: 'confirm asking destructive run',
  },
  { id: 'keys', label: 'Model keys', section: 'keys', words: 'api key provider' },
  {
    id: 'acting-as',
    label: 'Who a run acts as',
    section: 'people',
    words: 'person user account place sign in',
  },
  { id: 'open-project', label: 'Open project and setup file', section: 'project' },
  {
    id: 'clear-chats',
    label: "Clear this tab's chats",
    section: 'project',
    words: 'conversation reset',
  },
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
      size="lg"
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
  { value: AUTOMATIC, label: 'Automatic', icon: IconDeviceDesktopCode },
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

function FilesSettings({
  project,
  watch,
}: {
  project: ProjectSession;
  watch: WatchChoice | undefined;
}) {
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

const NO_ONE = 'no-one';
const personValue = (person: StudioPerson) => `person:${person.id}`;

function PlacePicker({
  offer,
  place,
  onChange,
}: {
  offer: StudioPeopleOffer;
  place: string;
  onChange: (place: string) => void;
}) {
  return (
    <SegmentedControl label="Place" size="sm" value={place} onChange={onChange}>
      {offer.places.map((each) => (
        <SegmentedControlItem key={each.id} value={each.id} label={each.label} />
      ))}
    </SegmentedControl>
  );
}

/** What went wrong, in the words it was said in. */
const said = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The people in a place, as the setup file answers them, and what it said when it could not. */
function usePeopleIn(project: ProjectSession, offer: StudioPeopleOffer, place: string) {
  const [found, setFound] = useState<{ place: string; people: StudioPerson[]; error?: string }>();
  useEffect(() => {
    if (!offer.existing) return;
    let isCurrent = true;
    listPeople(project, place).then(
      (people) => {
        if (isCurrent) setFound({ place, people });
      },
      (error: unknown) => {
        if (isCurrent) setFound({ place, people: [], error: said(error) });
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [project, offer.existing, place]);
  return found?.place === place ? found : undefined;
}

/** A new person the setup makes in a place, picked as soon as it is made; and what it said when it could not. */
function useFreshPerson(project: ProjectSession) {
  const { choose } = useActingAs();
  const [made, setMade] = useState<StudioActingAs[]>([]);
  const [making, setMaking] = useState<{ place: string; error?: string }>();
  const make = (place: string) => {
    setMaking({ place });
    freshPerson(project, place).then(
      (person) => {
        setMade((before) => [...before, { place, person }]);
        setMaking(undefined);
        choose({ place, person });
      },
      (error: unknown) => {
        setMaking({ place, error: said(error) });
      },
    );
  };
  return { made, making, make };
}

/** The people to offer in a place: the ones the setup listed, then any picked or made here it did not. */
function shownPeople(
  place: string,
  listed: readonly StudioPerson[],
  actingAs: StudioActingAs | undefined,
  made: readonly StudioActingAs[],
): StudioPerson[] {
  const shown = [...listed];
  const here = [...(actingAs ? [actingAs] : []), ...made].filter((each) => each.place === place);
  for (const { person } of here)
    if (!shown.some((each) => each.id === person.id)) shown.push(person);
  return shown;
}

/** The radio the pick shows as in a place: no one, its person, or none when the person is elsewhere. */
function pickedIn(place: string, actingAs: StudioActingAs | undefined): string {
  if (!actingAs) return NO_ONE;
  return actingAs.place === place ? personValue(actingAs.person) : '';
}

function PersonList({ place, shown }: { place: string; shown: readonly StudioPerson[] }) {
  const { actingAs, choose } = useActingAs();
  return (
    <RadioList
      label="Person"
      value={pickedIn(place, actingAs)}
      onChange={(next) => {
        if (next === NO_ONE) choose(undefined);
        const person = shown.find((each) => personValue(each) === next);
        if (person) choose({ place, person });
      }}
    >
      <RadioListItem value={NO_ONE} label="No one" description="Runs act for no one." />
      {shown.map((person) => (
        <RadioListItem
          key={person.id}
          value={personValue(person)}
          label={person.label}
          description={
            <Text type="supporting" color="secondary" maxLines={1} hasTruncateTooltip="end">
              {person.id}
            </Text>
          }
        />
      ))}
    </RadioList>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <Text type="supporting" color="secondary">
      {children}
    </Text>
  );
}

function PeoplePicker({ project, offer }: { project: ProjectSession; offer: StudioPeopleOffer }) {
  const { actingAs } = useActingAs();
  const [place, setPlace] = useState(actingAs?.place ?? offer.places[0]?.id ?? '');
  const placeId = useId();
  const found = usePeopleIn(project, offer, place);
  const fresh = useFreshPerson(project);
  const makingHere = fresh.making?.place === place ? fresh.making : undefined;
  const error = found?.error ?? makingHere?.error;
  return (
    <>
      <Field
        label="Place"
        description="Where the people your app names live."
        inputID={placeId}
        isGroupLabel
      >
        <PlacePicker offer={offer} place={place} onChange={setPlace} />
      </Field>
      <PersonList
        place={place}
        shown={shownPeople(place, found?.people ?? [], actingAs, fresh.made)}
      />
      {offer.existing && !found && <Muted>Finding the people here…</Muted>}
      {offer.fresh && (
        <HStack>
          <Button
            label="New person"
            variant="secondary"
            icon={<Icon icon={IconPlus} size="sm" />}
            isDisabled={makingHere !== undefined && makingHere.error === undefined}
            onClick={() => {
              fresh.make(place);
            }}
          />
        </HStack>
      )}
      {error && <Muted>{error}</Muted>}
    </>
  );
}

function PeopleSettings({ project }: { project: ProjectSession }) {
  const { offer, problem } = useActingAs();
  return (
    <Group
      title="Who a run acts as"
      about="Your app's tools act for this person. Your setup file names the places and the people, and makes new ones."
    >
      {offer ? (
        <PeoplePicker project={project} offer={offer} />
      ) : (
        <Muted>{problem ?? 'Your setup file offers no people, so every run acts as no one.'}</Muted>
      )}
    </Group>
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
      <Group
        title="Open project"
        about="What the studio command opened. The studio reads it from your files."
      >
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
        <MetadataListItem label="Project server">
          {new URL(project.endpoint, location.href).origin}
        </MetadataListItem>
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
    case 'people':
      return <PeopleSettings project={props.project} />;
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
        <Heading level={3}>theorem studio</Heading>
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

/** The widest the settings grow, so a wide screen does not stretch a row across it. */
const SETTINGS_WIDTH = '72rem';

/** Settings, inside the studio's panel: the panel widens over the preview to hold them. */
export function StudioSettings(props: StudioSettingsProps) {
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const { section } = useSettingsDoor();
  return (
    <Section variant="transparent" height="100%" padding={0}>
      {/* Starts at the left edge, as the tree and editor do; the settings keep a readable width. */}
      <Layout
        height="fill"
        start={
          isNarrow ? undefined : (
            <Section
              variant="transparent"
              width={NAV_WIDTH}
              height="100%"
              padding={4}
              dividers={['end']}
            >
              <VStack gap={4} height="100%">
                <SettingsNavHead project={props.project} version={props.version} />
                <TreeList
                  className="studio-settings-tree"
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
            <Section
              variant="transparent"
              padding={3}
              maxWidth={SETTINGS_WIDTH}
              className="studio-settings-body"
            >
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
