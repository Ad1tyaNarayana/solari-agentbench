import { mkdtemp, mkdir, writeFile, symlink, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkLoader } from "@/core/benchmarks/loader";

async function createPack() {
  const root = await mkdtemp(join(tmpdir(), "agentbench-pack-"));
  const snapshots = await mkdtemp(join(tmpdir(), "agentbench-snapshots-"));
  await mkdir(join(root, "tasks", "task", "fixtures"), { recursive: true });
  const benchmarkYaml = `schemaVersion: 1\nid: demo\nname: Demo\nversion: 1.0.0\ntaskRoots: [tasks]\ndefaults:\n  timeoutSeconds: 30\n  maxConcurrency: 1\n  submissionDirectory: submission\n`;
  const agentsYaml = `schemaVersion: 1\nagents:\n  - schemaVersion: 1\n    id: agent\n    name: Agent\n    provider: test\n    harness: { id: test, version: '1' }\n`;
  const taskYaml = `schemaVersion: 1\nid: task\nname: Task\nprompt: prompt.md\nfixtures: [fixtures/input.txt]\nresources:\n  allowed: [sandbox]\n  planningRequired: false\n  budget: { browserSessions: 0, sandboxes: 1, desktops: 0, totalMinutes: 1 }\nsubmission: { directory: submission, required: [result.txt] }\nevaluators:\n  - id: files\n    type: file\n    weight: 100\n    config: { subject: result.txt }\n`;
  await writeFile(join(root, "benchmark.yaml"), benchmarkYaml);
  await writeFile(join(root, "agents.yaml"), agentsYaml);
  await writeFile(join(root, "tasks", "task", "task.yaml"), taskYaml);
  await writeFile(join(root, "tasks", "task", "prompt.md"), "Solve this task");
  await writeFile(join(root, "tasks", "task", "fixtures", "input.txt"), "fixture");
  return { root, snapshots, taskYaml };
}

