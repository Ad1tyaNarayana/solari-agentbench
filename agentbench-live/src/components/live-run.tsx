"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RunStage } from "@/core/domain/run";

type VisibleEvent = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
};

const terminalStages = new Set<RunStage>(["completed", "failed", "cancelled"]);
const categories = ["Messages", "Local tools", "Solari resources", "Artifacts", "Usage", "Warnings", "Errors"] as const;
type EventCategory = (typeof categories)[number];

function normalizedKind(event: VisibleEvent): string {
  return event.kind === "provider_event" && typeof event.payload.kind === "string" ? event.payload.kind : event.kind;
}

function categoryFor(event: VisibleEvent): EventCategory {
  const kind = normalizedKind(event);
  if (kind === "tool-request" || kind === "tool-result") return "Local tools";
  if (kind === "resource-created" || kind === "resource-observation" || kind === "cleanup") return "Solari resources";
  if (kind === "artifact") return "Artifacts";
  if (kind === "usage") return "Usage";
  if (kind === "warning") return "Warnings";
  if (kind === "error") return "Errors";
  return "Messages";
}

function eventSummary(event: VisibleEvent): string {
  const inner = event.kind === "provider_event" && event.payload.payload && typeof event.payload.payload === "object" ? event.payload.payload as Record<string, unknown> : event.payload;
  return String(inner.stage ?? inner.message ?? inner.text ?? inner.code ?? inner.tool ?? inner.primitive ?? normalizedKind(event));
}

export function LiveRun({
  runId,
  initialStage,
  initialEvents = [],
}: {
  runId: string;
  initialStage: RunStage;
  initialEvents?: VisibleEvent[];
}) {
  const { refresh } = useRouter();
  const [stage, setStage] = useState(initialStage);
  const [events, setEvents] = useState<VisibleEvent[]>(initialEvents);
  const [cancelling, setCancelling] = useState(false);
  const latestStageSequence = useRef(Math.max(0, ...initialEvents.map(event => event.id)));

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
      if (message.type === "stage" && typeof payload.stage === "string" && next.id > latestStageSequence.current) {
        latestStageSequence.current = next.id;
        const nextStage = payload.stage as RunStage;
        setStage(nextStage);
        refresh();
        if (terminalStages.has(nextStage)) source.close();
      }
    };
    for (const kind of ["stage", "log", "cleanup", "provider_event", "warning", "error", "artifact", "usage"]) {
      source.addEventListener(kind, receive);
    }
    return () => source.close();
  }, [initialStage, runId, refresh]);

  return (
    <section className="panel live-panel" aria-labelledby="live-heading">
      <div className="section-heading">
        <p className="eyebrow">Server-sent events</p>
        <h2 id="live-heading">Live run</h2>
      </div>
      <p className="live-stage"><span aria-hidden="true" /> Current stage: <strong>{stage}</strong></p>
      {!terminalStages.has(stage) ? <button className="cancel-run" disabled={cancelling} onClick={async () => { setCancelling(true); try { await fetch(`/api/runs/${runId}/cancel`, { method: "POST" }); } finally { setCancelling(false); } }}>{cancelling ? "Cancelling…" : "Cancel run"}</button> : null}
      {events.length > 0 ? (
        <div className="event-groups">{categories.map((category) => { const grouped = events.filter((event) => categoryFor(event) === category); return grouped.length ? <section key={category}><h3>{category}</h3><ol className="event-list">{grouped.map((event) => <li key={event.id}><code>{event.id}</code><span>{normalizedKind(event)}</span><strong>{eventSummary(event)}</strong></li>)}</ol></section> : null; })}</div>
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
