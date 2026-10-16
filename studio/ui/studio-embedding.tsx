import { Button } from '@astryxdesign/core/Button';
import { FileInput } from '@astryxdesign/core/FileInput';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Section } from '@astryxdesign/core/Section';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import {
	ConsoleFrame,
	ConsoleRequestCard,
	ResponseColumn,
	RunBar,
	useTraceInspector,
} from '@theoremjs/react/ui';
import type { EmbeddingTransport, TraceFeed } from '@theoremjs/react/client';
import { resolveObservabilityPolicy } from '@theoremjs/agents';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { EmbeddingInput, EmbeddingResult } from '@theoremjs/agents';
import {
	createStudioEmbeddingTransport,
	type StudioRunPayload,
} from '../mod.ts';
import {
	createBrowserStudioEmbeddingTransport,
	type StudioBrowserRuntime,
} from '../browser.ts';

type EmbeddingRow = { id: number; text: string; file?: File };

function readFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error('The selected file could not be read.'));
		reader.onload = () => {
			if (typeof reader.result !== 'string') {
				reject(new Error('The selected file did not produce readable data.'));
				return;
			}
			resolve(reader.result.split(',', 2)[1] ?? '');
		};
		reader.readAsDataURL(file);
	});
}

async function inputFor(row: EmbeddingRow): Promise<EmbeddingInput> {
	if (!row.file) return row.text;
	const data = await readFile(row.file);
	return {
		parts: [
			...(row.text.trim() ? [{ type: 'text' as const, text: row.text }] : []),
			{ type: 'media' as const, mimeType: row.file.type, data },
		],
	};
}

export function StudioEmbedding({
	payload,
	runtime = null,
	traces,
	trace,
	flush,
	columns,
	className,
}: {
	payload: StudioRunPayload;
	runtime?: StudioBrowserRuntime | null;
	traces?: TraceFeed;
	trace?: boolean;
	flush?: boolean;
	columns?: boolean;
	className?: string;
}) {
	const transport = useMemo(
		() =>
			runtime
				? createBrowserStudioEmbeddingTransport(payload, runtime, { traces })
				: createStudioEmbeddingTransport(payload, { traces }),
		[payload, runtime, traces],
	);
	const [rows, setRows] = useState<EmbeddingRow[]>([{ id: 1, text: '' }]);
	const [result, setResult] = useState<EmbeddingResult>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [iface, setIface] = useState<Awaited<ReturnType<EmbeddingTransport['describe']>>>();
	const [controller, setController] = useState<AbortController>();
	useEffect(() => {
		let active = true;
		void transport.describe().then(
			(next) => {
				if (active) setIface(next);
			},
			(cause) => {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			},
		);
		return () => {
			active = false;
		};
	}, [transport]);
	const accepts = iface?.inputs.attachments?.accept.join(',');
	const inspector = useTraceInspector(
		{
			observability: payload.profile.observability
				? { record: resolveObservabilityPolicy(payload.profile.observability).record }
				: undefined,
		},
		traces,
		trace,
	);

	async function run() {
		const nextController = new AbortController();
		setController(nextController);
		setBusy(true);
		setError(undefined);
		try {
			const input = await Promise.all(rows.map(inputFor));
			const response = await transport.embed(input, undefined, nextController.signal);
			setResult(response.result);
		} catch (cause) {
			if (!nextController.signal.aborted) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		} finally {
			setBusy(false);
			setController(undefined);
		}
	}

	function stop() {
		controller?.abort();
	}

	return (
		<ConsoleFrame
			inspector={inspector}
			maxWidth="960px"
			flush={flush}
			columns={columns}
			requestLabel="Embedding inputs"
			className={className}
		>
			<EmbeddingRequest rows={rows} accepts={accepts} busy={busy} onRowsChange={setRows} onRun={run} onStop={stop} />
			{(result || error) && (
				<ResponseColumn label="Embedding results">
					<EmbeddingResponse
						result={result}
						error={error}
						labels={rows.map((row) => row.text || row.file?.name || 'Untitled input')}
					/>
				</ResponseColumn>
			)}
		</ConsoleFrame>
	);
}

