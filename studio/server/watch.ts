/**
 * Watching a project's files for the studio's page: when the builder's editor writes one the
 * project's setup reads, the page is told which, once the writes settle.
 */
import { dirname } from 'node:path';

/** The changes under some folders, as `Deno.watchFs` gives them. */
export interface FolderWatch extends AsyncIterable<unknown> {
  close(): void;
}

export interface FileWatchOptions {
  /** The files to watch, by absolute path. Read again after every change, since an import can add one. */
  files(): string[];
  /** The files that hold something other than what the project loaded from, named for the builder. */
  changed(): Promise<string[]>;
  /** Called with those files, once per settled run of writes. */
  tell(files: string[]): void;
  /** Watches folders, not their subfolders. */
  watch(folders: string[]): FolderWatch;
  /** How long the files must be still before the page is told, in milliseconds. */
  settle?: number;
}

/**
 * Starts watching, and answers how to stop. An editor that saves by writing a new file over the
 * old one never touches the old one, so the folders are watched and the files are compared.
 */
export function watchFiles(options: FileWatchOptions): { stop(): void } {
  const settle = options.settle ?? 150;
  const folders = () => [...new Set(options.files().map((file) => dirname(file)))].sort();
  let stopped = false;
  let watching: FolderWatch | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settled = async (over: string) => {
    const files = await options.changed().catch(() => []);
    if (stopped) return;
    if (files.length) options.tell(files);
    // A file in a folder not yet watched: watch again from there.
    if (folders().join('\n') !== over) watching?.close();
  };
  const run = async () => {
    while (!stopped) {
      const over = folders();
      try {
        watching = options.watch(over);
        for await (const _ of watching) {
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => void settled(over.join('\n')), settle);
        }
      } catch {
        // A folder that went away is watched again when it is back.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };
  void run();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      watching?.close();
    },
  };
}

/**
 * Subscriptions to a stream of values, as server-sent events: each value a line of JSON. A new
 * subscription is sent `first()` before anything new.
 */
export function createEventFeed<T>(): {
  tell(value: T): void;
  subscribe(headers: Record<string, string>, first?: readonly T[]): Response;
} {
  const encoder = new TextEncoder();
  const pages = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const send = (page: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    try {
      page.enqueue(encoder.encode(text));
    } catch {
      pages.delete(page);
    }
  };
  const line = (value: T) => `data: ${JSON.stringify(value)}\n\n`;
  return {
    tell: (value) => {
      for (const page of pages) send(page, line(value));
    },
    subscribe: (headers, first = []) => {
      let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller;
          pages.add(controller);
          send(controller, ': watching\n\n');
          for (const value of first) send(controller, line(value));
          // A line now and then keeps a quiet connection open.
          beat = setInterval(() => send(controller, ': still watching\n\n'), 25_000);
        },
        cancel() {
          if (mine) pages.delete(mine);
          if (beat !== undefined) clearInterval(beat);
        },
      });
      return new Response(body, {
        headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    },
  };
}

/** The page's subscriptions to file changes, as server-sent events. */
export function createWatchFeed(): {
  tell(files: string[]): void;
  subscribe(headers: Record<string, string>): Response;
} {
  const feed = createEventFeed<{ files: string[] }>();
  return { tell: (files) => feed.tell({ files }), subscribe: (headers) => feed.subscribe(headers) };
}
