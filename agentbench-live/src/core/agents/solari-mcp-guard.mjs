#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const createTools = new Set([
  "solari_browser_create",
  "solari_sandbox_create",
  "solari_desktop_create",
]);
const allowedCreateTools = new Set(
  (process.argv[2] ?? "").split(",").filter(Boolean),
);
const [upstreamCommand, ...upstreamArgs] = process.argv.slice(3);

if (!upstreamCommand) {
  process.stderr.write("solari-mcp-guard: upstream command is required\n");
  process.exit(2);
}

const upstream = spawn(upstreamCommand, upstreamArgs, {
  env: process.env,
  shell:
    process.platform === "win32" &&
    /^(?:npm|npx)(?:\.cmd)?$/i.test(upstreamCommand),
  windowsHide: true,
  stdio: ["pipe", "pipe", "inherit"],
});
const provisioned = new Set();

function rejectRequest(request, code, message) {
  if (request.id === undefined) return;
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code, message },
    })}\n`,
  );
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    upstream.stdin.write(`${line}\n`);
    return;
  }

  const tool = request?.method === "tools/call" ? request.params?.name : undefined;
  if (typeof tool === "string" && createTools.has(tool)) {
    if (!allowedCreateTools.has(tool)) {
      rejectRequest(
        request,
        -32002,
        `Solari provisioning is not approved for ${tool}`,
      );
      return;
    }
    if (provisioned.has(tool)) {
      rejectRequest(
        request,
        -32001,
        `Solari provisioning limit reached for ${tool} (maximum 1)`,
      );
      return;
    }
    provisioned.add(tool);
  }

  upstream.stdin.write(`${line}\n`);
});
input.on("close", () => upstream.stdin.end());
upstream.stdout.pipe(process.stdout);
upstream.once("error", (error) => {
  process.stderr.write(`solari-mcp-guard: ${error.message}\n`);
  process.exitCode = 1;
});
upstream.once("close", (code) => {
  process.exitCode = code ?? 1;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (!upstream.killed) upstream.kill(signal);
  });
}
