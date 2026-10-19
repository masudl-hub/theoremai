import { Button } from '@astryxdesign/core/Button';
import { FieldStatus } from '@astryxdesign/core/FieldStatus';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { VStack } from '@astryxdesign/core/VStack';
import { IconPhotoPlus, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import {
  type DecisionImages,
  IMAGE_ACCEPT,
  imageName,
  imageSrc,
  readImage,
} from '../client/decision-images.ts';
import { useLabels } from './labels-provider.tsx';

/** One attached image: its thumbnail and name, and the button that removes it. */
function ImageChip({
  name,
  images,
  onChange,
}: {
  name: string;
  images: DecisionImages;
  onChange: (next: DecisionImages) => void;
}) {
  const t = useLabels();
  return (
    <HStack gap={2} vAlign="center">
      <Thumbnail src={imageSrc(images[name])} alt={name} label={name} />
      <Text size="sm" maxLines={1}>
        {name}
      </Text>
      <IconButton
        label={t('@theorem.decision.remove_image', { name })}
        size="sm"
        variant="ghost"
        icon={<IconX size={14} />}
        onClick={() => {
          const { [name]: _removed, ...rest } = images;
          onChange(rest);
        }}
      />
    </HStack>
  );
}

/**
 * The images attached to a decision that no state field shows, a chip for each, and a button that
 * adds more. `inFields` names the ones a field already shows.
 */
export function ImagesField({
  images,
  inFields,
  onChange,
}: {
  images: DecisionImages;
  inFields: ReadonlySet<string>;
  onChange: (next: DecisionImages) => void;
}) {
  const t = useLabels();
  const input = useRef<HTMLInputElement>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const names = Object.keys(images);

  const attach = async (files: FileList | null) => {
    let next = images;
    setRefused(null);
    for (const file of Array.from(files ?? [])) {
      const image = await readImage(file);
      if (!image) {
        setRefused(file.name);
        continue;
      }
      next = { ...next, [imageName(file.name, Object.keys(next))]: image };
    }
    onChange(next);
  };

  return (
    <VStack gap={2}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Text type="supporting" color="secondary">
          {t('@theorem.decision.images')}
        </Text>
        {names
          .filter((name) => !inFields.has(name))
          .map((name) => (
            <ImageChip key={name} name={name} images={images} onChange={onChange} />
          ))}
        <Button
          label={t('@theorem.decision.attach')}
          variant="ghost"
          size="sm"
          icon={<IconPhotoPlus size={16} />}
          onClick={() => input.current?.click()}
        />
        <input
          ref={input}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            void attach(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
      </HStack>
      {names.length > 0 ? (
        <Text type="supporting" color="secondary">
          {t('@theorem.decision.image_hint', { name: names[0] })}
        </Text>
      ) : null}
      {refused === null ? null : (
        <FieldStatus
          type="error"
          message={t('@theorem.decision.image_bad', { file: refused })}
          variant="detached"
        />
      )}
    </VStack>
  );
}
