import { FileInput } from '@astryxdesign/core/FileInput';
import { useState } from 'react';
import { type DecisionImages, IMAGE_ACCEPT, readImage } from '../client/decision-images.ts';
import { useLabels } from './labels-provider.tsx';

/** The files a file input reports, as a list. */
function asList(files: File | File[] | null): File[] {
  if (files === null) return [];
  return Array.isArray(files) ? files : [files];
}

/**
 * Reads each file as an image and hands over the ones that are, with the name of the first that
 * is not as the refusal to show.
 */
export function useImageReader() {
  const t = useLabels();
  const [refused, setRefused] = useState<string | null>(null);
  const read = async (files: File | File[] | null) => {
    setRefused(null);
    const held: [File, DecisionImages[string]][] = [];
    for (const file of asList(files)) {
      const image = await readImage(file);
      if (image) held.push([file, image]);
      else setRefused(file.name);
    }
    return held;
  };
  const status =
    refused === null
      ? undefined
      : { type: 'error' as const, message: t('@theorem.decision.image_bad', { file: refused }) };
  return { read, status };
}

/** A drop area under the state: each PNG or JPEG dropped or chosen becomes a field that holds it. */
export function ImageDrop({
  onImages,
}: {
  onImages: (files: [File, DecisionImages[string]][]) => void;
}) {
  const t = useLabels();
  const { read, status } = useImageReader();
  return (
    <FileInput
      label={t('@theorem.decision.add_image')}
      isLabelHidden
      mode="dropzone"
      isMultiple
      accept={IMAGE_ACCEPT}
      value={null}
      placeholder={t('@theorem.decision.add_image_hint')}
      status={status}
      statusVariant="detached"
      onChange={(files) => {
        void read(files).then((images) => {
          if (images.length > 0) onImages(images);
        });
      }}
    />
  );
}
