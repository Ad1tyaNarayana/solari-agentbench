import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolvePackFile(packRoot: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes("\0")) throw new Error("invalid benchmark path");
  const normalized = relativePath.replaceAll("\\", "/");
  if (isAbsolute(relativePath) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("path escapes benchmark root");
  }
  const root = await realpath(packRoot);
  const candidate = resolve(root, ...normalized.split("/"));
  const candidateRelative = relative(root, candidate);
  if (candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) throw new Error("path escapes benchmark root");
  let actual: string;
  try { actual = await realpath(candidate); } catch { throw new Error(`missing benchmark asset: ${relativePath}`); }
  const actualRelative = relative(root, actual);
  const equal = process.platform === "win32" ? actualRelative.toLowerCase() : actualRelative;
  if (equal === ".." || equal.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error("path escapes benchmark root");
  const info = await stat(actual);
  if (!info.isFile()) throw new Error(`benchmark path is not a file: ${relativePath}`);
  return actual;
}

export async function resolvePackDirectory(packRoot: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes("\0")) throw new Error("invalid benchmark path");
  const normalized = relativePath.replaceAll("\\", "/");
  if (isAbsolute(relativePath) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) throw new Error("path escapes benchmark root");
  const root = await realpath(packRoot);
  const actual = await realpath(resolve(root, ...normalized.split("/"))).catch(() => { throw new Error(`missing benchmark asset: ${relativePath}`); });
  const actualRelative = relative(root, actual);
  if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error("path escapes benchmark root");
  if (!(await stat(actual)).isDirectory()) throw new Error(`benchmark path is not a directory: ${relativePath}`);
  return actual;
}
