import { AspectRatio } from '@astryxdesign/core/AspectRatio';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { useLocale } from '@astryxdesign/core/i18n';
import { Lightbox } from '@astryxdesign/core/Lightbox';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { VStack } from '@astryxdesign/core/VStack';
import {
  hasLead,
  layoutResult,
  type ResultLayout,
  type ResultMedia,
  returnedMedia,
  withUnit,
} from '@theoremjs/web/client';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Arrive } from './arrive.tsx';
import { CardWall } from './CardWall.tsx';
import { useLabels } from './labels-provider.tsx';
import { keyedByContent } from './row-keys.ts';
import { ShapedData } from './ShapedData.tsx';
import { ChartCard } from './trace-patterns.tsx';
import { VoiceNote } from './VoiceNote.tsx';

const ToolResultChart = lazy(() =>
  import('./ToolResultCharts.tsx').then((module) => ({ default: module.ToolResultChart })),
);

/** Height a chart card holds while its module loads. */
const CHART_CARD_PX = 236;
/** Narrowest a card in the result's wall gets: wide enough for a chart's axis and bars. */
const CARD_PX = 260;

/**
 * What answers the call, laid out from the output in one wall: its figures as
 * stat cards, its series as charts, the images it returned; then its audio.
 */
function ResultLead({
  layout,
  parts = [],
}: {
  layout: ResultLayout;
  parts?: readonly ResultMedia[];
}) {
  const t = useLabels();
  const locale = useLocale();
  const decimal = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    [locale],
  );
  const media = useMemo(
    () => returnedMedia(layout, parts, t('@theorem.host.image')),
    [layout, parts, t],
  );
  const [open, setOpen] = useState<number | null>(null);
  if (!hasLead(layout, media)) return null;
  const { images, audio } = media;
  return (
    <VStack gap={3}>
      <CardWall minWidth={CARD_PX}>
        {layout.figures.map((figure) => (
          <Arrive key={`figure:${figure.key}`}>
            <ChartCard
              title={figure.label}
              value={withUnit(decimal.format(figure.value), figure.unit)}
            />
          </Arrive>
        ))}
        {layout.charts.map((chart) => (
          <Arrive key={`chart:${chart.key}`}>
            <Suspense fallback={<Skeleton height={CHART_CARD_PX} />}>
              <ToolResultChart chart={chart} />
            </Suspense>
          </Arrive>
        ))}
        {images.map((image, index) => (
          <Arrive key={`image:${image.src}`}>
            <ClickableCard
              label={image.alt || 'Open image'}
              padding={0}
              onClick={() => setOpen(index)}
            >
              <AspectRatio ratio={4 / 3} fit="cover">
                <img src={image.src} alt={image.alt} loading="lazy" />
              </AspectRatio>
            </ClickableCard>
          </Arrive>
        ))}
      </CardWall>
      {images.length > 0 ? (
        <Lightbox
          isOpen={open !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) setOpen(null);
          }}
          media={images.map((image) => ({ src: image.src, alt: image.alt }))}
          index={open ?? 0}
          onIndexChange={setOpen}
        />
      ) : null}
      {keyedByContent(audio, (clip) => clip.src).map(({ item: clip, key }) => (
        <Arrive key={key}>
          <VoiceNote src={clip.src} mimeType={clip.mimeType} />
        </Arrive>
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
  // why: A figure's card is its reading: the fields below don't repeat it.
  const ledKeys = useMemo(() => layout.figures.map((figure) => figure.key), [layout]);
  return (
    <ShapedData
      value={output}
      title={t('@theorem.host.response')}
      lead={<ResultLead layout={layout} parts={parts} />}
      ledKeys={ledKeys}
    />
  );
}
