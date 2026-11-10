import { Token } from '@astryxdesign/core/Token';
import type { InteractionMediaRefPart } from '@theoremjs/agents';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import { mediaFileName, type ToolMediaShown } from './tool-media-shown.ts';

export { type ToolMediaShown, toolMediaShows } from './tool-media-shown.ts';

/** A reference a tool returned: the person is shown it, the model never read it. */
export type MediaReference = InteractionMediaRefPart;

/**
 * Turns a tool's reference into an address the page may load, under the viewer's own sign-in, or
 * `null` when there is none. Without it, a reference shows as a named file.
 */
export type ResolveMedia = (reference: MediaReference) => string | null | Promise<string | null>;

/** What a page shows of tool media, and how it loads a reference. */
export type ToolMediaView = { shown: ToolMediaShown; resolve?: ResolveMedia };

const ToolMediaContext = createContext<ToolMediaView>({ shown: 'sent' });

export function ToolMediaProvider({
  media = 'sent',
  resolveMedia,
  children,
}: {
  media?: ToolMediaShown;
  resolveMedia?: ResolveMedia;
  children: ReactNode;
}) {
  return (
    <ToolMediaContext value={{ shown: media, ...(resolveMedia ? { resolve: resolveMedia } : {}) }}>
      {children}
    </ToolMediaContext>
  );
}

export function useToolMedia(): ToolMediaView {
  return use(ToolMediaContext);
}

/**
 * What the resolver makes of `reference`: `undefined` while it works, `null` when it gives no
 * address (or there is no resolver, or it throws).
 */
export function useResolvedMedia(reference: MediaReference | undefined): string | null | undefined {
  const { resolve } = useToolMedia();
  const type = reference?.type;
  const mimeType = reference?.mimeType;
  const uri = reference?.uri;
  const [resolved, setResolved] = useState<{ uri: string; src: string | null }>();
  useEffect(() => {
    if (type === undefined || mimeType === undefined || uri === undefined) return;
    if (!resolve) {
      setResolved({ uri, src: null });
      return;
    }
    let current = true;
    Promise.resolve()
      .then(() => resolve({ type, mimeType, uri }))
      .then(
        (src) => current && setResolved({ uri, src: src ?? null }),
        () => current && setResolved({ uri, src: null }),
      );
    return () => {
      current = false;
    };
  }, [resolve, type, mimeType, uri]);
  if (uri === undefined) return null;
  return resolved?.uri === uri ? resolved.src : undefined;
}

/** A reference shown as the file it names, when nothing resolves it to show. */
export function MediaFileToken({ reference }: { reference: MediaReference }) {
  return <Token label={mediaFileName(reference.uri)} description={reference.mimeType} />;
}
