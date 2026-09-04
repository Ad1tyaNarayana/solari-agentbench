import { expect, test } from "vitest";
import type {
  BrowserHandle,
  BrowserPageHandle,
  DesktopHandle,
  SandboxHandle,
  SolariServices,
} from "@/core/solari/contracts";
import { runSolariSmoke, runSolariSmokePreflight } from "@/core/solari/smoke";
import { createSolariServices } from "@/core/solari/clients";

test("smoke preflight reports a missing Solari key without provisioning", async () => {
  const create = vi.fn();
  const report = await runSolariSmokePreflight("", { sandbox: { create } } as never);
  expect(report).toEqual({ ok: false, code: "missing_credential", credential: "SOLARI_API_KEY", provisioned: false });
  expect(create).not.toHaveBeenCalled();
});

test("an unconfigured Solari adapter is inert until a primitive is requested", async () => {
  const services = createSolariServices("");
  await expect(services.sandbox.listIds()).resolves.toEqual([]);
  await expect(services.sandbox.create()).rejects.toMatchObject({ code: "missing_credential" });
});

test("smoke verifies and cleans each primitive before creating the next", async () => {
  const calls: string[] = [];
  const page: BrowserPageHandle = {
    async goto() {
      calls.push("browser:navigate");
    },
    async fill() {},
    async click() {},
    async textContent() {
      return null;
    },
    async waitForUrl() {},
    url() {
      return "https://example.com";
    },
    async screenshot() {
      return new Uint8Array([1, 2]);
    },
  };
  const browser: BrowserHandle = {
    id: "browser-smoke",
    async newPage() {
      return page;
    },
    async close() {
      calls.push("browser:close");
    },
  };
  const sandbox: SandboxHandle = {
    id: "sandbox-smoke",
    async exec() {
      calls.push("sandbox:exec");
      return { exitCode: 0, stdout: "agentbench-sandbox-ok\n", stderr: "" };
    },
    async start() {
      throw new Error("not used");
    },
    async mkdir() {},
    async writeFile() {},
    async readFile() {
      return new Uint8Array();
    },
    async previewUrl() {
      return { url: "" };
    },
    async kill() {
      calls.push("sandbox:kill");
    },
  };
  const desktop: DesktopHandle = {
    id: "desktop-smoke",
    async health() {
      return { ready: true, display: true, vnc: true };
    },
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async open() {
      return 1;
    },
    async type() {},
    async screenshot() {
      calls.push("desktop:screenshot");
      return new Uint8Array([3, 4, 5]);
    },
    async kill() {
      calls.push("desktop:kill");
    },
  };
  const services = {
    sandbox: {
      async create() {
        calls.push("sandbox:create");
        return sandbox;
      },
      async connect() {
        return sandbox;
      },
      async listIds() {
        return [];
      },
      async kill() {},
    },
    browser: {
      async create() {
        calls.push("browser:create");
        return browser;
      },
      async listIds() {
        return [];
      },
      async release() {},
      async getReplayUrl() {
        return { url: "https://replay.test/run", expiresInSeconds: 60 };
      },
    },
    desktop: {
      async create() {
        calls.push("desktop:create");
        return desktop;
      },
      async listIds() {
        return [];
      },
      async kill() {},
    },
  } satisfies SolariServices;

  const report = await runSolariSmoke(services);

  expect(calls).toEqual([
    "sandbox:create",
    "sandbox:exec",
    "sandbox:kill",
    "browser:create",
    "browser:navigate",
    "browser:close",
    "desktop:create",
    "desktop:screenshot",
    "desktop:kill",
  ]);
  expect(report).toMatchObject({
    sandboxOutput: "agentbench-sandbox-ok",
    browserScreenshotBytes: 2,
    desktopScreenshotBytes: 3,
  });
});
