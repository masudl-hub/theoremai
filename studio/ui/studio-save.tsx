import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { IconFiles, IconListDetails } from '@tabler/icons-react';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	atStart,
	removeAgent,
	resetAgent,
	type StudioWorkspace,
	startedHere,
} from '../mod.ts';
import type {
	DiffHunk,
	SaveChange,
	SaveFile,
	SaveRefusal,
	SaveReview,
} from '../server/save-wire.ts';
import { type ProjectSession, reviewSave, undoSave, writeSave } from './lib/studio-project.ts';

/** Wide enough for a reason's sentence to read in a few lines. */
const ALERTS_WIDTH = 320;

export type Update = (change: (current: StudioWorkspace) => StudioWorkspace) => void;

/** Where Save is: closed, reading the review, showing it, or writing it. */
type SaveStep =
	| { at: 'closed' }
	| { at: 'reading' }
	| { at: 'review'; review: SaveReview; writing: boolean; refusal?: SaveRefusal }
	| { at: 'refused'; refusal: SaveRefusal };

const DIALOG_WIDTH = 720;
/** How long the saved line stays, in milliseconds: long enough to reach Undo. */
const UNDO_WINDOW = 15_000;

/** Why nothing was written, as the builder reads it. */
const REFUSED: Record<SaveRefusal['reason'], string> = {
	issues: 'Fix the issues in the editor first.',
	stale: 'Your files changed after this review was made. Close it and review again.',
	unwritable: 'Some changes cannot be written to your files.',
	check: 'The project did not type-check with these changes, so your files were put back.',
	load: 'The project did not start with these changes, so your files were put back.',
	differs: 'The files did not load as what you tested, so they were put back.',
	nothing: 'There is no save to undo.',
};

/** A server that did not answer, as a refusal the dialog can show. */
function unreachable(error: unknown): SaveRefusal {
	return {
		ok: false,
		reason: 'load',
		detail: [error instanceof Error ? error.message : String(error)],
	};
}

/** Where a change is set, as `file:line`. */
function place(change: SaveChange): string {
	if (!change.file) return 'your files';
	return change.line ? `${change.file}:${String(change.line)}` : change.file;
}

/** Why a change inside a constant is not written: who else reads the constant, and the way through. */
function constantReason(change: SaveChange): string {
	const name = change.name ?? 'a constant';
	if (change.readByCode || !change.sharedWith?.length) {
		const also = change.readByCode ? ', which other code reads too' : '';
		return `Set by ${name} in ${place(change)}${also}. Change it there.`;
	}
	const others = change.sharedWith.join(', ');
	const hold = change.sharedWith.length > 1 ? 'do' : 'does';
	return `${name} in ${place(change)} is shared with ${others}, which ${hold} not hold this change. Make it on each, or change it there.`;
}

/** Why one change is not written, and what the builder does about it. */
function reason(change: SaveChange): string {
	switch (change.status) {
		case 'constant':
			return constantReason(change);
		case 'code':
			return `Set in code at ${place(change)}. Change it there.`;
		case 'changed':
			return `${place(change)} changed after the studio opened it. Reload the studio.`;
		case 'unused':
			return 'No agent allows this tool yet. Allow it on an agent, or remove it.';
		case 'taken':
			return `A file is already at ${place(change)}. Rename the ${change.kind}, or move that file.`;
		case 'setup':
			return `The studio cannot tell where ${place(change)} would register a new ${change.kind}. Add it in your code.`;
		case 'removed':
			return change.file
				? `The studio cannot tell how ${place(change)} registers this ${change.kind}. Remove it in your code.`
				: `The studio could not find where your files register this ${change.kind}. Remove it in your code.`;
		default:
			return 'The studio could not find where your files set this.';
	}
}

/** One run of changed lines: the lines taken out marked `-`, the lines put in marked `+`. */
function HunkBlock({ file, hunk }: { file: SaveFile; hunk: DiffHunk }) {
	const lines = [
		...hunk.lead.map((line) => `  ${line}`),
		...hunk.removed.map((line) => `- ${line}`),
		...hunk.added.map((line) => `+ ${line}`),
		...hunk.trail.map((line) => `  ${line}`),
	];
	const firstAdded = hunk.lead.length + hunk.removed.length + 1;
	return (
		<CodeBlock
			code={lines.join('\n')}
			language="diff"
			title={
				file.created || file.removed
					? `${fileNote(file)} · ${file.file}`
					: `${file.file}:${String(hunk.line)}`
			}
			size="sm"
			hasCopyButton={false}
			highlightLines={hunk.added.map((_, index) => firstAdded + index)}
		/>
	);
}

