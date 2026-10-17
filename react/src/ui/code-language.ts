import type { MarkdownAstCode, MarkdownAstRoot } from '@astryxdesign/core/Markdown';
import type { MarkdownExtensionNode } from '@astryxdesign/core/Markdown/plugins';
import { createMarkdownPlugin } from '@astryxdesign/core/Markdown/plugins';
import { detectLanguage } from '@speed-highlight/core/detect';

/** The languages Astryx's `CodeBlock` colours, as the detector names them. A guess outside it would only add a label. */
const COLOURED = new Set(['js', 'ts', 'py', 'bash', 'json', 'css', 'html', 'xml', 'yaml', 'md']);

/** The language of untagged code, or `undefined` when the detector is unsure or the language would not be coloured. */
export function detectedCodeLanguage(code: string): string | undefined {
  const language = detectLanguage(code);
  return COLOURED.has(language) ? language : undefined;
}

type Node = { readonly type: string; readonly children?: readonly Node[] };

function tagged(node: Node): Node {
  if (node.type === 'code') {
    const code = node as unknown as MarkdownAstCode;
    if (code.lang !== null) return node;
    const lang = detectedCodeLanguage(code.value);
    return lang === undefined ? node : ({ ...code, lang } as unknown as Node);
  }
  if (node.children === undefined) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = tagged(child);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** The document with its untagged fences labelled. Unsettled while streaming: the last block may be an open fence. */
export function labelUntaggedCode(
  document: MarkdownAstRoot<MarkdownExtensionNode>,
  isFinal: boolean,
): MarkdownAstRoot<MarkdownExtensionNode> {
  const { children } = document;
  const settled = isFinal ? children : children.slice(0, -1);
  const next = settled.map((child) => tagged(child as unknown as Node));
  if (next.every((child, index) => child === (settled[index] as unknown as Node))) return document;
  return {
    ...document,
    children: [...next, ...children.slice(settled.length)],
  } as unknown as MarkdownAstRoot<MarkdownExtensionNode>;
}

/**
 * A Markdown plugin that labels fenced code the reply left untagged, so it is coloured like a tagged
 * fence. A fence with a language is left as written. While the reply streams, the last block is left
 * alone: it may be a fence still open, and its language would change as it grows.
 */
export const codeLanguagePlugin = createMarkdownPlugin({
  apiVersion: 1,
  name: 'theorem-code-language',
  transform: (document, { isFinal }) => labelUntaggedCode(document, isFinal),
});
