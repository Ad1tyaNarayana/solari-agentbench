import { describe, expect, it } from "vitest";
import { ProviderProtocolError } from "@/core/providers/errors";
import {
  createAgentEventSink,
  type AgentEvent,
  type AgentEventKind,
} from "@/core/providers/events";

describe("createAgentEventSink", () => {
  it("assigns increasing sequence numbers before publishing", async () => {
    const published: AgentEvent[] = [];
    const sink = createAgentEventSink({
      provider: "fake",
      redact: (value) => value,
      publish: (event) => published.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    });
    await sink.emit("message", { text: "one" });
    await sink.emit("usage", { inputTokens: 1 });
    expect(published.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("publishes the exact versioned envelope for every normalized event kind", async () => {
    const published: AgentEvent[] = [];
    const sink = createAgentEventSink({
      provider: "fake",
      redact: (value) => value,
      publish: (event) => published.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    });
    const kinds: AgentEventKind[] = [
      "message",
      "reasoning-summary",
      "tool-request",
      "tool-result",
      "resource-created",
      "resource-observation",
      "artifact",
      "usage",
      "warning",
      "error",
    ];

    for (const kind of kinds) await sink.emit(kind, { kind });

    expect(published).toEqual(
      kinds.map((kind, index) => ({
        schemaVersion: 1,
        sequence: index + 1,
        occurredAt: "2026-09-04T00:00:00.000Z",
        kind,
        provider: "fake",
        payload: { kind },
      })),
    );
  });

  it("deep-redacts every payload string leaf before publication", async () => {
    const published: AgentEvent[] = [];
    const payload = {
      message: "Bearer exact-secret",
      nested: {
        values: ["exact-secret", 7, true, null, { text: "prefix exact-secret suffix" }],
      },
    };
    const sink = createAgentEventSink({
      provider: "fake",
      redact: (value) => value.replaceAll("exact-secret", "[REDACTED]"),
      publish: (event) => published.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    });

    await sink.emit("message", payload);

    expect(published[0].payload).toEqual({
      message: "Bearer [REDACTED]",
      nested: {
        values: [
          "[REDACTED]",
          7,
          true,
          null,
          { text: "prefix [REDACTED] suffix" },
        ],
      },
    });
    expect(payload.nested.values[0]).toBe("exact-secret");
  });

  it("serializes concurrent asynchronous publications in sequence order", async () => {
    const published: number[] = [];
    let releaseFirst!: () => void;
    const firstPublish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sink = createAgentEventSink({
      provider: "fake",
      redact: (value) => value,
      publish: async (event) => {
        if (event.sequence === 1) await firstPublish;
        published.push(event.sequence);
      },
      now: () => "2026-09-04T00:00:00.000Z",
    });

    const first = sink.emit("message", { text: "one" });
    const second = sink.emit("message", { text: "two" });
    await Promise.resolve();
    expect(published).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(published).toEqual([1, 2]);
  });

  it("throws a typed protocol error when output arrives after closure", async () => {
    const published: AgentEvent[] = [];
    const sink = createAgentEventSink({
      provider: "fake",
      redact: (value) => value,
      publish: (event) => published.push(event),
      now: () => "2026-09-04T00:00:00.000Z",
    });
    await sink.emit("message", { text: "terminal response" });
    sink.close();

    await expect(
      sink.emit("warning", { text: "late subprocess output" }),
    ).rejects.toBeInstanceOf(ProviderProtocolError);
    expect(published).toHaveLength(1);
  });
});
