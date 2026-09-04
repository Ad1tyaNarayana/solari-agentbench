import { handleRunEvents } from "@/server/run-event-handler";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const header = request.headers.get("last-event-id");
  const parsed = header === null ? 0 : Number(header);
  const lastEventId = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  return handleRunEvents(id, undefined, request.signal, lastEventId);
}
