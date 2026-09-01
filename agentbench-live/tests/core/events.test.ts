import { expect, test } from "vitest";
import { RunEventBus } from "@/core/events/run-events";

test("subscribers receive events in publish order", () => {
  const bus = new RunEventBus();
  const seen: number[] = [];
  const unsubscribe = bus.subscribe("run-1", (event) =>
    seen.push(event.sequence),
  );
  bus.publish("run-1", { sequence: 1, kind: "stage", payload: {} });
  bus.publish("run-1", { sequence: 2, kind: "log", payload: {} });
  unsubscribe();
  bus.publish("run-1", { sequence: 3, kind: "log", payload: {} });
  expect(seen).toEqual([1, 2]);
});
