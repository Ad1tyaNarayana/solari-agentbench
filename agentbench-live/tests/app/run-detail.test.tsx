import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunRecord } from "@/core/domain/run";
import { EvidencePanel } from "@/components/evidence-panel";
import { LiveRun } from "@/components/live-run";
import { StageTimeline } from "@/components/stage-timeline";
import RunDetailPage from "@/app/runs/[id]/page";

const getRun = vi.hoisted(() => vi.fn());

vi.mock("@/server/container", () => ({
  getServerContainer: () => ({ getRun }),
}));

const researchRun: RunRecord = {
  id: "research-1",
  taskId: "same-stats-different-graph",
  taskVersion: "1.0.0",
  agentId: "luna-high",
  model: "gpt-5.6-luna",
  reasoningEffort: "high",
  stage: "completed",
  runPlan: {
    primitives: ["sandbox"],
    reason: { sandbox: "Reproduce the experiment in a clean environment." },
    verificationStrategy: "Recompute metrics twice.",
  },
  score: { core: 45, reproducible: 20, methodology: 15, evidence: 15, budget: 5, total: 100 },
  evidence: {
    sandboxVerified: true,
    expectedStatistics: { meanX: 54.27, correlation: -0.07 },
    observedStatistics: { meanX: 54.28, correlation: -0.069 },
    comparisonPlot: "/demo/same-stats-comparison.png",
  },
  sanitizedLogs: ["Executed twice; hashes match."],
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: "2026-09-01T00:03:00.000Z",
};

test("renders persisted custom run identity without requiring tutorial registry entries", async () => {
  getRun.mockReturnValue({
    ...researchRun,
    id: "custom-run",
    taskId: "custom-task",
    taskVersion: "2.4.0",
    agentId: "custom-agent",
    model: "custom-model-v3",
    benchmarkId: "custom-benchmark",
    benchmarkVersion: "2.4.0",
    benchmarkDigest: "abc123",
    providerId: "openai-compatible",
    harnessId: "agentbench-basic-loop",
    harnessVersion: "1",
  } satisfies RunRecord);

  render(
    await RunDetailPage({
      params: Promise.resolve({ id: "custom-run" }),
    }),
  );

  expect(screen.getByText("custom-task · v2.4.0")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "custom-agent", level: 1 }),
  ).toBeInTheDocument();
  expect(screen.getByText(/custom-model-v3.*high reasoning/i)).toBeInTheDocument();
  expect(screen.getByText("openai-compatible")).toBeInTheDocument();
  expect(screen.getByText("agentbench-basic-loop · v1")).toBeInTheDocument();
  expect(screen.getByText("custom-benchmark · v2.4.0")).toBeInTheDocument();
});

test("renders primitive rationale and expected-versus-observed evidence", () => {
  render(
    <>
      <StageTimeline run={researchRun} />
      <EvidencePanel run={researchRun} />
    </>,
  );

  expect(screen.getByText("sandbox", { selector: "strong" })).toBeInTheDocument();
  expect(screen.getByText(/clean environment/i)).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Expected" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Observed" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /comparison plot/i })).toBeInTheDocument();
});

test("renders loading and preflight without removing historical lifecycle stages", () => {
  render(<StageTimeline run={{ ...researchRun, stage: "preflight" }} />);

  expect(
    screen.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([
    "queued",
    "loading",
    "preflight",
    "planning",
    "generating",
    "provisioning",
    "building",
    "verifying",
    "capturing",
    "completed",
  ]);
});

test("keeps canonical screenshots visible when a replay has expired", () => {
  const run: RunRecord = {
    ...researchRun,
    taskId: "url-shortener",
    evidence: {
      browserScreenshot: "/demo/url-shortener-browser.png",
      desktopScreenshot: "/demo/url-shortener-desktop.png",
    },
  };
  render(<EvidencePanel run={run} />);

  expect(screen.getByText(/replay is unavailable or has expired/i)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /browser evidence/i })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /desktop evidence/i })).toBeInTheDocument();
});

test("synthetic evidence is labeled as illustrative rather than verifier-owned", () => {
  render(
    <EvidencePanel
      run={{
        ...researchRun,
        provenance: {
          kind: "synthetic-demo",
          label: "Synthetic demo — not live verification",
        },
      }}
    />,
  );

  expect(
    screen.getByText(/synthetic demo.*not live verification/i),
  ).toBeInTheDocument();
  expect(screen.queryByText(/verifier-owned output/i)).not.toBeInTheDocument();
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: MessageEvent) => void);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown, lastEventId: string): void {
    const event = new MessageEvent(type, {
      data: JSON.stringify(data),
      lastEventId,
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

test("orders live events and closes the stream at a terminal stage", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  render(<LiveRun runId="run-1" initialStage="queued" />);
  const source = FakeEventSource.instances[0];

  act(() => {
    source.emit("stage", { stage: "generating" }, "2");
    source.emit("stage", { stage: "planning" }, "1");
    source.emit("stage", { stage: "completed" }, "3");
  });

  const items = screen.getAllByRole("listitem").map((item) => item.textContent);
  expect(items).toEqual([
    expect.stringContaining("planning"),
    expect.stringContaining("generating"),
    expect.stringContaining("completed"),
  ]);
  expect(source.close).toHaveBeenCalledOnce();
});

test("labels a terminal run as closed instead of waiting for events", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  render(<LiveRun runId="run-1" initialStage="completed" />);
  expect(screen.getByText(/live stream closed/i)).toBeInTheDocument();
  expect(FakeEventSource.instances).toHaveLength(0);
});