/** What happens to a file: it is new, it goes, or how many places in it change. */
function fileNote(file: SaveFile): string {
	if (file.created) return 'New file';
	if (file.removed) return 'Removed file';
	return file.hunks.length === 1 ? '1 change' : `${String(file.hunks.length)} changes`;
}

function FileHunks({ file }: { file: SaveFile }) {
	return (
		<VStack gap={3}>
			{file.hunks.map((hunk) => (
				<HunkBlock key={hunk.line} file={file} hunk={hunk} />
			))}
		</VStack>
	);
}

/** The changes Save cannot write, each with what the builder does about it. */
function BlockedChanges({ changes }: { changes: readonly SaveChange[] }) {
	if (!changes.length) return null;
	return (
		<VStack gap={4}>
			<Banner
				status="warning"
				title="Save writes every change or none, so your files hold exactly what you tested."
				description="Reset the changes below in the studio, or make them in your code."
			/>
			{changes.map((change) => (
				<VStack key={`${change.kind}:${change.of}:${change.setting}`} gap={1}>
					<Text weight="semibold">
						{change.setting ? `${change.of} · ${change.setting}` : change.of}
					</Text>
					<Text type="supporting" color="secondary">
						{reason(change)}
					</Text>
				</VStack>
			))}
		</VStack>
	);
}

/** How the review reads: every file down one scroll, or one file at a time. */
type ReviewView = 'all' | 'file';

/** The button that flips the review's view: it names the view it goes to. */
const VIEW_FLIP = {
	all: { label: 'By file', icon: IconFiles, tooltip: 'Show one file at a time', next: 'file' },
	file: {
		label: 'All changes',
		icon: IconListDetails,
		tooltip: 'Show every change in one scroll',
		next: 'all',
	},
} as const;

/**
 * The lines Save changes. Down one scroll, each file's name stays at the top while its changes
 * pass. By file, a tab for each file stays there and shows that file alone.
 */
function ReviewBody({ review, view }: { review: SaveReview; view: ReviewView }) {
	const [picked, setPicked] = useState<string>();
	const { files } = review;
	const blocked = review.changes.filter((change) => change.status !== 'written');
	const shown = files.find((file) => file.file === picked) ?? files[0];
	return (
		<>
			{review.changes.length === 0 && (
				<Text color="secondary">Nothing here changes what your files set.</Text>
			)}
			<BlockedChanges changes={blocked} />
			{view === 'file'
				? shown && (
						<VStack gap={2}>
							<div className="save-file">
								<TabList value={shown.file} size="sm" onChange={setPicked}>
									{files.map((file) => (
										<Tab key={file.file} value={file.file} label={file.file} />
									))}
								</TabList>
							</div>
							<FileHunks file={shown} />
						</VStack>
					)
				: files.map((file) => (
						<VStack key={file.file} gap={2}>
							<div className="save-file">
								<HStack gap={2} vAlign="center">
									<Text weight="semibold">{file.file}</Text>
									<Text type="supporting" color="secondary">
										{fileNote(file)}
									</Text>
								</HStack>
							</div>
							<FileHunks file={file} />
						</VStack>
					))}
		</>
	);
}

function RefusalBody({ refusal }: { refusal: SaveRefusal }) {
	return (
		<VStack gap={3}>
			<Banner status="error" title={REFUSED[refusal.reason]} />
			{refusal.detail.length > 0 && (
				<CodeBlock code={refusal.detail.join('\n')} size="sm" isWrapped maxHeight={320} />
			)}
		</VStack>
	);
}

/**
 * The profiles a project registers that the studio cannot run: a count that shows each one's
 * reason on hover. Nothing while there are none.
 */
