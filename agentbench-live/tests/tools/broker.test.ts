import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentEventSink } from "@/core/providers/events";
import type { SolariServices } from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { createAgentToolBroker } from "@/core/tools/broker";
import {
  AgentToolError,
  type IsolatedWorkspaceCommandRunner,
} from "@/core/tools/types";

const fixtureRoots: string[] = [];
const plan: RunPlan = {
  primitives: ["sandbox"],
  reason: { sandbox: "run isolated commands" },
  verificationStrategy: "inspect command output",
};

function inertServices(): SolariServices {
  const unavailable = async () => {
    throw new Error("Solari should not be called by workspace tests");
  };
  return {
    sandbox: {
      create: unavailable,
      connect: unavailable,
      listIds: async () => [],
      kill: unavailable,
    },
    browser: {
      create: unavailable,
      listIds: async () => [],
      release: unavailable,
      getReplayUrl: unavailable,
    },
    desktop: {
      create: unavailable,
      listIds: async () => [],
      kill: unavailable,
    },
  } as SolariServices;
}

const sink: AgentEventSink = {
  emit: async () => undefined,
  close: () => undefined,
};

async function fixtureBroker(options: {
  remainingMs?: () => number;
  environment?: Record<string, string | undefined>;
  commandRunner?: IsolatedWorkspaceCommandRunner;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentbench-tools-"));
  fixtureRoots.push(root);
  const broker = createAgentToolBroker({
    workspace: { root, dispose: async () => undefined },
    plan,
    services: inertServices(),
    supervisor: new ResourceSupervisor(),
    sink,
    remainingMs: options.remainingMs ?? (() => 120_000),
    environment: options.environment ?? {},
    workspaceCommandRunner: options.commandRunner,
  });
  return { root, broker };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("AgentToolBroker definitions", () => {
  it("exposes the exact bounded tool surface with closed object schemas", async () => {
    const { broker } = await fixtureBroker();
    const definitions = broker.listDefinitions();

    expect(definitions.map(({ name }) => name)).toEqual([
      "workspace_list",
      "workspace_read",
      "workspace_write",
      "workspace_apply_patch",
      "workspace_exec",
      "sandbox_create",
      "sandbox_exec",
      "sandbox_preview",
      "browser_create",
      "browser_goto",
      "browser_fill",
      "browser_click",
      "browser_text",
      "browser_screenshot",
      "desktop_create",
      "desktop_exec",
      "desktop_open",
      "desktop_type",
      "desktop_screenshot",
    ]);
    for (const definition of definitions) {
      expect(definition.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      assertStringsAndArraysAreBounded(definition.inputSchema);
    }
  });

  it("returns defensive definition copies", async () => {
    const { broker } = await fixtureBroker();
    const first = broker.listDefinitions();
    first[0].name = "corrupted";
    (first[1].inputSchema as { additionalProperties?: boolean }).additionalProperties = true;

    const second = broker.listDefinitions();
    expect(second[0].name).toBe("workspace_list");
    expect(second[1].inputSchema).toMatchObject({ additionalProperties: false });
  });
});

describe("workspace tools", () => {
  it("lists, writes, reads, and patches files below the workspace root", async () => {
    const { root, broker } = await fixtureBroker();

    await broker.invoke(
      "workspace_write",
      { path: "src/message.txt", content: "hello\n" },
      new AbortController().signal,
    );
    expect(
      await broker.invoke(
        "workspace_list",
        { path: "src" },
        new AbortController().signal,
      ),
    ).toEqual({
      entries: [{ path: "src/message.txt", type: "file", size: 6 }],
    });
    expect(
      await broker.invoke(
        "workspace_read",
        { path: "src/message.txt" },
        new AbortController().signal,
      ),
    ).toEqual({ content: "hello\n", bytes: 6 });

    await broker.invoke(
      "workspace_apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/message.txt",
          "@@",
          "-hello",
          "+hello agent",
          "*** End Patch",
        ].join("\n"),
      },
      new AbortController().signal,
    );

    expect(await readFile(join(root, "src/message.txt"), "utf8")).toBe(
      "hello agent\n",
    );
  });

  it("rejects traversal, absolute paths, reserved credential files, and escaping symlinks", async () => {
    const { root, broker } = await fixtureBroker();
    const outside = await mkdtemp(join(tmpdir(), "agentbench-tools-outside-"));
    fixtureRoots.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "escape"), "junction");

    for (const path of [
      "../outside.txt",
      join(outside, "secret.txt"),
      ".env.production",
      "nested/auth.json",
      ".agentbench/credentials.json",
      ".codex/auth.json",
      "escape/secret.txt",
    ]) {
      await expect(
        broker.invoke(
          "workspace_read",
          { path },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(AgentToolError);
    }
    await expect(
      broker.invoke(
        "workspace_write",
        { path: ".env/secrets.txt", content: "must not be written" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "path_forbidden" });
  });

  it("does not reveal reserved credential entries through directory listings", async () => {
    const { root, broker } = await fixtureBroker();
    await writeFile(join(root, ".env.local"), "PRIVATE_VALUE=secret");

    await expect(
      broker.invoke("workspace_list", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "path_forbidden" });
  });

  it("rejects directory listings above the explicit entry cap", async () => {
    const { root, broker } = await fixtureBroker();
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        writeFile(join(root, `entry-${String(index).padStart(4, "0")}.txt`), ""),
      ),
    );

    await expect(
      broker.invoke("workspace_list", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "output_limit" });
  });

  it("rejects directory listings above the explicit aggregate byte cap", async () => {
    const { root, broker } = await fixtureBroker();
    await Promise.all(
      Array.from({ length: 700 }, (_, index) =>
        writeFile(
          join(root, `${String(index).padStart(4, "0")}-${"x".repeat(100)}.txt`),
          "",
        ),
      ),
    );

    await expect(
      broker.invoke("workspace_list", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "output_limit" });
  });

  it("enforces byte caps independently of schema character limits", async () => {
    const { root, broker } = await fixtureBroker();
    await writeFile(join(root, "too-large.txt"), Buffer.alloc(1024 * 1024 + 1, 97));

    await expect(
      broker.invoke(
        "workspace_read",
        { path: "too-large.txt" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "output_limit" });
    await expect(
      broker.invoke(
        "workspace_write",
        { path: "wide.txt", content: "\u20ac".repeat(2 * 1024 * 1024) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "input_limit" });
  });

  it("fails closed instead of spawning a host process when no isolated runner is configured", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentbench-host-escape-"));
    fixtureRoots.push(outside);
    const sentinel = join(outside, "host-process-ran.txt");
    const { broker } = await fixtureBroker();

    await expect(
      broker.invoke(
        "workspace_exec",
        {
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`,
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "isolation_unavailable" });
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("delegates execution only to the injected isolated boundary with a filtered environment", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const commandRunner = {
      async run(input: Record<string, unknown>) {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: "isolated output",
          stderr: "",
          timedOut: false,
          outputTruncated: false,
        };
      },
    };
    const { root, broker } = await fixtureBroker({
      environment: {
        LANG: "test-language",
        SOLARI_API_KEY: "slr_live_must_not_reach_local_commands",
      },
      commandRunner,
    });
    const result = await broker.invoke(
      "workspace_exec",
      {
        command: "virtual-command",
        args: ["literal", "arguments"],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "isolated output",
      stderr: "",
      timedOut: false,
      outputTruncated: false,
    });
    expect(calls).toEqual([{
      workspaceRoot: root,
      workingDirectory: root,
      command: "virtual-command",
      args: ["literal", "arguments"],
      environment: { LANG: "test-language" },
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
      signal: expect.any(AbortSignal),
    }]);
  });

  it("passes the smaller remaining deadline and enforces output bounds across the isolation boundary", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const commandRunner = {
      async run(input: Record<string, unknown>) {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: "x".repeat(1024 * 1024),
          stderr: "leak-past-cap",
          timedOut: true,
          outputTruncated: false,
        };
      },
    };
    const { broker } = await fixtureBroker({
      remainingMs: () => 25,
      commandRunner,
    });
    const result = (await broker.invoke(
      "workspace_exec",
      {
        command: "virtual-command",
        args: [],
        timeoutMs: 120_000,
      },
      new AbortController().signal,
    )) as { stdout: string; stderr: string; timedOut: boolean; outputTruncated: boolean };

    expect(calls[0]).toMatchObject({ timeoutMs: 25, maxOutputBytes: 1024 * 1024 });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(
      1024 * 1024,
    );
    expect(result).toMatchObject({
      stderr: "",
      timedOut: true,
      outputTruncated: true,
    });
  });

  it("serializes concurrent tool requests around workspace mutation", async () => {
    let releaseCommand!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const commandFinished = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const { root, broker } = await fixtureBroker({
      commandRunner: {
        async run() {
          markStarted();
          await commandFinished;
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            outputTruncated: false,
          };
        },
      },
    });
    const signal = new AbortController().signal;

    const execution = broker.invoke(
      "workspace_exec",
      { command: "isolated-command", args: [] },
      signal,
    );
    await started;
    const write = broker.invoke(
      "workspace_write",
      { path: "serialized.txt", content: "after command" },
      signal,
    );
    const stateBeforeRelease = await Promise.race([
      write.then(() => "write-finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("write-blocked"), 75)),
    ]);

    expect(stateBeforeRelease).toBe("write-blocked");
    await expect(access(join(root, "serialized.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    releaseCommand();
    await execution;
    await write;
    expect(await readFile(join(root, "serialized.txt"), "utf8")).toBe("after command");
  });

  it("revalidates the command working directory after isolated execution", async () => {
    let root = "";
    const fixture = await fixtureBroker({
      commandRunner: {
        async run() {
          await rm(join(root, "work"), { recursive: true });
          await symlink(join(root, "replacement"), join(root, "work"), "junction");
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            outputTruncated: false,
          };
        },
      },
    });
    root = fixture.root;
    await mkdir(join(root, "work"));
    await mkdir(join(root, "replacement"));

    await expect(
      fixture.broker.invoke(
        "workspace_exec",
        { command: "isolated-command", args: [], cwd: "work" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "symlink_forbidden" });
  });

  it("rejects malformed arguments and unknown tools with typed errors", async () => {
    const { broker } = await fixtureBroker();
    await expect(
      broker.invoke("workspace_read", { path: "x", extra: true }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(
      broker.invoke("made_up_tool", {}, new AbortController().signal),
    ).rejects.toMatchObject({ code: "unknown_tool", toolName: "made_up_tool" });
  });
});

function assertStringsAndArraysAreBounded(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const value of schema) assertStringsAndArraysAreBounded(value);
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  if (record.type === "string") expect(record.maxLength).toEqual(expect.any(Number));
  if (record.type === "array") expect(record.maxItems).toEqual(expect.any(Number));
  for (const value of Object.values(record)) assertStringsAndArraysAreBounded(value);
}
