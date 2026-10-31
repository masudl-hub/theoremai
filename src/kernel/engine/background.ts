import { startTrace } from '../../observability/trace-span.ts';
import type { DetachedToolTrace } from '../tools/background.ts';

/** A detached call's record, written at its real end: a span in its turn's tree cannot outlive the turn. */
export function detachedTrace(args: {
  traceparent: string;
  write: (spans: ReturnType<ReturnType<typeof startTrace>['collect']>) => void | Promise<void>;
}): DetachedToolTrace {
  let tree: ReturnType<typeof startTrace> | undefined;
  return {
    open: (name, attributes) => {
      tree = startTrace(name, {
        ...(attributes ? { attributes } : {}),
        traceparent: args.traceparent,
      });
      return tree.root;
    },
    end: () => {
      if (tree) return args.write(tree.collect());
    },
  };
}
