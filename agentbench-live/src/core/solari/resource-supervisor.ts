import type { JsonlEvent } from "@/core/agents/jsonl";
import { solariPrimitivesForTool } from "@/core/providers/codex-sdk";
import type { Primitive } from "@/core/domain/plan";
import type { CleanupIssue } from "@/core/domain/run";
import type {
  BrowserHandle,
  BrowserService,
  DesktopHandle,
  DesktopService,
  SandboxHandle,
  SandboxService,
} from "./contracts";

export type ResourceInventory = {
  browsers: Set<string>;
  sandboxes: Set<string>;
  desktops: Set<string>;
};

export class ResourceSupervisor {
  private readonly browsers = new Map<string, Pick<BrowserHandle, "id" | "close">>();
  private readonly desktops = new Map<string, Pick<DesktopHandle, "id" | "kill">>();
  private readonly sandboxes = new Map<string, Pick<SandboxHandle, "id" | "kill">>();
  private cleanupPromise: Promise<CleanupIssue[]> | undefined;

  private assertTrackingOpen(): void {
    if (this.cleanupPromise) {
      throw new Error("Cannot track resources after cleanup has started");
    }
  }

  trackBrowser(resource: Pick<BrowserHandle, "id" | "close">): void {
    this.assertTrackingOpen();
    this.browsers.set(resource.id, resource);
  }

  trackDesktop(resource: Pick<DesktopHandle, "id" | "kill">): void {
    this.assertTrackingOpen();
    this.desktops.set(resource.id, resource);
  }

  trackSandbox(resource: Pick<SandboxHandle, "id" | "kill">): void {
    this.assertTrackingOpen();
    this.sandboxes.set(resource.id, resource);
  }

  async cleanup(): Promise<CleanupIssue[]> {
    this.cleanupPromise ??= this.performCleanup();
    return this.cleanupPromise;
  }

  async closeBrowser(id: string): Promise<CleanupIssue | undefined> {
    this.assertTrackingOpen();
    const resource = this.browsers.get(id);
    if (!resource) return undefined;
    this.browsers.delete(id);
    try {
      await resource.close();
      return undefined;
    } catch (error) {
      return {
        code: "cleanup_failed",
        detail: `browser ${id}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async performCleanup(): Promise<CleanupIssue[]> {
    const issues: CleanupIssue[] = [];
    const clean = async (
      type: string,
      id: string,
      operation: () => Promise<void>,
    ) => {
      try {
        await operation();
      } catch (error) {
        issues.push({
          code: "cleanup_failed",
          detail: `${type} ${id}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };

    for (const resource of this.browsers.values()) {
      await clean("browser", resource.id, () => resource.close());
    }
    for (const resource of this.desktops.values()) {
      await clean("desktop", resource.id, () => resource.kill());
    }
    for (const resource of this.sandboxes.values()) {
      await clean("sandbox", resource.id, () => resource.kill());
    }
    this.browsers.clear();
    this.desktops.clear();
    this.sandboxes.clear();
    return issues;
  }
}

export async function captureInventory(
  services: {
    browser: Pick<BrowserService, "listIds">;
    sandbox: Pick<SandboxService, "listIds">;
    desktop: Pick<DesktopService, "listIds">;
  },
): Promise<ResourceInventory> {
  const [browsers, sandboxes, desktops] = await Promise.all([
    services.browser.listIds(),
    services.sandbox.listIds(),
    services.desktop.listIds(),
  ]);
  return {
    browsers: new Set(browsers),
    sandboxes: new Set(sandboxes),
    desktops: new Set(desktops),
  };
}

function collectObjects(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) {
    if (typeof child === "string") {
      const candidate = child.trim();
      if (candidate.startsWith("{") || candidate.startsWith("[")) {
        try {
          collectObjects(JSON.parse(candidate), visit);
        } catch {
          // MCP text results are commonly JSON, but ordinary text remains opaque.
        }
      }
    } else {
      collectObjects(child, visit);
    }
  }
}

