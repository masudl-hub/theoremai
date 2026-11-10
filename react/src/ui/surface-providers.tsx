import type { DefinedTheme } from '@astryxdesign/core/theme';
import type { ReactNode } from 'react';
import type { TheoremLabels } from './labels.ts';
import { TheoremLabelsProvider } from './labels-provider.tsx';
import { MarkdownPluginsProvider } from './markdown-plugins.tsx';
import { TheoremThemeProvider } from './theme.tsx';
import { type ResolveMedia, ToolMediaProvider, type ToolMediaShown } from './tool-media.tsx';

/** The theme, labels, Markdown plugins, and tool media a chat or a host page draws with. */
export function SurfaceProviders({
  theme,
  mode,
  labels,
  detectCodeLanguage,
  media,
  resolveMedia,
  children,
}: {
  theme: DefinedTheme | undefined;
  mode: 'system' | 'light' | 'dark' | undefined;
  labels: TheoremLabels | undefined;
  detectCodeLanguage: boolean | undefined;
  media: ToolMediaShown | undefined;
  resolveMedia: ResolveMedia | undefined;
  children: ReactNode;
}) {
  return (
    <TheoremThemeProvider theme={theme} mode={mode}>
      <TheoremLabelsProvider labels={labels}>
        <MarkdownPluginsProvider detectCodeLanguage={detectCodeLanguage}>
          <ToolMediaProvider media={media} resolveMedia={resolveMedia}>
            {children}
          </ToolMediaProvider>
        </MarkdownPluginsProvider>
      </TheoremLabelsProvider>
    </TheoremThemeProvider>
  );
}
