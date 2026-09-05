import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

test("URL verification builds in a writable copy without changing sealed submission inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "url-build-copy-"));
  const source = join(root, "source");
  const work = join(root, "work");
  await mkdir(source);
  await writeFile(join(source, "package.json"), "{}");
  const moduleUrl = pathToFileURL(resolve("benchmarks/tutorials/agentbench-live/tasks/url-shortener/evaluators/verify-app.mjs")).href;
  const script = `const {prepareBuildSource}=await import(${JSON.stringify(moduleUrl)}); const fs=await import('node:fs'); prepareBuildSource(${JSON.stringify(source)},${JSON.stringify(work)}); fs.writeFileSync(${JSON.stringify(join(work, "package.json"))}, '{"built":true}');`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script]);
  expect(await readFile(join(source, "package.json"), "utf8")).toBe("{}");
  expect(await readFile(join(work, "package.json"), "utf8")).toBe('{"built":true}');
});
