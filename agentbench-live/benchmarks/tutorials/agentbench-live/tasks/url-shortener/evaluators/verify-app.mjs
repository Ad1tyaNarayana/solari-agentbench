import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { cpSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function prepareBuildSource(source, target) {
  cpSync(source, target, { recursive: true });
  function writable(directory) {
    chmodSync(directory, 0o755);
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) writable(path);
      else chmodSync(path, 0o644);
    }
  }
  writable(target);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
const cwd = "/result/build-source";
prepareBuildSource("/submission/source", cwd);
for (const [command, args] of [["npm", ["install", "--ignore-scripts"]], ["npm", ["run", "build"]]]) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { PATH: process.env.PATH ?? "", HOME: "/tmp" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn("npm", ["start", "--", "--hostname", "0.0.0.0", "--port", "3000"], { cwd, stdio: "inherit", env: { PATH: process.env.PATH ?? "", HOME: "/tmp", PORT: "3000" } });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
}
