import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan } from "@/core/domain/plan";
import type { AgentEventSink } from "@/core/providers/events";
import type { SolariServices } from "@/core/solari/contracts";
import { ResourceSupervisor } from "@/core/solari/resource-supervisor";
import { createAgentToolBroker } from "@/core/tools/broker";
import { AgentToolError } from "@/core/tools/types";

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

  it("executes argument arrays without a shell and with only the supplied environment", async () => {
    const { root, broker } = await fixtureBroker({
      environment: {
        LANG: "test-language",
        SOLARI_API_KEY: "slr_live_must_not_reach_local_commands",
      },
    });
    const result = await broker.invoke(
      "workspace_exec",
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(String(process.env.LANG)+':'+String(process.env.SOLARI_API_KEY))",
        ],
      },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "test-language:undefined",
      stderr: "",
      timedOut: false,
      outputTruncated: false,
    });
    await expect(
      broker.invoke(
        "workspace_exec",
        { command: `echo unsafe > ${join(root, "shell-created.txt")}`, args: [] },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AgentToolError);
    await expect(access(join(root, "shell-created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses the smaller remaining deadline and caps aggregate command output at one MiB", async () => {
    const { broker } = await fixtureBroker({ remainingMs: () => 25 });
    const timedOut = await broker.invoke(
      "workspace_exec",
      {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 120_000,
      },
      new AbortController().signal,
    );
    expect(timedOut).toMatchObject({ timedOut: true });

    const { broker: outputBroker } = await fixtureBroker();
    const output = (await outputBroker.invoke(
      "workspace_exec",
      {
        command: process.execPath,
        args: ["-e", `process.stdout.write("x".repeat(${1024 * 1024 + 256}))`],
      },
      new AbortController().signal,
    )) as { stdout: string; stderr: string; outputTruncated: boolean };
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBe(
      1024 * 1024,
    );
    expect(output.outputTruncated).toBe(true);
  });

  it("terminates descendant processes when a workspace command times out", async () => {
    const { root, broker } = await fixtureBroker();
    const sentinel = join(root, "descendant-survived.txt");
    const descendant = [
      "setTimeout(() =>",
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'leak'),`,
      "400)",
    ].join(" ");
    const parent = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});`,
      "setTimeout(()=>{},10000);",
    ].join("");

    await expect(
      broker.invoke(
        "workspace_exec",
        { command: process.execPath, args: ["-e", parent], timeoutMs: 100 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
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