describe("BenchmarkLoader path safety", () => {
  it("loads prompts, fixtures, and normalized definition", async () => {
    const fixture = await createPack();
    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);
    expect(loaded.definition.root).toBe(fixture.root);
    expect(loaded.definition.tasks[0]?.prompt).toBe("Solve this task");
    expect(loaded.definition.tasks[0]?.fixtures).toEqual(["fixtures/input.txt"]);
    expect(loaded.definition.agents[0]?.id).toBe("agent");
  });

  it("sorts task and agent IDs by UTF-8 byte order", async () => {
    const fixture = await createPack();
    const agentsYaml = `schemaVersion: 1
agents:
  - schemaVersion: 1
    id: ä
    name: Umlaut Agent
    provider: test
    harness: { id: test, version: '1' }
  - schemaVersion: 1
    id: z
    name: Z Agent
    provider: test
    harness: { id: test, version: '1' }
`;
    await writeFile(join(fixture.root, "agents.yaml"), agentsYaml);
    await mkdir(join(fixture.root, "tasks", "z", "fixtures"), { recursive: true });
    await mkdir(join(fixture.root, "tasks", "ä", "fixtures"), { recursive: true });
    for (const id of ["z", "ä"]) {
      await writeFile(
        join(fixture.root, "tasks", id, "task.yaml"),
        fixture.taskYaml.replace("id: task", `id: ${id}`),
      );
      await writeFile(join(fixture.root, "tasks", id, "prompt.md"), `Prompt ${id}`);
      await writeFile(join(fixture.root, "tasks", id, "fixtures", "input.txt"), id);
    }

    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);

    expect(loaded.definition.tasks.map((task) => task.id)).toEqual(["task", "z", "ä"]);
    expect(loaded.definition.agents.map((agent) => agent.id)).toEqual(["z", "ä"]);
  });

  it("rejects a prompt outside the pack root", async () => {
    const fixture = await createPack();
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), fixture.taskYaml.replace("prompt.md", "../../../outside.md"));
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).rejects.toThrow(/path escapes benchmark root|safe relative/i);
  });

  it("rejects an absolute prompt path", async () => {
    const fixture = await createPack();
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), fixture.taskYaml.replace("prompt.md", "C:/outside.md"));
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).rejects.toThrow(/absolute|safe relative|path escapes/i);
  });

  it("rejects a missing fixture", async () => {
    const fixture = await createPack();
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), fixture.taskYaml.replace("fixtures/input.txt", "fixtures/missing.txt"));
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).rejects.toThrow(/missing|not found/i);
  });

  it("rejects duplicate task IDs across folders", async () => {
    const fixture = await createPack();
    await mkdir(join(fixture.root, "tasks", "other"));
    await writeFile(join(fixture.root, "tasks", "other", "task.yaml"), fixture.taskYaml);
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).rejects.toThrow(/duplicate.*task/i);
  });

  it("rejects a symlink whose real path leaves the pack root", async () => {
    const fixture = await createPack();
    const outside = await mkdtemp(join(tmpdir(), "agentbench-outside-"));
    await writeFile(join(outside, "prompt.md"), "outside");
    try {
      await symlink(join(outside, "prompt.md"), join(fixture.root, "tasks/task/linked.md"));
    } catch (error) {
      if (process.platform === "win32" && /privilege|EPERM|operation not permitted/i.test(String(error))) return;
      throw error;
    }
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), fixture.taskYaml.replace("prompt.md", "linked.md"));
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).rejects.toThrow(/path escapes benchmark root/i);
  });

  it("snapshots canonical evaluator asset declarations including basename command files", async () => {
    const fixture = await createPack();
    await writeFile(join(fixture.root, "tasks/task/verify.py"), "print('ok')");
    await writeFile(join(fixture.root, "tasks/task/expected.json"), "{}");
    const task = fixture.taskYaml.replace("type: file", "type: command").replace("config: { subject: result.txt }", "config: { command: [python, verify.py], expected: expected.json }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);
    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);
    await expect(access(join(loaded.snapshot.root, "tasks/task/verify.py"))).resolves.toBeUndefined();
    await expect(readFile(join(loaded.snapshot.root, "tasks/task/expected.json"), "utf8")).resolves.toBe("{}");
  });

  it("loads and snapshots a schema evaluator config.schema asset", async () => {
    const fixture = await createPack();
    await mkdir(join(fixture.root, "tasks/task/evaluators"));
    await writeFile(join(fixture.root, "tasks/task/evaluators/result.schema.json"), '{"type":"object"}');
    const task = fixture.taskYaml
      .replace("type: file", "type: schema")
      .replace("config: { subject: result.txt }", "config: { schema: evaluators/result.schema.json }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);

    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);

    expect(loaded.definition.tasks[0]?.evaluators[0]?.config.schema).toBe("evaluators/result.schema.json");
    await expect(readFile(join(loaded.snapshot.root, "tasks/task/evaluators/result.schema.json"), "utf8"))
      .resolves.toBe('{"type":"object"}');
  });

  it("loads and snapshots a model-judge evaluator config.rubric asset", async () => {
    const fixture = await createPack();
    await mkdir(join(fixture.root, "tasks/task/rubrics"));
    await writeFile(join(fixture.root, "tasks/task/rubrics/quality.md"), "Award points for correctness.");
    const task = fixture.taskYaml
      .replace("type: file", "type: model-judge")
      .replace("config: { subject: result.txt }", "config: { rubric: rubrics/quality.md }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);

    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);

    expect(loaded.definition.tasks[0]?.evaluators[0]?.config.rubric).toBe("rubrics/quality.md");
    await expect(readFile(join(loaded.snapshot.root, "tasks/task/rubrics/quality.md"), "utf8"))
      .resolves.toBe("Award points for correctness.");
  });

  it("loads and snapshots a command evaluator config.script asset", async () => {
    const fixture = await createPack();
    await mkdir(join(fixture.root, "tasks/task/evaluators"));
    await writeFile(join(fixture.root, "tasks/task/evaluators/verify.py"), "print('verified')");
    const task = fixture.taskYaml
      .replace("type: file", "type: command")
      .replace("config: { subject: result.txt }", "config: { script: evaluators/verify.py }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);

    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);

    expect(loaded.definition.tasks[0]?.evaluators[0]?.config.script).toBe("evaluators/verify.py");
    await expect(readFile(join(loaded.snapshot.root, "tasks/task/evaluators/verify.py"), "utf8"))
      .resolves.toBe("print('verified')");
  });

  it("loads and snapshots a command evaluator config.fixture asset", async () => {
    const fixture = await createPack();
    await writeFile(join(fixture.root, "tasks/task/fixtures/expected.json"), '{"status":"ok"}');
    const task = fixture.taskYaml
      .replace("type: file", "type: command")
      .replace("config: { subject: result.txt }", "config: { fixture: fixtures/expected.json }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);

    const loaded = await new BenchmarkLoader(fixture.snapshots).load(fixture.root);

    expect(loaded.definition.tasks[0]?.evaluators[0]?.config.fixture).toBe("fixtures/expected.json");
    await expect(readFile(join(loaded.snapshot.root, "tasks/task/fixtures/expected.json"), "utf8"))
      .resolves.toBe('{"status":"ok"}');
  });

  it("does not treat asset-looking keys on unrelated evaluator types as files", async () => {
    const fixture = await createPack();
    const task = fixture.taskYaml.replace("type: file", "type: numeric").replace("config: { subject: result.txt }", "config: { script: missing.py }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).resolves.toBeTruthy();
  });

  it("does not treat script as an asset on schema evaluators", async () => {
    const fixture = await createPack();
    const task = fixture.taskYaml.replace("type: file", "type: schema").replace("config: { subject: result.txt }", "config: { script: missing.py }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).resolves.toBeTruthy();
  });

  it("does not treat schema as an asset on model-judge evaluators", async () => {
    const fixture = await createPack();
    const task = fixture.taskYaml.replace("type: file", "type: model-judge").replace("config: { subject: result.txt }", "config: { schema: missing.json }");
    await writeFile(join(fixture.root, "tasks/task/task.yaml"), task);
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).resolves.toBeTruthy();
  });

  it("rejects a task-folder symlink that resolves outside the pack", async () => {
    const fixture = await createPack();
    const outside = await mkdtemp(join(tmpdir(), "agentbench-task-outside-"));
    await mkdir(join(outside, "task"));
    await writeFile(join(outside, "task", "task.yaml"), fixture.taskYaml);
    await writeFile(join(outside, "task", "prompt.md"), "outside");
    try { await symlink(join(outside, "task"), join(fixture.root, "tasks", "linked"), "junction"); }
    catch (error) { if (process.platform === "win32" && /privilege|EPERM|operation not permitted/i.test(String(error))) return; throw error; }
    await expect(new BenchmarkLoader(fixture.snapshots).load(fixture.root)).rejects.toThrow(/path escapes benchmark root/i);
  });
});
