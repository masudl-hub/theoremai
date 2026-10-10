import type { MarkdownPluginEntry } from '@astryxdesign/core/Markdown/plugins';
import { createContext, type ReactNode, use } from 'react';
import { codeLanguagePlugin } from './code-language.ts';

const PLUGINS: readonly MarkdownPluginEntry[] = [codeLanguagePlugin];

const MarkdownPluginsContext = createContext<readonly MarkdownPluginEntry[] | undefined>(undefined);

/** The Markdown plugins the host asked for, or none: one array, so every `Markdown` below shares it. */
export function useMarkdownPlugins(): readonly MarkdownPluginEntry[] | undefined {
  return use(MarkdownPluginsContext);
}

/** Labels untagged code fences in the Markdown beneath it, when `detectCodeLanguage` is on. */
export function MarkdownPluginsProvider({
  detectCodeLanguage,
  children,
}: {
  detectCodeLanguage?: boolean;
  children: ReactNode;
}) {
  return (
    <MarkdownPluginsContext value={detectCodeLanguage ? PLUGINS : undefined}>
      {children}
    </MarkdownPluginsContext>
  );
}
