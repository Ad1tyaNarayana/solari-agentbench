import type { RunEventInput } from "@/core/events/run-events";
import { redact } from "@/core/security/redact";
import type { RunApiPort } from "@/server/contracts";

async function api(): Promise<RunApiPort> {
  return (await import("@/server/container")).getServerContainer();
}

function encodeEvent(encoder: TextEncoder, event: RunEventInput): Uint8Array {
  return encoder.encode(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${redact(JSON.stringify(event.payload))}\n\n`);
}

export async function handleRunEvents(id: string, port?: RunApiPort, signal?: AbortSignal, lastEventId = 0): Promise<Response> {
  const service = port ?? await api();
  if (!service.getRun(id)) return Response.json({ error: "run_not_found" }, { status: 404 });
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let onAbort: () => void = () => undefined;
  let lastSent = Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        try { controller.close(); } catch {}
      };
      onAbort = close;
      let snapshotting = true;
      const buffered: RunEventInput[] = [];
      const send = (event: RunEventInput) => {
        if (closed || event.sequence <= lastSent) return;
        lastSent = event.sequence;
        controller.enqueue(encodeEvent(encoder, event));
      };
      unsubscribe = service.subscribe(id, (event) => snapshotting ? buffered.push(event) : send(event));
      for (const event of service.listEvents(id).sort((left, right) => left.sequence - right.sequence)) send(event);
      snapshotting = false;
      for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) send(event);
      heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); }, 15_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) close();
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      closed = true;
    },
  });
  return new Response(stream, { headers: {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  } });
}