function ProjectProblems({ project }: { project: ProjectSession }) {
	const { problems } = project;
	if (!problems.length) return null;
	return (
		<HoverCard
			label="Profiles the studio cannot run"
			touchTrigger="tap"
			content={
				<VStack gap={3} width={ALERTS_WIDTH}>
					{problems.map((problem) => (
						<VStack key={problem.profile} gap={1}>
							<Text weight="semibold">{`The studio cannot run ${problem.profile}.`}</Text>
							<Text type="supporting" color="secondary">
								{problem.message}
							</Text>
						</VStack>
					))}
				</VStack>
			}
		>
			<Token
				label={problems.length === 1 ? '1 alert' : `${String(problems.length)} alerts`}
				color="orange"
			/>
		</HoverCard>
	);
}

/** Save, for whatever on the page offers it. */
export interface ProjectSaveActions {
	/** Whether the studio holds edits the project's files do not. */
	unsaved: boolean;
	/** Opens the review of the lines a Save writes. Absent while Save cannot start. */
	review: (() => void) | undefined;
	/** Puts one profile back as the files hold it. One the files do not hold leaves the studio. */
	clear: (agentId: string) => void;
}

const ProjectSaveContext = createContext<ProjectSaveActions | null>(null);

/** Save for the open project, or null on a page that has none. */
export function useProjectSave(): ProjectSaveActions | null {
	return useContext(ProjectSaveContext);
}

/**
 * Whether clearing a profile removes it: it was added here, the files do not hold it, and it has
 * no changes of its own left to drop.
 */
export function clearRemoves(
	workspace: StudioWorkspace,
	agentId: string,
	profiles: readonly string[],
): boolean {
	const agent = workspace.agents.find((each) => each.identity.agentId === agentId);
	const start = agent && workspace.starts.agents[agent.key];
	if (!agent || !start || profiles.includes(start.identity.agentId)) return false;
	return resetAgent(workspace, agent.key) === workspace;
}

/** One profile as the files hold it: back to its start, or gone when it was added here. */
function clearProfile(
	workspace: StudioWorkspace,
	agentId: string,
	profiles: readonly string[],
): StudioWorkspace {
	const agent = workspace.agents.find((each) => each.identity.agentId === agentId);
	if (!agent) return workspace;
	return clearRemoves(workspace, agentId, profiles)
		? removeAgent(workspace, agent.key)
		: resetAgent(workspace, agent.key);
}

/**
 * Save for a project: the review of the lines that change before anything is written, and the
 * write. Whatever it wraps opens that review through `useProjectSave`.
 */
