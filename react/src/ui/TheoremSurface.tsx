import type { DefinedTheme } from '@astryxdesign/core/theme';
import type { ReactNode } from 'react';
import type { TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider } from './labels-provider.tsx';
import { MarkdownPluginsProvider } from './markdown-plugins.tsx';
import type { MediaViewer } from './media-viewer.tsx';
import { TheoremThemeProvider } from './theme.tsx';
import { type ResolveMedia, ToolMediaProvider, type ToolMediaShown } from './tool-media.tsx';

/** What `TheoremSurface` takes: each is the `TheoremChat` prop of the same name. */
export type TheoremSurfaceProps = {
  theme?: DefinedTheme;
  mode?: 'system' | 'light' | 'dark';
  labels?: TheoremLabels;
  detectCodeLanguage?: boolean;
  media?: ToolMediaShown;
  resolveMedia?: ResolveMedia;
  mediaViewer?: MediaViewer;
  children: ReactNode;
};

/**
 * The theme, labels, Markdown plugins, and tool media a chat or a host page draws with. Wrap
 * `TheoremChatComposer` and `TheoremChatTranscript` in it when you place them yourself; it takes
 * what `TheoremChat` takes for each.
 */
export function TheoremSurface({
  theme,
  mode,
  labels,
  detectCodeLanguage,
  media,
  resolveMedia,
  mediaViewer,
  children,
}: TheoremSurfaceProps) {
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <MarkdownPluginsProvider detectCodeLanguage={detectCodeLanguage}>
          <ToolMediaProvider media={media} resolveMedia={resolveMedia} mediaViewer={mediaViewer}>
            {children}
          </ToolMediaProvider>
        </MarkdownPluginsProvider>
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
