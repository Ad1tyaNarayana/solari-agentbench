import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunRecord } from "@/core/domain/run";
import { EvidencePanel } from "@/components/evidence-panel";
import { LiveRun } from "@/components/live-run";
import { StageTimeline } from "@/components/stage-timeline";
import RunDetailPage from "@/app/runs/[id]/page";

const getRun = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), notFound: () => { throw new Error("not found"); } }));

vi.mock("@/server/container", () => ({
  getServerContainer: () => ({ getRun, listEvents: () => [] }),
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

test("does not claim an expired replay or retained screenshots when no evidence was captured", () => {
  render(<EvidencePanel run={{ ...researchRun, taskId: "url-shortener", stage: "failed", evidence: {}, sanitizedLogs: [] }} />);
  expect(screen.getByText(/No evidence was captured/i)).toBeInTheDocument();
  expect(screen.queryByText(/expired|screenshots remain/i)).not.toBeInTheDocument();
});

test("distinguishes pending evidence from missing terminal evidence", () => {
  render(<EvidencePanel run={{ ...researchRun, taskId: "url-shortener", stage: "generating", evidence: {}, sanitizedLogs: [] }} />);
  expect(screen.getByText(/Evidence has not been captured yet/i)).toBeInTheDocument();
});

test("recognizes a durable replay in the manifest even without a legacy signed URL", () => {
  render(<EvidencePanel run={{ ...researchRun, taskId: "url-shortener", evidence: {}, evidenceManifest: { schemaVersion: 1, runId: researchRun.id, taskId: "url-shortener", entries: [{ runId: researchRun.id, taskId: "url-shortener", digest: "a".repeat(64), size: 100, role: "browser-replay", mimeType: "application/json", producer: "evaluator", createdAt: "now", redacted: true }] } }} />);
  expect(screen.queryByText(/No browser replay is attached/i)).not.toBeInTheDocument();
  expect(screen.getByText(/Recording saved locally/i)).toBeInTheDocument();
});

test("labels a live reference check as infrastructure evidence rather than an agent benchmark", async () => {
  getRun.mockReturnValue({ ...researchRun, harnessId: "reference-infrastructure-check" });
  render(await RunDetailPage({ params: Promise.resolve({ id: "reference" }) }));
  expect(screen.getByText(/Not an agent benchmark score/i)).toBeInTheDocument();
});

test("shows quality separately from the time-adjusted result", async () => {
  getRun.mockReturnValue({ ...researchRun, primaryScore: 100, score: { total: 100, timeAdjusted: 50 } });
  render(await RunDetailPage({ params: Promise.resolve({ id: researchRun.id }) }));
  expect(screen.getByText("Quality score / 100")).toBeInTheDocument();
  expect(screen.getByText("Time-adjusted score")).toBeInTheDocument();
});

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

test("renders generic evaluator outcomes, assertions, and judge provenance", () => {
  render(<EvidencePanel run={{ ...researchRun, evaluationStatus: "valid-score", primaryScore: 70, evaluationReport: { status: "valid-score", score: 70, possiblePoints: 100, results: [{ evaluatorId: "judge", status: "failed", earnedPoints: 70, possiblePoints: 100, summary: "Mostly correct", assertions: [{ id: "accuracy", passed: false, summary: "One mismatch", expected: 1, observed: 0.7 }], evidence: [], outputs: {}, metadata: { provider: "openai-compatible", resolvedModel: "judge-v1", rubricDigest: "rubric123", promptDigest: "prompt123", retryCount: 0 } }] } }} />);
  expect(screen.getByRole("heading", { name: "judge" })).toBeInTheDocument();
  expect(screen.getByText(/70 \/ 100 points/i)).toBeInTheDocument();
  expect(screen.getByText(/expected: 1.*observed: 0.7/i)).toBeInTheDocument();
  expect(screen.getByText(/openai-compatible.*judge-v1/i)).toBeInTheDocument();
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

  expect(screen.getByText(/No browser replay is attached/i)).toBeInTheDocument();
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
  expect(refresh).toHaveBeenCalled();
  expect(items).toEqual([
    expect.stringContaining("planning"),
    expect.stringContaining("generating"),
    expect.stringContaining("completed"),
  ]);
  expect(source.close).toHaveBeenCalledOnce();
});

test("terminal runs show persisted event history", () => {
  render(<LiveRun runId="run-1" initialStage="completed" initialEvents={[{ id: 1, kind: "log", payload: { message: "Verifier finished independently" } }]} />);
  expect(screen.getByText("Verifier finished independently")).toBeInTheDocument();
});

test("renders generic manifest screenshots through the run-owned artifact route", () => {
  const digest = "b".repeat(64);
  render(<EvidencePanel run={{ ...researchRun, evidence: {}, evidenceManifest: { schemaVersion: 1, runId: researchRun.id, taskId: researchRun.taskId, entries: [{ digest, size: 2, mimeType: "image/png", role: "browser-result", producer: "evaluator", runId: researchRun.id, taskId: researchRun.taskId, createdAt: "now", redacted: true }] } }} />);
  expect(screen.getByRole("img", { name: "browser-result" })).toHaveAttribute("src", `/api/runs/research-1/evidence/${digest}`);
});

test("labels a terminal run as closed instead of waiting for events", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  render(<LiveRun runId="run-1" initialStage="completed" />);
  expect(screen.getByText(/live stream closed/i)).toBeInTheDocument();
  expect(FakeEventSource.instances).toHaveLength(0);
});

test("groups normalized provider events by operator-facing category", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  render(<LiveRun runId="run-1" initialStage="generating" />);
  const source = FakeEventSource.instances[0];
  act(() => {
    source.emit("provider_event", { kind: "tool-request", payload: { tool: "sandbox.exec" } }, "1");
    source.emit("provider_event", { kind: "resource-created", payload: { primitive: "sandbox" } }, "2");
    source.emit("provider_event", { kind: "usage", payload: { inputTokens: 10 } }, "3");
    source.emit("provider_event", { kind: "message", payload: { text: "Building the redirect handler now" } }, "4");
  });
  expect(screen.getByRole("heading", { name: "Local tools" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Solari resources" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
  expect(screen.getByText("Building the redirect handler now")).toBeInTheDocument();
});
