import path from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function getBuildMetadata(cwd = process.cwd()): Promise<string> {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  const [commitResult, diffResult, newFilesResult] = await Promise.all([
    execAsync("git rev-parse HEAD", { cwd }),
    execAsync("git diff HEAD", { cwd }),
    execAsync("git ls-files --others --exclude-standard -z", { cwd }),
  ]);
  const commit = commitResult.stdout.trim();
  const diff = diffResult.stdout.trim();
  const newFiles = newFilesResult.stdout.split("\0").filter((file) => file);

  if (!diff && !newFiles.length) return date + commit.slice(0, 4);

  const hash = createHash("md5");
  hash.update(commit).update(diff);
  for (const file of newFiles) {
    hash.update(file).update("\0");
    hash.update(await readFile(path.join(cwd, file)));
  }
  return date + hash.digest("hex").slice(0, 4);
}
