import { TheoremEmbedding, type TheoremEmbeddingProps } from '@theoremjs/react/ui';
import { createBrowserStudioEmbeddingTransport } from '../browser.ts';
import {
  createStudioEmbeddingTransport,
  EXAMPLE_EMBEDDING_FILES,
  EXAMPLE_EMBEDDING_QUERY,
  EXAMPLE_EMBEDDING_TEXT,
  type StudioRunPayload,
} from '../mod.ts';
import {
  type ConsoleViewProps,
  type StudioConsoleProps,
  useStudioTransport,
} from './lib/studio-console.ts';

/** Whether a profile that accepts `accept` takes `mimeType`, by name or by its `type/*` family. */
function accepts(accept: readonly string[], mimeType: string): boolean {
  return accept.some(
    (rule) => rule === mimeType || (rule.endsWith('/*') && mimeType.startsWith(rule.slice(0, -1))),
  );
}

/** The documents and query an embedding starts with: the example, less what the profile does not take. */
function embeddingSeed(profile: StudioRunPayload['profile']) {
  if (profile.type !== 'embedding')
    return { defaultText: EXAMPLE_EMBEDDING_TEXT, defaultQuery: EXAMPLE_EMBEDDING_QUERY };
  const { text, attachments } = profile.inputs;
  const defaultDocuments = EXAMPLE_EMBEDDING_FILES.filter(({ input }) =>
    typeof input === 'string' ? text !== false : accepts(attachments?.accept ?? [], 'image/png'),
  );
  return {
    defaultText: text === false ? '' : EXAMPLE_EMBEDDING_TEXT,
    defaultQuery: text === false ? '' : EXAMPLE_EMBEDDING_QUERY,
    defaultDocuments,
  };
}

/** The same embedding runner in the builder preview and the standalone run tab. */
export function StudioEmbedding(props: StudioConsoleProps) {
  const transport = useStudioTransport(
    props,
    createStudioEmbeddingTransport,
    createBrowserStudioEmbeddingTransport,
  );
  return <EmbeddingView {...props} transport={transport} />;
}

/** An embedding on `transport`, seeded with the example its profile takes. */
export function EmbeddingView({
  payload,
  transport,
  trace,
  flush,
  columns,
  className,
}: ConsoleViewProps & Pick<TheoremEmbeddingProps, 'transport'>) {
  return (
    <TheoremEmbedding
      transport={transport}
      {...embeddingSeed(payload.profile)}
      trace={trace}
      flush={flush}
      columns={columns}
      className={className}
    />
  );
}
