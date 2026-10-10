import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Popover } from '@astryxdesign/core/Popover';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { Section } from '@astryxdesign/core/Section';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import { useMemo, useState } from 'react';
import { atStart, type StudioWorkspace, startedHere } from '../mod.ts';
import type {
	DiffHunk,
	SaveChange,
	SaveFile,
	SaveRefusal,
	SaveReview,
} from '../server/save-wire.ts';
import { type ProjectSession, reviewSave, undoSave, writeSave } from './lib/studio-project.ts';

/** Wide enough for a reason's sentence to read in a few lines. */
const POPOVER_WIDTH = 320;

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
function HunkBlock({ file, hunk, whole }: { file: string; hunk: DiffHunk; whole?: string }) {
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
			title={whole ? `${whole} · ${file}` : `${file}:${String(hunk.line)}`}
			size="sm"
			hasCopyButton={false}
			highlightLines={hunk.added.map((_, index) => firstAdded + index)}
		/>
	);
}

function ReviewBody({ review }: { review: SaveReview }) {
	const blocked = review.changes.filter((change) => change.status !== 'written');
	if (review.changes.length === 0)
		return <Text color="secondary">Nothing here changes what your files set.</Text>;
	return (
		<VStack gap={4}>
			{blocked.length > 0 && (
				<Banner
					status="warning"
					title="Save writes every change or none, so your files hold exactly what you tested."
					description="Reset the changes below in the studio, or make them in your code."
				/>
			)}
			{blocked.map((change) => (
				<VStack key={`${change.kind}:${change.of}:${change.setting}`} gap={1}>
					<Text weight="semibold">
						{change.setting ? `${change.of} · ${change.setting}` : change.of}
					</Text>
					<Text type="supporting" color="secondary">
						{reason(change)}
					</Text>
				</VStack>
			))}
			{review.files.flatMap((file: SaveFile) =>
				file.hunks.map((hunk) => (
					<HunkBlock
						key={`${file.file}:${String(hunk.line)}`}
						file={file.file}
						hunk={hunk}
						whole={file.created ? 'New file' : file.removed ? 'Removed file' : undefined}
					/>
				)),
			)}
		</VStack>
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
 * The profiles a project registers that the studio cannot run: a count that opens each one's
 * reason. Nothing while there are none.
 */
function ProjectProblems({ project }: { project: ProjectSession }) {
	const { problems } = project;
	if (!problems.length) return null;
	return (
		<Popover
			label="Profiles the studio cannot run"
			width={POPOVER_WIDTH}
			padding={3}
			content={
				<VStack gap={3}>
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
		</Popover>
	);
}

/**
 * A project's line over the editor: Save while the studio holds edits the files do not, with a
 * review of the lines that change before anything is written, and what the studio cannot run.
 * Nothing while there is neither.
 */
export function ProjectLine({
	project,
	workspace,
	update,
	onFilesChanged,
	blocked,
}: {
	project: ProjectSession;
	workspace: StudioWorkspace;
	update: Update;
	/** Called once a Save or an undo has changed the project's files. */
	onFilesChanged: () => void;
	/** Why Save cannot start: the editor has issues. */
	blocked: string | undefined;
}) {
	const toast = useToast();
	const [step, setStep] = useState<SaveStep>({ at: 'closed' });
	// An agent added here is at its own start, and still one the files do not hold. One removed
	// here has no start left, and is still one the files hold.
	const clean = useMemo(
		() =>
			atStart(workspace) &&
			workspace.agents.length === project.profiles.length &&
			workspace.agents.every((agent) => project.profiles.includes(agent.identity.agentId)),
		[workspace, project.profiles],
	);

	const open = () => {
		setStep({ at: 'reading' });
		reviewSave(project, workspace)
			.catch(unreachable)
			.then((answer) => {
				setStep(
					answer.ok
						? { at: 'review', review: answer, writing: false }
						: { at: 'refused', refusal: answer },
				);
			});
	};

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

	const saved = clean && step.at === 'closed';
	if (saved && !project.problems.length) return null;
	const writing = step.at === 'review' && step.writing;
	return (
		<Section variant="transparent" paddingInline={3} paddingBlock={2} dividers={['bottom']}>
			<HStack gap={2} vAlign="center">
				<StackItem size="fill">
					{!saved && (
						<Token
							label={blocked ?? 'Review and save'}
							color="blue"
							description={`Your edits are not in ${project.name}'s files yet`}
							onClick={blocked || step.at === 'reading' ? undefined : open}
						/>
					)}
				</StackItem>
				<ProjectProblems project={project} />
			</HStack>
			<Dialog
				isOpen={step.at === 'review' || step.at === 'refused'}
				purpose={writing ? 'required' : 'form'}
				width={DIALOG_WIDTH}
				maxHeight="80vh"
				onOpenChange={(isOpen) => {
					if (!isOpen && !writing) setStep({ at: 'closed' });
				}}
			>
				<VStack gap={4} height="100%">
					<DialogHeader
						title={`Save to ${project.name}`}
						subtitle={
							writing
								? 'Checking that the project still loads with these lines.'
								: 'These lines change in your files. The studio does not commit them.'
						}
					/>
					<ScrollableArea label="Changes">
						{step.at === 'refused' && <RefusalBody refusal={step.refusal} />}
						{step.at === 'review' && (
							<VStack gap={4}>
								{step.refusal && <RefusalBody refusal={step.refusal} />}
								<ReviewBody review={step.review} />
							</VStack>
						)}
					</ScrollableArea>
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
								isDisabled={!step.review.writable}
								isLoading={writing}
								onClick={() => {
									write(step.review);
								}}
							/>
						)}
					</HStack>
				</VStack>
			</Dialog>
		</Section>
	);
}
