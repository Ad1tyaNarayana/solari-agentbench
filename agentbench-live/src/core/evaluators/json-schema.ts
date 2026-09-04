import { readFile } from "node:fs/promises";
import { posix, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { BenchmarkSnapshot } from "@/core/benchmarks/snapshot";

function safeSchemaPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error(`Unsafe schema $ref or path: ${path}`);
  return posix.normalize(normalized);
}

function rejectRemoteRefs(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach(rejectRemoteRefs);
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(child) || child.startsWith("/"))) throw new Error(`Remote or absolute $ref is forbidden: ${child}`);
    rejectRemoteRefs(child);
  }
}

export async function compileSnapshotSchema(snapshot: BenchmarkSnapshot, schemaPath: string) {
  const safe = safeSchemaPath(schemaPath);
  if (!snapshot.files.some((file) => file.path === safe)) throw new Error(`Schema is not in benchmark snapshot: ${safe}`);
  const schema = JSON.parse(await readFile(join(snapshot.root, ...safe.split("/")), "utf8")) as object;
  rejectRemoteRefs(schema);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    loadSchema: async (uri: string) => {
      const path = safeSchemaPath(posix.join(posix.dirname(safe), uri));
      if (!snapshot.files.some((file) => file.path === path)) throw new Error(`Referenced schema is not in benchmark snapshot: ${path}`);
      const referenced = JSON.parse(await readFile(join(snapshot.root, ...path.split("/")), "utf8")) as object;
      rejectRemoteRefs(referenced);
      return referenced;
    },
  });
  return ajv.compileAsync(schema);
}