export function discoverMcpResourceIds(events: JsonlEvent[]): ResourceInventory {
  const inventory: ResourceInventory = {
    browsers: new Set(),
    sandboxes: new Set(),
    desktops: new Set(),
  };
  for (const event of events) {
    const eventText = JSON.stringify(event).toLowerCase();
    collectObjects(event, (record) => {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string") continue;
        const normalized = key.toLowerCase();
        if (normalized === "sandboxid" || normalized === "sandbox_id") {
          inventory.sandboxes.add(value);
        } else if (normalized === "desktopid" || normalized === "desktop_id") {
          inventory.desktops.add(value);
        } else if (
          normalized === "sessionid" ||
          normalized === "session_id"
        ) {
          if (eventText.includes("desktop")) inventory.desktops.add(value);
          else if (eventText.includes("sandbox")) inventory.sandboxes.add(value);
          else inventory.browsers.add(value);
        }
      }
    });
  }
  return inventory;
}

function newIds(before: Set<string>, after: Set<string>, reported: Set<string>) {
  return new Set(
    [...after, ...reported].filter((id) => !before.has(id)),
  );
}

function collectSolariToolNames(events: JsonlEvent[]): string[] {
  const names: string[] = [];
  for (const event of events) {
    collectObjects(event, (record) => {
      if (
        record.type === "mcp_tool_call" &&
        record.server === "solari" &&
        typeof record.tool === "string"
      ) {
        names.push(
          record.tool.startsWith("solari_")
            ? record.tool
            : `solari_${record.tool}`,
        );
      }
    });
  }
  return names;
}

export type GenerationResourceAudit = {
  created: ResourceInventory;
  violations: string[];
};

export function auditGeneratedResources(input: {
  approvedPrimitives: Primitive[];
  before: ResourceInventory;
  after: ResourceInventory;
  events: JsonlEvent[];
}): GenerationResourceAudit {
  const reported = discoverMcpResourceIds(input.events);
  const created: ResourceInventory = {
    browsers: newIds(input.before.browsers, input.after.browsers, reported.browsers),
    sandboxes: newIds(
      input.before.sandboxes,
      input.after.sandboxes,
      reported.sandboxes,
    ),
    desktops: newIds(input.before.desktops, input.after.desktops, reported.desktops),
  };
  const approved = new Set(input.approvedPrimitives);
  const violations: string[] = [];
  const add = (message: string) => {
    if (!violations.includes(message)) violations.push(message);
  };

  for (const tool of collectSolariToolNames(input.events)) {
    const primitives = solariPrimitivesForTool(tool);
    if (primitives.length === 0) {
      add(`unrecognized Solari MCP tool ${tool}`);
    } else if (!primitives.some((primitive) => approved.has(primitive))) {
      add(`${primitives[0]} primitive was not approved`);
    }
  }

  const inventories: Array<[Primitive, Set<string>]> = [
    ["browser", created.browsers],
    ["sandbox", created.sandboxes],
    ["desktop", created.desktops],
  ];
  for (const [primitive, ids] of inventories) {
    if (ids.size > 0 && !approved.has(primitive)) {
      add(`${primitive} primitive was not approved`);
    }
  }
  for (const [primitive, ids] of inventories) {
    if (approved.has(primitive) && ids.size > 1) {
      add(`${primitive} primitive created ${ids.size} resources (maximum 1)`);
    }
  }

  return { created, violations };
}

export function trackGeneratedResources(input: {
  before: ResourceInventory;
  after: ResourceInventory;
  events: JsonlEvent[];
  services: {
    browser: Pick<BrowserService, "release">;
    sandbox: Pick<SandboxService, "kill">;
    desktop: Pick<DesktopService, "kill">;
  };
  supervisor: ResourceSupervisor;
}): void {
  const reported = discoverMcpResourceIds(input.events);
  for (const id of newIds(
    input.before.browsers,
    input.after.browsers,
    reported.browsers,
  )) {
    input.supervisor.trackBrowser({
      id,
      close: () => input.services.browser.release(id),
    });
  }
  for (const id of newIds(
    input.before.desktops,
    input.after.desktops,
    reported.desktops,
  )) {
    input.supervisor.trackDesktop({
      id,
      kill: () => input.services.desktop.kill(id),
    });
  }
  for (const id of newIds(
    input.before.sandboxes,
    input.after.sandboxes,
    reported.sandboxes,
  )) {
    input.supervisor.trackSandbox({
      id,
      kill: () => input.services.sandbox.kill(id),
    });
  }
}
