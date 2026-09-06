import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { BenchmarkCatalog } from "@/core/benchmarks/catalog";
import { CertificationService } from "@/core/certification/service";
import { createBuiltinEvaluatorRegistry } from "@/core/evaluators/builtins";

const execFileAsync = promisify(execFile);
const packRoot = resolve("examples/packs/raft-consensus-reproduction");
const taskRoot = join(packRoot, "tasks", "raft-safety");
const referenceRoot = join(packRoot, "reference-submission");
const temporaryRoots: string[] = [];

test("Raft instructions expose a schema-valid results contract and verifier event vocabulary", async () => {
  const prompt = await readFile(join(taskRoot, "prompt.md"), "utf8");
  const example = prompt.match(/<!-- results-contract -->\s*```json\s*([\s\S]*?)```/);
  expect(example, "agent must receive an exact results.json example").not.toBeNull();
  const schema = JSON.parse(await readFile(join(taskRoot, "evaluators/results.schema.json"), "utf8"));
  expect(new Ajv2020().validate(schema, JSON.parse(example![1]))).toBe(true);
  const verifier = await readFile(join(taskRoot, "evaluators/verify-raft.mjs"), "utf8");
  const events = [...verifier.matchAll(/(?:event|item)\.type === "([^"]+)"/g)].map(m => m[1]);
  for (const event of new Set(events)) expect(prompt).toContain(`\`${event}\``);
  for (const name of ["finalTerm", "finalLeader", "partitionObserved", "logMatching", "leaderCompleteness", "stateMachineSafety", "quorumBehavior"]) expect(prompt).toContain(`\`${name}\``);
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

test("discovers the Raft pack as an external root with deterministic scoring", async () => {
  const snapshots = await temporaryDirectory("raft-snapshots-");
  const loaded = await new BenchmarkLoader(snapshots).load(packRoot);

  expect(loaded.definition.id).toBe("raft-consensus-reproduction");
  expect(loaded.definition.tasks).toHaveLength(1);
  expect(loaded.definition.tasks[0]).toMatchObject({
    id: "raft-safety",
    allowedPrimitives: ["sandbox", "browser"],
    evaluationPolicy: {
      maxModelJudgeWeight: 30,
      allowModelJudgeMajority: false,
    },
  });
  expect(loaded.definition.tasks[0].evaluators.reduce((sum, item) =>
    sum + (item.enabled ? item.weight : 0), 0,
  )).toBe(100);
  expect(loaded.definition.tasks[0].evaluators.filter((item) =>
    item.type === "model-judge",
  )).toHaveLength(0);
  expect(loaded.snapshot.files.map((file) => file.path)).toContain(
    "tasks/raft-safety/evaluators/verify-raft.mjs",
  );
});

test("external-only certification validates the reference but rejects fake Solari provenance", async () => {
  const snapshots = await temporaryDirectory("raft-cert-snapshots-");
  const outputRoot = await temporaryDirectory("raft-cert-output-");
  const outputPath = join(outputRoot, "live-reference.json");
  const loader = new BenchmarkLoader(snapshots);
  const catalog = new BenchmarkCatalog([packRoot], loader);
  expect((await catalog.listTasks()).map((task) => task.id)).toEqual(["raft-safety"]);
  const services = { browser: {}, sandbox: {}, desktop: {} };
  const evaluator = { run: vi.fn() };
  const certification = new CertificationService({
    loader,
    registry: createBuiltinEvaluatorRegistry(services as never),
    evaluator: evaluator as never,
    services: services as never,
    repositoryCommit: "test-commit",
  });

  await expect(certification.validate({ benchmarkRoot: packRoot, submissionDirectory: referenceRoot }))
    .resolves.toMatchObject({ valid: true, provisioned: false, benchmarkId: "raft-consensus-reproduction", taskId: "raft-safety" });
  await expect(certification.certify({ benchmarkRoot: packRoot, submissionDirectory: referenceRoot, outputPath }))
    .rejects.toThrow(/live Solari services are required/i);
  expect(evaluator.run).not.toHaveBeenCalled();
  await expect(access(outputPath)).rejects.toThrow();
});

test("reference simulator produces byte-stable passing traces for every pinned scenario", async () => {
  for (const name of [
    "stable-election",
    "leader-failover",
    "minority-isolation",
    "majority-recovery",
    "divergent-log-repair",
  ]) {
    const first = await temporaryDirectory(`raft-${name}-first-`);
    const second = await temporaryDirectory(`raft-${name}-second-`);
    const scenario = join(taskRoot, "fixtures", `${name}.json`);
    await runReference(scenario, first);
    await runReference(scenario, second);

    expect(await readFile(join(first, "summary.json"))).toEqual(
      await readFile(join(second, "summary.json")),
    );
    expect(await readFile(join(first, "trace.jsonl"))).toEqual(
      await readFile(join(second, "trace.jsonl")),
    );
    expect(JSON.parse(await readFile(join(first, "summary.json"), "utf8")))
      .toMatchObject({ scenario: name, passed: true });
    expect(await readFile(join(first, "viewer", "index.html"), "utf8"))
      .toMatch(/data-testid="invariant-election-safety"[^>]*>PASS/);
  }
});

test("reference shell entrypoint uses Linux-compatible line endings", async () => {
  expect(await readFile(join(referenceRoot, "run"), "utf8")).not.toContain("\r");
});

test("independent verifier reruns the reference and emits trace-derived assertions", async () => {
  const resultRoot = await temporaryDirectory("raft-verifier-");
  const resultFile = join(resultRoot, "evaluator-result.json");
  await execFileAsync(process.execPath, [
    join(taskRoot, "evaluators", "verify-raft.mjs"),
  ], {
    env: {
      ...process.env,
      AGENTBENCH_SUBMISSION_ROOT: referenceRoot,
      AGENTBENCH_RAFT_TASK_ROOT: taskRoot,
      AGENTBENCH_RESULT_ROOT: resultRoot,
      AGENTBENCH_RESULT: resultFile,
    },
  });

  const result = JSON.parse(await readFile(resultFile, "utf8"));
  expect(result.assertions.length).toBeGreaterThanOrEqual(15);
  expect(result.assertions.every((item: { passed: boolean }) => item.passed)).toBe(true);
  expect(result.outputs).toMatchObject({
    electionSafety: "PASS",
    logMatching: "PASS",
    leaderCompleteness: "PASS",
    stateMachineSafety: "PASS",
    quorumBehavior: "PASS",
  });
  expect(await readFile(join(resultRoot, "viewer", "index.html"), "utf8"))
    .toContain("Raft fault trace");
});

test("trace derivation independently rejects each mutated Raft invariant", async () => {
  const evaluatorUrl = pathToFileURL(join(taskRoot, "evaluators", "verify-raft.mjs"));
  const { deriveInvariants } = await import(evaluatorUrl.href);
  const fixtures = JSON.parse(await readFile(join(
    resolve("tests/fixtures/raft"), "mutated-traces.json",
  ), "utf8"));
  for (const fixture of fixtures) {
    expect(deriveInvariants(fixture.events, { id: fixture.id, expectations: {} }))
      .toMatchObject({ [fixture.violates]: false });
  }
});

async function runReference(scenario: string, output: string) {
  await execFileAsync(process.execPath, [
    join(referenceRoot, "source", "raft.mjs"),
    scenario,
    "20260904",
    output,
  ]);
}

async function temporaryDirectory(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
