import { TheoremEmbedding } from '@theoremjs/react/ui';
import { createBrowserStudioEmbeddingTransport } from '../browser.ts';
import {
  createStudioEmbeddingTransport,
  EXAMPLE_EMBEDDING_QUERY,
  EXAMPLE_EMBEDDING_TEXT,
  type StudioRunPayload,
} from '../mod.ts';
import { type StudioConsoleProps, useStudioTransport } from './studio-decision.tsx';

/** The documents and query an embedding starts with: example text, unless the profile embeds files only. */
export function embeddingSeed(profile: StudioRunPayload['profile']) {
  return profile.type === 'embedding' && profile.inputs.text === false
    ? { defaultText: '', defaultQuery: '' }
    : { defaultText: EXAMPLE_EMBEDDING_TEXT, defaultQuery: EXAMPLE_EMBEDDING_QUERY };
}

/** The same embedding runner in the builder preview and the standalone run tab. */
export function StudioEmbedding(props: StudioConsoleProps) {
  const transport = useStudioTransport(
    props,
    createStudioEmbeddingTransport,
    createBrowserStudioEmbeddingTransport,
  );
  return (
    <TheoremEmbedding
      transport={transport}
      {...embeddingSeed(props.payload.profile)}
      trace={props.trace}
      flush={props.flush}
      columns={props.columns}
      className={props.className}
    />
  );
}
