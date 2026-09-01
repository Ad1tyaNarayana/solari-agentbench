import type { RunEventInput } from "@/core/events/run-events";
import { redact } from "@/core/security/redact";
import type { RunApiPort } from "@/server/contracts";

async function defaultApi(): Promise<RunApiPort> {
  return (await import("@/server/container")).getServerContainer();
}

function encodeEvent(encoder: TextEncoder, event: RunEventInput): Uint8Array {
  const data = redact(JSON.stringify(event.payload));
  return encoder.encode(
    `id: ${event.sequence}\nevent: ${event.kind}\ndata: ${data}\n\n`,
  );
}

export async function handleRunEvents(
  id: string,
  api?: RunApiPort,
  signal?: AbortSignal,
): Promise<Response> {
  const service = api ?? (await defaultApi());
  if (!service.getRun(id)) {
    return Response.json({ error: "run_not_found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let onAbort: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // The reader may already have cancelled the stream.
        }
      };
      onAbort = close;

      for (const event of service.listEvents(id)) {
        controller.enqueue(encodeEvent(encoder, event));
      }
      unsubscribe = service.subscribe(id, (event) => {
        if (!closed) controller.enqueue(encodeEvent(encoder, event));
      });
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
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

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleRunEvents(id, undefined, request.signal);
}
