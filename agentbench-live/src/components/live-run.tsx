"use client";

import { useEffect, useState } from "react";
import type { RunStage } from "@/core/domain/run";

type VisibleEvent = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
};

const terminalStages = new Set<RunStage>(["completed", "failed"]);

export function LiveRun({
  runId,
  initialStage,
}: {
  runId: string;
  initialStage: RunStage;
}) {
  const [stage, setStage] = useState(initialStage);
  const [events, setEvents] = useState<VisibleEvent[]>([]);

  useEffect(() => {
    if (terminalStages.has(initialStage)) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    const receive = (raw: Event) => {
      const message = raw as MessageEvent<string>;
      const payload = JSON.parse(message.data) as Record<string, unknown>;
      const id = Number(message.lastEventId);
      const next: VisibleEvent = {
        id: Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER,
        kind: message.type,
        payload,
      };
      setEvents((current) =>
        [...current.filter((event) => event.id !== next.id), next].sort(
          (left, right) => left.id - right.id,
        ),
      );
      if (message.type === "stage" && typeof payload.stage === "string") {
        const nextStage = payload.stage as RunStage;
        setStage(nextStage);
        if (terminalStages.has(nextStage)) source.close();
      }
    };
    for (const kind of ["stage", "log", "cleanup"]) {
      source.addEventListener(kind, receive);
    }
    return () => source.close();
  }, [initialStage, runId]);

  return (
    <section className="panel live-panel" aria-labelledby="live-heading">
      <div className="section-heading">
        <p className="eyebrow">Server-sent events</p>
        <h2 id="live-heading">Live run</h2>
      </div>
      <p className="live-stage"><span aria-hidden="true" /> Current stage: <strong>{stage}</strong></p>
      {events.length > 0 ? (
        <ol className="event-list">
          {events.map((event) => (
            <li key={event.id}><code>{event.id}</code><span>{event.kind}</span><strong>{String(event.payload.stage ?? event.payload.message ?? event.payload.code ?? "event")}</strong></li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">
          {terminalStages.has(stage)
            ? "Run is terminal; live stream closed."
            : "Waiting for the next persisted event…"}
        </p>
      )}
    </section>
  );
}
