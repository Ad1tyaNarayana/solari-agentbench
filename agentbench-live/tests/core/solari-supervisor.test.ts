import { expect, test } from "vitest";
import type { SubmissionPackage } from "@/core/security/package-submission";
import type { SandboxHandle } from "@/core/solari/contracts";
import {
  auditGeneratedResources,
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

test("resource cleanup is single-shot and returns the same issues to every caller", async () => {
  let kills = 0;
  const supervisor = new ResourceSupervisor();
  supervisor.trackSandbox({
    id: "sandbox-1",
    async kill() {
      kills += 1;
      throw new Error("kill failed");
    },
  });

  const first = await supervisor.cleanup();
  const second = await supervisor.cleanup();

  expect(kills).toBe(1);
  expect(second).toEqual(first);
});

test("audits unapproved primitive use and more than one created resource", () => {
  const audit = auditGeneratedResources({
    approvedPrimitives: ["sandbox"],
    before: {
      browsers: new Set(),
      sandboxes: new Set(),
      desktops: new Set(),
    },
    after: {
      browsers: new Set(),
      sandboxes: new Set(["sandbox-1", "sandbox-2"]),
      desktops: new Set(["desktop-1"]),
    },
    events: [
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "solari",
          tool: "solari_desktop_create",
          result: { sessionId: "desktop-1" },
        },
      },
    ],
  });

  expect(audit.violations).toEqual([
    "desktop primitive was not approved",
    "sandbox primitive created 2 resources (maximum 1)",
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
      "source/z.ts": { kind: "text", contents: "z" },
      "results.json": { kind: "text", contents: "{}" },
      "source/a.ts": { kind: "text", contents: "a" },
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
      {
        entries: {
          "results.json": { kind: "text", contents: "{}" },
        },
        digest: "digest",
      },
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
      {
        type: "item.completed",
        item: {
          result: {
            content: [
              { type: "text", text: '{"sessionId":"browser-from-mcp-text"}' },
            ],
          },
        },
      },
    ]),
  ).toEqual({
    browsers: new Set(["browser-1", "browser-from-mcp-text"]),
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
