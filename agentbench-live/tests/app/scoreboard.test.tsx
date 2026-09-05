import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RunRecord } from "@/core/domain/run";
import { agents, listTasks } from "@/core/tasks/registry";
import { RunCard } from "@/components/run-card";
import { RunLauncher } from "@/components/run-launcher";
import { Scoreboard } from "@/components/scoreboard";
import Home from "@/app/page";

const listRuns = vi.hoisted(() => vi.fn());

vi.mock("@/server/container", () => ({
  getServerContainer: () => ({ listRuns }),
}));

const completedRun: RunRecord = {
  id: "completed",
  taskId: "url-shortener",
  taskVersion: "1.0.0",
  agentId: "sol-low",
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
  stage: "completed",
  score: { total: 94 },
  sanitizedLogs: [],
  createdAt: "2026-09-01T00:00:00.000Z",
};

test("renders agents as rows and tasks as columns", () => {
  render(
    <Scoreboard agents={[...agents]} tasks={listTasks()} runs={[completedRun]} />,
  );

  expect(screen.getByRole("row", { name: /Sol · Low/ })).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: /URL Shortener/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: /Same Stats, Different Graph/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /94.*passed/i })).toHaveAttribute(
    "href",
    "/runs/completed",
  );
});

test("shows persisted custom tasks and agent identity in recorded experiments", async () => {
  listRuns.mockReturnValue([
    {
      ...completedRun,
      id: "custom-score",
      taskId: "custom-task",
      agentId: "custom-agent",
      model: "custom-model-v3",
      providerId: "openai-compatible",
      harnessId: "agentbench-basic-loop",
      harnessVersion: "1",
    } satisfies RunRecord,
  ]);

  render(await Home());

  expect(
    screen.getByText("custom-task"),
  ).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /custom-agent/i })).toHaveTextContent(
    /custom-agent/i,
  );
  expect(
    screen.getByRole("link", { name: /Inspect run/i }),
  ).toHaveAttribute("href", "/runs/custom-score");
});

test("failed runs expose the failure and last successful stage", () => {
  const failedRun: RunRecord = {
    ...completedRun,
    id: "failed",
    stage: "failed",
    lastSuccessfulStage: "provisioning",
    failureCode: "build_failed",
    score: undefined,
  };
  render(<RunCard run={failedRun} />);

  const card = screen.getByTestId("run-card-failed");
  expect(within(card).getByText(/failed during building/i)).toBeInTheDocument();
  expect(
    within(card).getByText(/last completed: provisioning/i),
  ).toBeInTheDocument();
});

test("synthetic demo cards are unmistakably labeled as non-live proof", () => {
  render(
    <RunCard
      run={{
        ...completedRun,
        id: "synthetic",
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
});

afterEach(() => {
  listRuns.mockReset();
  vi.unstubAllGlobals();
});

test("starts a selected benchmark run through the API", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(completedRun), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<RunLauncher agents={[...agents]} tasks={listTasks()} />);

  fireEvent.change(screen.getByLabelText("Task"), {
    target: { value: "same-stats-different-graph" },
  });
  fireEvent.change(screen.getByLabelText("Agent"), {
    target: { value: "luna-high" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start benchmark" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/runs",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        taskId: "same-stats-different-graph",
        agentId: "luna-high",
      }),
    }),
  );
  expect(await screen.findByRole("link", { name: /view queued run/i })).toHaveAttribute(
    "href",
    "/runs/completed",
  );
  expect(screen.getByRole("button", { name: "Run queued" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Configure another run" }));
  expect(screen.getByRole("button", { name: "Start benchmark" })).toBeEnabled();
  expect(screen.getByLabelText("Agent")).toHaveValue("luna-high");
});
