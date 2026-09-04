import { handleCancelRun } from "@/server/run-handlers";
test("requests cancellation through the run API", async () => { const cancelRun = vi.fn(() => ({ id: "r", stage: "cancelled" })); const response = await handleCancelRun("r", { cancelRun } as never); expect(response.status).toBe(202); expect((await response.json()).stage).toBe("cancelled"); expect(cancelRun).toHaveBeenCalledWith("r"); });
