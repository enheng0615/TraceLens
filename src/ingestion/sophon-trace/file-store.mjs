import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function isValidJsonFile(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) return false;
    await readJson(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function writeTextAtomic(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, filePath);
}

export async function removePath(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

export function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function stableText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const text = stableText(value);
  return text === null ? null : createHash("sha256").update(text).digest("hex");
}
