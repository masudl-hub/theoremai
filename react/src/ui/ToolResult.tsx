import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Grid } from '@astryxdesign/core/Grid';
import { Lightbox } from '@astryxdesign/core/Lightbox';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { VStack } from '@astryxdesign/core/VStack';
import { useLocale } from '@astryxdesign/core/i18n';
import { lazy, Suspense, useMemo, useState } from 'react';
import { withUnit } from '../client/shaped-data.ts';
import {
	hasLead,
	layoutResult,
	type ResultImage,
	type ResultLayout,
	type ResultMedia,
	returnedMedia,
} from '../client/tool-result.ts';
import { useLabels } from './labels-provider.tsx';
import { ShapedData } from './ShapedData.tsx';
import { VoiceNote } from './VoiceNote.tsx';
import { ChartCard } from './trace-patterns.tsx';

const ToolResultCharts = lazy(() => import('./ToolResultCharts.tsx').then((module) => ({ default: module.ToolResultCharts })));

/** Narrowest an image card gets. */
const IMAGE_CARD_PX = 200;
/** Height a chart card holds while its module loads. */
const CHART_CARD_PX = 236;

function Images({ images }: { images: readonly ResultImage[] }) {
	const [open, setOpen] = useState<number | null>(null);
	return (
		<>
			{/* Card-sized, in the stat cards' grid; each opens full size. */}
			<Grid columns={{ minWidth: IMAGE_CARD_PX, repeat: 'fill' }} gap={3}>
				{images.map((image, index) => (
					<ClickableCard key={image.src} label={image.alt || 'Open image'} padding={0} onClick={() => setOpen(index)}>
						<AspectRatio ratio={4 / 3} fit="cover">
							<img src={image.src} alt={image.alt} loading="lazy" />
						</AspectRatio>
					</ClickableCard>
				))}
			</Grid>
			<Lightbox
				isOpen={open !== null}
				onOpenChange={(isOpen) => {
					if (!isOpen) setOpen(null);
				}}
				media={images.map((image) => ({ src: image.src, alt: image.alt }))}
				index={open ?? 0}
				onIndexChange={setOpen}
			/>
		</>
	);
}

function Figures({ figures }: { figures: ResultLayout['figures'] }) {
	const locale = useLocale();
	const decimal = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }), [locale]);
	if (figures.length === 0) return null;
	return (
		<Grid columns={{ minWidth: 160, repeat: 'fill' }} gap={3}>
			{figures.map((figure) => (
				<ChartCard key={figure.key} title={figure.label} value={withUnit(decimal.format(figure.value), figure.unit)} />
			))}
		</Grid>
	);
}

/** Charts load with their module; cards hold their place until then. */
function Charts({ charts }: { charts: ResultLayout['charts'] }) {
	if (charts.length === 0) return null;
	return (
		<Suspense
			fallback={
				<Grid columns={{ minWidth: 260, repeat: 'fill' }} gap={3}>
					{charts.map((chart) => (
						<Skeleton key={chart.key} height={CHART_CARD_PX} />
					))}
				</Grid>
			}
		>
			<ToolResultCharts charts={charts} />
		</Suspense>
	);
}

/** What answers the call, laid out from the output: its figures as stat cards, its series as charts, the images and audio it returned. */
function ResultLead({ layout, parts = [] }: { layout: ResultLayout; parts?: readonly ResultMedia[] }) {
	const t = useLabels();
	const media = useMemo(() => returnedMedia(layout, parts, t('@theorem.host.image')), [layout, parts, t]);
	if (!hasLead(layout, media)) return null;
	return (
		<VStack gap={3}>
			<Figures figures={layout.figures} />
			<Charts charts={layout.charts} />
			{media.images.length > 0 ? <Images images={media.images} /> : null}
			{media.audio.map((clip, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: returned media has no identity of its own
				<VoiceNote key={index} src={clip.src} mimeType={clip.mimeType} />
			))}
		</VStack>
	);
}

/**
 * A tool's output under one Response heading, led by what answers it (figures,
 * charts, the images and audio it returned), then the data itself drawn by its shape, with its JSON one
 * tap away. A payload too big to lay out, or a render that throws, shows as JSON.
 */
export function ToolResult({ output, parts }: { output: unknown; parts?: readonly ResultMedia[] }) {
	const t = useLabels();
	const layout = useMemo(() => layoutResult(output), [output]);
	// A figure's card is its reading: the fields below don't repeat it.
	const ledKeys = useMemo(() => layout.figures.map((figure) => figure.key), [layout]);
	return <ShapedData value={output} title={t('@theorem.host.response')} lead={<ResultLead layout={layout} parts={parts} />} ledKeys={ledKeys} />;
}
