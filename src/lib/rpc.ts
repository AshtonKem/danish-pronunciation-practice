interface Request {
  id: number;
  method: string;
  params: unknown;
}

type Reply =
  | { id: number; kind: 'ok'; result: unknown }
  | { id: number; kind: 'error'; message: string }
  | { id: number; kind: 'progress'; data: unknown };

export type ProgressHandler = (data: unknown) => void;

export interface CallOptions {
  transfer?: Transferable[];
  onProgress?: ProgressHandler;
}

/**
 * Minimal promise-per-message RPC. Inference runs in workers so a 300 MB model
 * load or a multi-second transcription never blocks the UI thread; this is just
 * enough plumbing to await a result and stream download progress back.
 */
export class WorkerClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: ProgressHandler }
  >();

  constructor(private readonly worker: Worker) {
    this.worker.addEventListener('message', (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      if (reply.kind === 'progress') {
        entry.onProgress?.(reply.data);
        return;
      }
      this.pending.delete(reply.id);
      if (reply.kind === 'ok') entry.resolve(reply.result);
      else entry.reject(new Error(reply.message));
    });

    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'Worker crashed');
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
    });
  }

  call<T>(method: string, params: unknown = {}, options: CallOptions = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress,
      });
      const request: Request = { id, method, params };
      this.worker.postMessage(request, options.transfer ?? []);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const [, entry] of this.pending) entry.reject(new Error('Worker terminated'));
    this.pending.clear();
  }
}

export interface ServeContext {
  progress: (data: unknown) => void;
}

export type Handlers = Record<
  string,
  (params: never, context: ServeContext) => Promise<{ result: unknown; transfer?: Transferable[] }>
>;

/** Worker-side counterpart to {@link WorkerClient}. */
export function serve(handlers: Handlers): void {
  self.addEventListener('message', async (event: MessageEvent<Request>) => {
    const { id, method, params } = event.data;
    const handler = handlers[method];
    if (!handler) {
      const reply: Reply = { id, kind: 'error', message: `Unknown method: ${method}` };
      self.postMessage(reply);
      return;
    }
    try {
      const { result, transfer } = await handler(params as never, {
        progress: (data) => self.postMessage({ id, kind: 'progress', data } satisfies Reply),
      });
      self.postMessage({ id, kind: 'ok', result } satisfies Reply, { transfer: transfer ?? [] });
    } catch (error) {
      self.postMessage({
        id,
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies Reply);
    }
  });
}
