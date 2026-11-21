import { Lightbox } from '@astryxdesign/core/Lightbox';
import { type ReactNode, useState } from 'react';
import { type MediaReference, useToolMedia } from './tool-media.tsx';

/** One picture or video the viewer shows. */
export type MediaViewerItem = {
  type: 'image' | 'video';
  /** The address the page loads it from. */
  src: string;
  alt: string;
  caption?: ReactNode;
  /** The saved file it was loaded from, when the app saved it: `src` may be a link that expires. */
  reference?: MediaReference;
};

/** What a viewer is given: it is open or closed, and shows `media[index]`. */
export type MediaViewerProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  media: readonly MediaViewerItem[];
  index: number;
  onIndexChange: (index: number) => void;
};

/** The viewer every picture and video in Theorem opens in. Astryx's Lightbox, with zoom, unless the page gives its own. */
export type MediaViewer = (props: MediaViewerProps) => ReactNode;

/** Astryx's Lightbox, with zoom: the viewer when the page gives none. */
export function AstryxMediaViewer({
  isOpen,
  onOpenChange,
  media,
  index,
  onIndexChange,
}: MediaViewerProps) {
  return (
    <Lightbox
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      media={media.map(({ src, alt, caption, type }) => ({ src, alt, caption, type }))}
      index={index}
      onIndexChange={onIndexChange}
      hasZoom
    />
  );
}

/** The page's viewer, held open or closed by its caller. */
export function PageMediaViewer(props: MediaViewerProps) {
  const Viewer = useToolMedia().viewer ?? AstryxMediaViewer;
  return <Viewer {...props} />;
}

/** The page's viewer over `media`, closed until `open`; render `element` where the viewer belongs. */
export function useMediaViewer(media: readonly MediaViewerItem[]): {
  open: (index?: number) => void;
  element: ReactNode;
} {
  const [shown, setShown] = useState<{ isOpen: boolean; index: number }>({
    isOpen: false,
    index: 0,
  });
  return {
    open: (index = 0) => setShown({ isOpen: true, index }),
    element:
      media.length > 0 ? (
        <PageMediaViewer
          isOpen={shown.isOpen}
          onOpenChange={(isOpen) => setShown((current) => ({ ...current, isOpen }))}
          media={media}
          index={shown.index}
          onIndexChange={(index) => setShown((current) => ({ ...current, index }))}
        />
      ) : null,
  };
}
