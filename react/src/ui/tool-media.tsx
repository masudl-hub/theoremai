import { Token } from '@astryxdesign/core/Token';
import type { ToolOutputRefPart } from '@theoremjs/agents';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import { mediaFileName, type ToolMediaShown } from './tool-media-shown.ts';

export { type ToolMediaShown, toolMediaShows } from './tool-media-shown.ts';

/** A reference a tool returned, with the tool's own `metadata`: the person is shown it, the model never read it. */
export type MediaReference = ToolOutputRefPart;

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
  const latest = useRef(reference);
  latest.current = reference;
  const type = reference?.type;
  const mimeType = reference?.mimeType;
  const uri = reference?.uri;
  const [resolved, setResolved] = useState<{ uri: string; src: string | null }>();
  useEffect(() => {
    const current = latest.current;
    if (current === undefined || type === undefined || mimeType === undefined || uri === undefined)
      return;
    if (!resolve) {
      setResolved({ uri, src: null });
      return;
    }
    let live = true;
    Promise.resolve()
      .then(() => resolve(current))
      .then(
        (src) => live && setResolved({ uri, src: src ?? null }),
        () => live && setResolved({ uri, src: null }),
      );
    return () => {
      live = false;
    };
  }, [resolve, type, mimeType, uri]);
  if (uri === undefined) return null;
  return resolved?.uri === uri ? resolved.src : undefined;
}

/** A reference shown as the file it names, when nothing resolves it to show. */
export function MediaFileToken({ reference }: { reference: MediaReference }) {
  return <Token label={mediaFileName(reference.uri)} description={reference.mimeType} />;
}
