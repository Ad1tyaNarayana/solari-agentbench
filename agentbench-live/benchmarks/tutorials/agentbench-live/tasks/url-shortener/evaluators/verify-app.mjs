import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const cwd = "/submission/source";
for (const [command, args] of [["npm", ["install", "--ignore-scripts"]], ["npm", ["run", "build"]]]) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { PATH: process.env.PATH ?? "", HOME: "/tmp" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn("npm", ["start", "--", "--hostname", "0.0.0.0", "--port", "3000"], { cwd, stdio: "inherit", env: { PATH: process.env.PATH ?? "", HOME: "/tmp", PORT: "3000" } });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
