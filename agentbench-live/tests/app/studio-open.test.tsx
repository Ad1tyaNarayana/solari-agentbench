import { render, screen } from "@testing-library/react";
import StudioPage from "@/app/studio/page";
import { initialDraft } from "@/components/studio/use-benchmark-draft";

vi.mock("@/server/container", () => ({ getServerContainer: () => ({
  listBenchmarks: async () => [{ id: "saved-pack", name: "Saved benchmark", version: "1", writable: true }],
  readBenchmark: async () => ({ draft: { ...initialDraft, id: "saved-pack", name: "Saved benchmark" }, revision: { "benchmark.yaml": "revision" }, snapshotDigest: "abc" }),
}) }));

test("opens a saved pack instead of resetting to a new draft", async () => {
  render(await StudioPage({ searchParams: Promise.resolve({ pack: "saved-pack" }) }));
  expect(screen.getByLabelText("Name")).toHaveValue("Saved benchmark");
  expect(screen.getByRole("link", { name: "Saved benchmark" })).toHaveAttribute("href", "/studio?pack=saved-pack");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});
