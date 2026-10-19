import { TheoremHost, type TheoremHostProps } from '@theoremjs/react/ui';
import { useMemo } from 'react';
import { createBrowserStudioHostTransport } from '../browser.ts';
import { createStudioHostTransport, studioPageTools } from '../mod.ts';
import {
  type ConsoleViewProps,
  type StudioConsoleProps,
  useStudioTransport,
} from './lib/studio-console.ts';
import { STUDIO_LABELS } from './lib/studio-labels.ts';

/** The same tool console in the builder preview and the standalone run tab. */
export function StudioHostConsole(props: StudioConsoleProps) {
  const transport = useStudioTransport(
    props,
    createStudioHostTransport,
    createBrowserStudioHostTransport,
  );
  return <HostView {...props} transport={transport} />;
}

/** A host's tool console on `transport`, its page tools answered with their stubs. */
export function HostView({
  payload,
  transport,
  trace,
  flush,
  columns,
  className,
}: ConsoleViewProps & Pick<TheoremHostProps, 'transport'>) {
  const pageTools = useMemo(() => studioPageTools(payload), [payload]);
  return (
    <TheoremHost
      detectCodeLanguage
      labels={STUDIO_LABELS}
      transport={transport}
      pageTools={pageTools}
      trace={trace}
      flush={flush}
      columns={columns}
      className={className}
    />
  );
}