export function ProjectSave({
	project,
	workspace,
	update,
	onFilesChanged,
	blocked,
	children,
}: {
	project: ProjectSession;
	workspace: StudioWorkspace;
	update: Update;
	/** Called once a Save or an undo has changed the project's files. */
	onFilesChanged: () => void;
	/** Whether Save cannot start: the editor has issues. */
	blocked: boolean;
	children: ReactNode;
}) {
	const toast = useToast();
	const [step, setStep] = useState<SaveStep>({ at: 'closed' });
	const [view, setView] = useState<ReviewView>('all');
	// An agent added here is at its own start, and still one the files do not hold. One removed
	// here has no start left, and is still one the files hold.
	const clean = useMemo(
		() =>
			atStart(workspace) &&
			workspace.agents.length === project.profiles.length &&
			workspace.agents.every((agent) => project.profiles.includes(agent.identity.agentId)),
		[workspace, project.profiles],
	);

	// The review reads the workspace as it is when asked for, so a keystroke does not remake Save.
	const held = useRef({ project, workspace });
	useEffect(() => {
		held.current = { project, workspace };
	});
	const open = useCallback(() => {
		setStep({ at: 'reading' });
		reviewSave(held.current.project, held.current.workspace)
			.catch(unreachable)
			.then((answer) => {
				setStep(
					answer.ok
						? { at: 'review', review: answer, writing: false }
						: { at: 'refused', refusal: answer },
				);
			});
	}, []);
	const clear = useCallback(
		(agentId: string) => {
			update((current) => clearProfile(current, agentId, held.current.project.profiles));
		},
		[update],
	);

	const undo = (starts: StudioWorkspace['starts']) => {
		undoSave(project)
			.catch(unreachable)
			.then((answer) => {
				if (!answer.ok) {
					toast({ type: 'error', body: REFUSED[answer.reason] });
					return;
				}
				// The edits stay in the studio, unsaved again.
				update((current) => ({ ...current, starts }));
				onFilesChanged();
				toast({ body: `Put ${answer.written.join(', ')} back.` });
			});
	};

	const write = (review: SaveReview) => {
		setStep({ at: 'review', review, writing: true });
		writeSave(project, workspace, review.stamp)
			.catch(unreachable)
			.then((answer) => {
				if (!answer.ok) {
					setStep({ at: 'review', review, writing: false, refusal: answer });
					return;
				}
				const { starts } = workspace;
				update(() => startedHere(workspace));
				onFilesChanged();
				setStep({ at: 'closed' });
				const dismiss = toast({
					body: `Saved to ${answer.written.join(', ')}.`,
					autoHideDuration: UNDO_WINDOW,
					endContent: (
						<Button
							label="Undo"
							variant="ghost"
							size="sm"
							onClick={() => {
								undo(starts);
								dismiss();
							}}
						/>
					),
				});
			});
	};

	const unsaved = !clean || step.at !== 'closed';
	const actions = useMemo(
		() => ({ unsaved, review: blocked ? undefined : open, clear }),
		[unsaved, blocked, open, clear],
	);
	const writing = step.at === 'review' && step.writing;
	const refusal = step.at === 'refused' || step.at === 'review' ? step.refusal : undefined;
	const flip = VIEW_FLIP[view];
	return (
		<ProjectSaveContext.Provider value={actions}>
			{children}
			<Dialog
				isOpen={step.at === 'review' || step.at === 'refused'}
				purpose={writing ? 'required' : 'form'}
				width={DIALOG_WIDTH}
				maxHeight="80vh"
				onOpenChange={(isOpen) => {
					if (!isOpen && !writing) setStep({ at: 'closed' });
				}}
			>
				<Layout
					header={
						<DialogHeader
							title={`Save to ${project.name}`}
							subtitle={
								writing
									? 'Checking that the project still loads with these lines.'
									: 'Save writes all of these lines or none. It then type-checks and loads the project, and puts your files back unless it runs as what you tested.'
							}
							endContent={
								step.at === 'review' && (
									<IconButton
										label={flip.label}
										variant="ghost"
										icon={<Icon icon={flip.icon} size="sm" />}
										tooltip={flip.tooltip}
										onClick={() => {
											setView(flip.next);
										}}
									/>
								)
							}
							onOpenChange={writing ? undefined : () => setStep({ at: 'closed' })}
						/>
					}
					content={
						<LayoutContent isScrollable={false} padding={0}>
							<ScrollableArea label="Changes" height="100%" paddingInline={4}>
								<VStack gap={4}>
									{refusal && <RefusalBody refusal={refusal} />}
									{step.at === 'review' && <ReviewBody review={step.review} view={view} />}
								</VStack>
							</ScrollableArea>
						</LayoutContent>
					}
					footer={
						<LayoutFooter>
							<HStack gap={2} justify="end">
								<Button
									label="Cancel"
									variant="ghost"
									isDisabled={writing}
									onClick={() => {
										setStep({ at: 'closed' });
									}}
								/>
								{step.at === 'review' && (
									<Button
										label="Save"
										variant="primary"
										isDisabled={!step.review.writable}
										isLoading={writing}
										onClick={() => {
											write(step.review);
										}}
									/>
								)}
							</HStack>
						</LayoutFooter>
					}
				/>
			</Dialog>
		</ProjectSaveContext.Provider>
	);
}

/**
 * A project's tokens in the editor's toolbar: Save while the studio holds edits the files do not,
 * and what the studio cannot run. Nothing while there is neither.
 */
export function ProjectTokens({ project }: { project: ProjectSession }) {
	const save = useProjectSave();
	return (
		<>
			{/* While the editor has issues, its own count stands here and leads to each one. */}
			{save?.unsaved && save.review && (
				<Token
					label="Save"
					color="blue"
					description="Review the diff, then save"
					onClick={save.review}
				/>
			)}
			<ProjectProblems project={project} />
		</>
	);
}
