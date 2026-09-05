import { act, render, screen } from "@testing-library/react";
import { RunUpdates } from "@/components/run-updates";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); refresh.mockReset(); });

test("refreshes changed run data without reloading and stops polling after unmount", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "run1", stage: "failed" }]))));
  const view = render(<RunUpdates initialSignature="[]" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(refresh).toHaveBeenCalledOnce();
  view.unmount();
  const calls = vi.mocked(fetch).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(fetch).toHaveBeenCalledTimes(calls);
});

test("retries failed updates and checks immediately when the window regains focus", async () => {
  vi.useFakeTimers();
  let connected = false;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (!connected) throw new Error("offline");
    return new Response(JSON.stringify({ id: "run1", stage: "completed" }));
  }));
  render(<RunUpdates runId="run1" initialSignature='{"id":"run1","stage":"generating"}' />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(screen.getByRole("status")).toHaveTextContent(/disconnected/i);
  connected = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(refresh).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenLastCalledWith("/api/runs/run1", expect.objectContaining({ cache: "no-store" }));
});
