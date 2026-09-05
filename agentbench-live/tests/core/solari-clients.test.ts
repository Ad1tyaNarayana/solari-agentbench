import { expect, test, vi } from "vitest";
import { chromium } from "patchright-core";
import { gzipSync } from "node:zlib";
import {
  BrowserServiceAdapter,
  createSolariServices,
  DesktopServiceAdapter,
  isLiveSolariServices,
  SandboxServiceAdapter,
} from "@/core/solari/clients";

test("records through the CDP default context and releases before disconnecting", async () => {
  const lifecycle: string[] = [];
  const page = { url: () => "https://example.com" };
  const raw = { contexts: () => [{ newPage: async () => page }], close: async () => { lifecycle.push("disconnect"); } };
  const connect = vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(raw as never);
  const client = { sessions: { create: async () => ({ id: "b", cdpEndpoint: "http://local.test" }), releaseAndWait: async () => { lifecycle.push("release"); } } };
  try {
    const handle = await new BrowserServiceAdapter(client as never).create({ recording: true });
    expect((await handle.newPage()).url()).toBe("https://example.com");
    await handle.close();
    expect(lifecycle[0]).toBe("release");
    expect(lifecycle).toContain("disconnect");
  } finally { connect.mockRestore(); }
});

test.each([false, true])("downloads and decodes Solari replay events (gzip=%s)", async (compressed) => {
  const bytes = Buffer.from('{"type":2,"timestamp":1000,"data":{}}\n');
  const client = { sessions: { getReplayUrl: async () => ({ url: "https://replay.test", expiresInSeconds: 60 }), downloadReplay: async () => compressed ? gzipSync(bytes) : bytes } };
  expect((await new BrowserServiceAdapter(client as never).getReplayUrl("b")).events).toEqual([{ type: 2, timestamp: 1000, data: {} }]);
});

test("rejects an empty replay instead of certifying an empty recording", async () => {
  const client = { sessions: { getReplayUrl: async () => ({ url: "https://replay.test", expiresInSeconds: 60 }), downloadReplay: async () => new Uint8Array() } };
  await expect(new BrowserServiceAdapter(client as never).getReplayUrl("b")).rejects.toThrow(/empty/);
});

test("brands only configured SDK service bundles as live Solari services", async () => {
  const unavailable = createSolariServices("");
  const configured = createSolariServices(
    "slr_test_example",
    "https://example.invalid",
  );

  expect(isLiveSolariServices(unavailable)).toBe(false);
  expect(isLiveSolariServices(configured)).toBe(true);
  expect(isLiveSolariServices({ browser: {}, sandbox: {}, desktop: {} } as never)).toBe(false);

  await configured.dispose?.();
});

test("shuts down the browser SDK local proxy when services are disposed", async () => {
  const client = { close: vi.fn(async () => undefined) };
  const service = new BrowserServiceAdapter(client as never);

  await service.dispose();

  expect(client.close).toHaveBeenCalledOnce();
});

test("connects newly created and reattached sandboxes before file operations", async () => {
  const created = { id: "sandbox-created", connect: vi.fn(async () => undefined) };
  const attached = { id: "sandbox-attached", connect: vi.fn(async () => undefined) };
  const client = {
    create: vi.fn(async () => created),
    connect: vi.fn(async () => attached),
  };
  const service = new SandboxServiceAdapter(client as never);

  await service.create();
  await service.connect("sandbox-attached");

  expect(created.connect).toHaveBeenCalledOnce();
  expect(attached.connect).toHaveBeenCalledOnce();
});

test("observes background sandbox completion before the control channel closes", async () => {
  const wait = vi.fn(async () => 0);
  const kill = vi.fn(async () => undefined);
  const sandbox = {
    id: "sandbox-created",
    connect: vi.fn(async () => undefined),
    commands: {
      start: vi.fn(async () => ({ wait, kill })),
    },
  };
  const service = new SandboxServiceAdapter({
    create: vi.fn(async () => sandbox),
  } as never);

  const handle = await service.create();
  const process = await handle.start("python3", ["-m", "http.server"]);

  expect(wait).toHaveBeenCalledOnce();
  await expect(process.wait()).resolves.toBe(0);
  await process.kill();
  expect(kill).toHaveBeenCalledOnce();
});

test("connects newly created desktops before GUI operations", async () => {
  const desktop = { id: "desktop-created", connect: vi.fn(async () => undefined) };
  const client = { create: vi.fn(async () => desktop) };
  const inventory = {};
  const service = new DesktopServiceAdapter(client as never, inventory as never);

  await service.create();

  expect(desktop.connect).toHaveBeenCalledOnce();
});

test("kills a newly created sandbox when its control channel cannot connect", async () => {
  const failure = new Error("sandbox connect failed");
  const sandbox = {
    id: "sandbox-created",
    connect: vi.fn(async () => { throw failure; }),
    kill: vi.fn(async () => undefined),
  };
  const client = { create: vi.fn(async () => sandbox) };
  const service = new SandboxServiceAdapter(client as never);

  await expect(service.create()).rejects.toBe(failure);

  expect(sandbox.kill).toHaveBeenCalledOnce();
});

test("kills a newly created desktop when its control channel cannot connect", async () => {
  const failure = new Error("desktop connect failed");
  const desktop = {
    id: "desktop-created",
    connect: vi.fn(async () => { throw failure; }),
    kill: vi.fn(async () => undefined),
  };
  const client = { create: vi.fn(async () => desktop) };
  const service = new DesktopServiceAdapter(client as never, {} as never);

  await expect(service.create()).rejects.toBe(failure);

  expect(desktop.kill).toHaveBeenCalledOnce();
});
