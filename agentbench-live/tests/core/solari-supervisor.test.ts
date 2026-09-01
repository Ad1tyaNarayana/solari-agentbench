import { expect, test } from "vitest";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { SandboxHandle } from "@/core/solari/contracts";
import {
  captureInventory,
  discoverMcpResourceIds,
  ResourceSupervisor,
  trackGeneratedResources,
} from "@/core/solari/resource-supervisor";
import { uploadTextTree } from "@/core/solari/upload-tree";

test("closes browsers before killing compute and records every cleanup error", async () => {
  const calls: string[] = [];
  const supervisor = new ResourceSupervisor();
  supervisor.trackBrowser({
    id: "browser-1",
    close: async () => {
      calls.push("browser");
      throw new Error("close");
    },
  });
  supervisor.trackDesktop({
    id: "desktop-1",
    kill: async () => {
      calls.push("desktop");
    },
  });
  supervisor.trackSandbox({
    id: "sandbox-1",
    kill: async () => {
      calls.push("sandbox");
    },
  });
  const issues = await supervisor.cleanup();
  expect(calls).toEqual(["browser", "desktop", "sandbox"]);
  expect(issues).toEqual([
    { code: "cleanup_failed", detail: "browser browser-1: close" },
  ]);
});

test("uploads sorted text entries below the fixed submission root", async () => {
  const calls: string[] = [];
  const sandbox = {
    async mkdir(path: string) {
      calls.push(`mkdir:${path}`);
    },
    async writeFile(path: string, contents: string | Uint8Array) {
      calls.push(`write:${path}:${String(contents)}`);
    },
  } satisfies Pick<SandboxHandle, "mkdir" | "writeFile">;
  const submission: SubmissionPackage = {
    entries: {
      "source/z.ts": "z",
      "results.json": "{}",
      "source/a.ts": "a",
    },
    digest: "digest",
  };
  await uploadTextTree(sandbox, submission, "/work/submission");
  expect(calls).toEqual([
    "mkdir:/work/submission",
    "mkdir:/work/submission/source",
    "write:/work/submission/results.json:{}",
    "write:/work/submission/source/a.ts:a",
    "write:/work/submission/source/z.ts:z",
  ]);
});

test("rejects upload destinations outside the fixed submission root", async () => {
  await expect(
    uploadTextTree(
      {} as SandboxHandle,
      { entries: { "results.json": "{}" }, digest: "digest" },
      "/tmp/submission",
    ),
  ).rejects.toThrow(/outside \/work\/submission/i);
});

test("tracks only resources created after the initial inventory", async () => {
  const released: string[] = [];
  const killed: string[] = [];
  const browser = inventoryService(["browser-old"], released);
  const sandbox = inventoryService(["sandbox-old"], killed);
  const desktop = inventoryService(["desktop-old"], killed);
  const before = await captureInventory({ browser, sandbox, desktop });
  browser.listIds = async () => ["browser-old", "browser-new"];
  sandbox.listIds = async () => ["sandbox-old", "sandbox-new"];
  desktop.listIds = async () => ["desktop-old", "desktop-new"];
  const after = await captureInventory({ browser, sandbox, desktop });
  const supervisor = new ResourceSupervisor();

  trackGeneratedResources({
    before,
    after,
    events: [],
    services: { browser, sandbox, desktop },
    supervisor,
  });
  await supervisor.cleanup();

  expect(released).toEqual(["browser-new"]);
  expect(killed).toEqual(["desktop-new", "sandbox-new"]);
});

test("extracts Solari resource IDs from structured MCP events", () => {
  expect(
    discoverMcpResourceIds([
      { type: "item.completed", item: { result: { session_id: "browser-1" } } },
      { type: "item.completed", item: { result: { sandboxId: "sandbox-1" } } },
      { type: "item.completed", item: { result: { desktop_id: "desktop-1" } } },
    ]),
  ).toEqual({
    browsers: new Set(["browser-1"]),
    sandboxes: new Set(["sandbox-1"]),
    desktops: new Set(["desktop-1"]),
  });
});

function inventoryService(initial: string[], cleanup: string[]) {
  return {
    listIds: async () => initial,
    release: async (id: string) => {
      cleanup.push(id);
    },
    kill: async (id: string) => {
      cleanup.push(id);
    },
  };
}