function EmbeddingRequest({
	rows,
	accepts,
	busy,
	onRowsChange,
	onRun,
	onStop,
}: {
	rows: EmbeddingRow[];
	accepts?: string;
	busy: boolean;
	onRowsChange: Dispatch<SetStateAction<EmbeddingRow[]>>;
	onRun: () => void;
	onStop: () => void;
}) {
	return (
		<ConsoleRequestCard
			title="Embedding inputs"
			onRun={onRun}
		>
			{rows.map((row, index) => (
				<VStack key={row.id} gap={3}>
						<HStack gap={2} vAlign="center">
							<StackItem size="fill">
							<Text type="label" weight="semibold">
								Input {index + 1}
							</Text>
						</StackItem>
						{rows.length > 1 && (
							<IconButton
								label="Remove input"
								variant="ghost"
								size="sm"
								icon={<Icon icon={IconTrash} size="sm" />}
								onClick={() =>
									onRowsChange((current) =>
										current.filter((candidate) => candidate.id !== row.id),
									)
								}
							/>
						)}
					</HStack>
					<TextArea
						label={`Input ${index + 1}`}
						isLabelHidden
						rows={5}
						value={row.text}
						placeholder="Enter text to embed"
						onChange={(text) =>
							onRowsChange((current) =>
								current.map((candidate) =>
									candidate.id === row.id ? { ...candidate, text } : candidate,
								),
							)
						}
					/>
					{accepts && (
						<FileInput
							label="Media"
							mode="dropzone"
							accept={accepts}
							value={row.file ? [row.file] : null}
							placeholder="Drop a supported file or choose one"
							onChange={(files) => {
								const file = Array.isArray(files) ? files[0] : files;
								if (file) {
									onRowsChange((current) =>
										current.map((candidate) =>
											candidate.id === row.id ? { ...candidate, file } : candidate,
										),
									);
								}
							}}
						/>
					)}
				</VStack>
			))}
			<Button
				label="Add input"
				variant="ghost"
				size="sm"
				icon={<Icon icon={IconPlus} size="sm" />}
				onClick={() => onRowsChange((current) => [
					...current,
					{ id: Math.max(...current.map((candidate) => candidate.id), 0) + 1, text: '' },
				])}
			/>
			<RunBar
				note="Text or supported media"
				isReady={rows.length > 0}
				isRunning={busy}
				runLabel="Run embedding"
				runningLabel="Embedding…"
				stopLabel="Stop"
				onRun={onRun}
				onStop={onStop}
			/>
		</ConsoleRequestCard>
	);
}

function EmbeddingResponse({
	result,
	error,
	labels,
}: {
	result?: EmbeddingResult;
	error?: string;
	labels: string[];
}) {
	return (
		<VStack gap={3}>
			{error && <Text type="supporting" color="accent">{error}</Text>}
			{result ? (
				<VStack gap={3}>
					<Text type="supporting">
						{result.embeddings.length} {result.embeddings.length === 1 ? 'vector' : 'vectors'} from {result.model}
					</Text>
					<VStack gap={1}>
						{result.embeddings.map((embedding) => (
							<Text key={embedding.index} type="supporting">
								{labels[embedding.index] ?? `Input ${embedding.index + 1}`} ·{' '}
								{embedding.dimensions} dimensions
							</Text>
						))}
					</VStack>
					{result.usage?.inputTokens !== undefined && (
						<Text type="supporting">{result.usage.inputTokens} input tokens</Text>
					)}
					{result.embeddings.length > 1 && <EmbeddingSpace result={result} labels={labels} />}
				</VStack>
			) : (
				<Text type="supporting">Run the profile to inspect normalized vectors.</Text>
			)}
		</VStack>
	);
}

function EmbeddingSpace({ result, labels }: { result: EmbeddingResult; labels: string[] }) {
	return (
		<VStack gap={2}>
			<Text type="label" weight="semibold">Embedding space</Text>
			<Text type="supporting">Normalized vectors are ready for exploration.</Text>
			<VStack gap={1}>
				{result.embeddings.map((embedding) => (
					<Section key={embedding.index} padding={2}>
						<HStack gap={2}>
							<StackItem size="fill">
								<Text type="supporting">
									{labels[embedding.index] ?? `Input ${embedding.index + 1}`}
								</Text>
							</StackItem>
							<Text type="code" size="sm">
								[
								{embedding.values.slice(0, 3).map((value) => value.toFixed(4)).join(', ')}
								…]
							</Text>
						</HStack>
					</Section>
				))}
			</VStack>
		</VStack>
	);
}
