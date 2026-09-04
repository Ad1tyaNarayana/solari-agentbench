import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BenchmarkLoader } from "@/core/benchmarks/loader";
import { BenchmarkValidationError } from "@/core/benchmarks/types";
import { renderBenchmark } from "./render";
import { changedRevisionPaths, readRevision, renderedDigest, renderedRevision } from "./revisions";
import { AuthoringError, type AuthoringRevision, type BenchmarkDraft, type PreviewResult, type ReadDraftResult, type RenderedBenchmarkFile } from "./types";

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const locks = new Map<string, Promise<void>>();
async function writeRendered(root: string, files: RenderedBenchmarkFile[]): Promise<void> { for (const file of files) { const path = join(root, ...file.path.split("/")); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.contents, "utf8"); } }

export class AuthoringService {
  private readonly roots: string[];
  private readonly loader: BenchmarkLoader;
  constructor(options: { writableRoots: string[]; snapshotsRoot: string }) { this.roots = options.writableRoots.map((root) => resolve(root)); this.loader = new BenchmarkLoader(options.snapshotsRoot); }

  async preview(draft: BenchmarkDraft): Promise<PreviewResult> {
    try { const files = renderBenchmark(draft); return { files, diagnostics: [], snapshotDigest: renderedDigest(files) }; }
    catch (error) { return { files: [], diagnostics: error instanceof BenchmarkValidationError ? error.diagnostics : [{ path: "$", code: "invalid", message: error instanceof Error ? error.message : String(error) }], snapshotDigest: "" }; }
  }
  async create(input: { draft: BenchmarkDraft; rootIndex?: number }): Promise<ReadDraftResult> {
    this.assertId(input.draft.id); const root = this.roots[input.rootIndex ?? 0]; if (!root) throw new AuthoringError("benchmark_read_only", "No writable benchmark root is configured");
    const target = join(root, input.draft.id); return this.withLock(target, async () => {
      try { await readRevision(target); throw new AuthoringError("benchmark_conflict", `Benchmark already exists: ${input.draft.id}`, []); } catch (error) { if (error instanceof AuthoringError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.swap(undefined, target, input.draft); return this.readDraft(input.draft.id);
    });
  }
  async save(input: { packId: string; expectedRevision: AuthoringRevision; draft: BenchmarkDraft }): Promise<ReadDraftResult> {
    this.assertId(input.packId); if (input.draft.id !== input.packId) throw new AuthoringError("benchmark_invalid", "Changing a benchmark ID requires creating a new pack");
    const target = await this.find(input.packId); return this.withLock(target, async () => {
      const actual = await readRevision(target); const changedPaths = changedRevisionPaths(input.expectedRevision, actual);
      if (changedPaths.length) throw new AuthoringError("benchmark_conflict", "Benchmark changed on disk", changedPaths);
      const rendered = renderBenchmark(input.draft); if (changedRevisionPaths(actual, renderedRevision(rendered)).length === 0) return this.readDraft(input.packId);
      await this.swap(target, target, input.draft); return this.readDraft(input.packId);
    });
  }
  async readDraft(id: string): Promise<ReadDraftResult> {
    const root = await this.find(id); const loaded = await this.loader.load(root);
    const tasks = await Promise.all(loaded.definition.tasks.map(async (task) => ({ id: task.id, name: task.name, prompt: task.prompt.replace(/\n$/, ""), fixtures: [...task.fixtures], allowedPrimitives: [...task.allowedPrimitives], planningRequired: task.planningRequired, resourceLimits: { ...task.resourceLimits }, submission: { directory: task.submission.directory, required: [...task.submission.required] }, evaluators: await Promise.all(task.evaluators.map(async (item) => { const config = { ...item.config }; const asset = item.type === "model-judge" ? config.rubric : item.type === "schema" ? config.schema : undefined; if (typeof asset === "string") { const textKey = item.type === "model-judge" ? "rubricText" : "schemaText"; config[textKey] = (await readFile(join(root, task.snapshotPrefix ?? `tasks/${task.id}`, asset), "utf8")).replace(/\n$/, ""); } return { ...item, prerequisites: [...item.prerequisites], config }; })) })));
    const draft: BenchmarkDraft = { schemaVersion: 1, id: loaded.definition.id, name: loaded.definition.name, version: loaded.definition.version, ...(loaded.definition.description ? { description: loaded.definition.description } : {}), defaults: { ...loaded.definition.defaults }, tasks, agents: loaded.definition.agents.map((agent) => ({ ...agent, harness: { ...agent.harness }, options: { ...agent.options } })) };
    return { draft, revision: await readRevision(root), snapshotDigest: loaded.snapshot.digest };
  }
  async getPackRoot(id: string): Promise<string> { return this.find(id); }
  async list(): Promise<Array<{ id: string; name: string; version: string; writable: boolean }>> { const results = []; for (const root of this.roots) { await mkdir(root, { recursive: true }); for (const id of await (await import("node:fs/promises")).readdir(root)) { if (!idPattern.test(id)) continue; try { const loaded = await this.loader.load(join(root, id)); results.push({ id: loaded.definition.id, name: loaded.definition.name, version: loaded.definition.version, writable: true }); } catch {} } } return results.sort((a, b) => a.id.localeCompare(b.id)); }

  private assertId(id: string): void { if (!idPattern.test(id)) throw new AuthoringError("benchmark_invalid", "Benchmark id must be lowercase kebab-case"); }
  private async find(id: string): Promise<string> { this.assertId(id); for (const root of this.roots) { const target = join(root, id); try { await readRevision(target); return target; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } throw new AuthoringError("benchmark_not_found", `Benchmark not found: ${id}`); }
  private async swap(existing: string | undefined, target: string, draft: BenchmarkDraft): Promise<void> {
    const parent = dirname(target); await mkdir(parent, { recursive: true }); const temporary = join(parent, `.agentbench-write-${randomUUID()}`); const backup = join(parent, `.agentbench-backup-${randomUUID()}`);
    try { await writeRendered(temporary, renderBenchmark(draft)); await this.loader.load(temporary); if (existing) await rename(existing, backup); try { await rename(temporary, target); } catch (error) { if (existing) await rename(backup, existing); throw error; } if (existing) await rm(backup, { recursive: true, force: true }); }
    catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> { const previous = locks.get(key) ?? Promise.resolve(); let release!: () => void; const current = new Promise<void>((done) => { release = done; }); const queued = previous.then(() => current); locks.set(key, queued); await previous; try { return await action(); } finally { release(); if (locks.get(key) === queued) locks.delete(key); } }
}
