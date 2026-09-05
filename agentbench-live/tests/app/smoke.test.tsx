import { render, screen } from "@testing-library/react";
import Home from "@/app/page";
const listRuns = vi.hoisted(() => vi.fn((): unknown[] => []));
vi.mock("@/server/container", () => ({ getServerContainer: () => ({ listRuns }) }));

test("shows research tasks without presenting demo scores as real results", async () => {
  render(await Home());
  expect(
    screen.getByRole("heading", { name: "AgentBench Live" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Same Stats, Different Graph/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Raft/i })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /100.*passed/i })).not.toBeInTheDocument();
});

test("shows the time penalty without replacing the quality score in the run table", async () => {
  listRuns.mockReturnValueOnce([{ id: "timed", taskId: "url-shortener", agentId: "sol-low", stage: "completed", primaryScore: 100, score: { total: 100, timeAdjusted: 50 } }]);
  render(await Home());
  expect(screen.getByText("50 time-adjusted")).toBeInTheDocument();
  expect(screen.getByText("100")).toBeInTheDocument();
});
