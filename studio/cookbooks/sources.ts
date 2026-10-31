/**
 * Portable `sources` hooks for cookbook tools. Functions cannot cross JSON in
 * `StudioRunPayload`, so `registerCustomTool` attaches the matching hook by
 * tool name when the draft runs.
 *
 * @module
 */

import type { Source } from '@theoremjs/agents/kernel';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** An http(s) citation. Other schemes never become a footer link. */
function web(title: string, uri: string): Source | undefined {
  if (!URL.canParse(uri)) return undefined;
  const url = new URL(uri);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const name = title.trim() || url.hostname.replace(/^www\./, '');
  return { title: name, uri: url.href, type: 'web' };
}

function unique(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.uri)) return false;
    seen.add(source.uri);
    return true;
  });
}

/** http(s) addresses in free text, including Markdown links. */
function urlsIn(text: string): Source[] {
  const markdown = [...text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)];
  const fromLinks = markdown.flatMap((match) => web(match[1] ?? '', match[2] ?? '') ?? []);
  const bare = [...text.matchAll(/https?:\/\/[^\s"'<>\]]+/g)];
  const fromBare = bare.flatMap((match) => {
    const uri = (match[0] ?? '').replace(/[),.;:]+$/, '');
    return web(uri, uri) ?? [];
  });
  return unique([...fromLinks, ...fromBare]);
}

function asRows(output: unknown): unknown[] {
  if (Array.isArray(output)) return output;
  if (!isRecord(output)) return [];
  for (const key of ['items', 'results', 'search_results', 'models', 'datasets']) {
    const value = output[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function fromRows(
  rows: readonly unknown[],
  sourceOf: (row: Record<string, unknown>) => Source | undefined,
): Source[] {
  return unique(rows.flatMap((row) => (isRecord(row) ? (sourceOf(row) ?? []) : [])));
}

function hfHub(output: unknown, kind: 'model' | 'dataset'): Source[] {
  const prefix =
    kind === 'dataset' ? 'https://huggingface.co/datasets/' : 'https://huggingface.co/';
  return fromRows(asRows(output), (row) => {
    const id = stringField(row, 'id') ?? stringField(row, 'modelId');
    return id ? web(id, `${prefix}${id}`) : undefined;
  });
}

function githubSearch(output: unknown): Source[] {
  return fromRows(asRows(output), (row) => {
    const uri = stringField(row, 'html_url');
    const title = stringField(row, 'full_name') ?? stringField(row, 'name');
    return uri ? web(title ?? uri, uri) : undefined;
  });
}

function stripXml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function arxivFeed(output: unknown): Source[] {
  if (typeof output !== 'string') return urlsIn(JSON.stringify(output));
  const entries = [...output.matchAll(/<entry\b[\s\S]*?<\/entry>/g)];
  if (entries.length === 0) return urlsIn(output);
  return unique(
    entries.flatMap((entry) => {
      const id = /<id>(https?:\/\/[^<]+)<\/id>/.exec(entry[0] ?? '')?.[1];
      const title = /<title>([\s\S]*?)<\/title>/.exec(entry[0] ?? '')?.[1];
      return id ? (web(stripXml(title ?? id), id) ?? []) : [];
    }),
  );
}

function fromUnknown(output: unknown): Source[] {
  if (typeof output === 'string') return urlsIn(output);
  if (Array.isArray(output) || isRecord(output)) {
    const rows = fromRows(asRows(output), (row) => {
      const uri =
        stringField(row, 'html_url') ??
        stringField(row, 'url') ??
        stringField(row, 'source_url') ??
        stringField(row, 'contentUrl');
      const title = stringField(row, 'title') ?? stringField(row, 'name') ?? uri;
      return uri ? web(title ?? uri, uri) : undefined;
    });
    return rows.length > 0 ? rows : urlsIn(JSON.stringify(output));
  }
  return [];
}

const COOKBOOK_TOOL_SOURCES: Readonly<Record<string, (output: unknown) => Source[]>> = {
  search_models: (output) => hfHub(output, 'model'),
  search_datasets: (output) => hfHub(output, 'dataset'),
  search_github: githubSearch,
  list_arxiv: arxivFeed,
  search_web: fromUnknown,
  read_pages: fromUnknown,
  read_model_card: fromUnknown,
  read_dataset_card: fromUnknown,
  read_readme: fromUnknown,
  find_library: fromUnknown,
  read_library_docs: fromUnknown,
  ask_repo_docs: fromUnknown,
};

/** The cookbook `sources` hook for `name`, when that tool cites what it returns. */
export function cookbookToolSources(name: string): ((output: unknown) => Source[]) | undefined {
  return COOKBOOK_TOOL_SOURCES[name];
}
