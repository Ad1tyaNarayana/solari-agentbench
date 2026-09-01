export type RunEventInput = {
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
};

export type RunEvent = RunEventInput & {
  runId: string;
  createdAt: string;
};

export type RunEventListener = (event: RunEventInput) => void;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  publish(runId: string, event: RunEventInput): void {
    for (const listener of this.listeners.get(runId) ?? []) {
      listener(event);
    }
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    const runListeners = this.listeners.get(runId) ?? new Set();
    runListeners.add(listener);
    this.listeners.set(runId, runListeners);

    return () => {
      runListeners.delete(listener);
      if (runListeners.size === 0) this.listeners.delete(runId);
    };
  }
}
