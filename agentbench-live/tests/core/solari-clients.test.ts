import { expect, test, vi } from "vitest";
import {
  BrowserServiceAdapter,
  DesktopServiceAdapter,
  SandboxServiceAdapter,
} from "@/core/solari/clients";

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
