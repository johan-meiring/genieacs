import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBuildMetadata } from "../build/build-metadata.ts";

const execFileAsync = promisify(execFile);

void test("build metadata handles untracked filenames without Git quoting", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "genieacs-build-metadata-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Build test",
        "-c",
        "user.email=build@example.invalid",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "test fixture",
      ],
      { cwd },
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
    });
    const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
    assert.strictEqual(await getBuildMetadata(cwd), date + stdout.slice(0, 4));

    const names = ["ordinary.txt", "space file", "unicode-é"];
    if (process.platform !== "win32")
      names.push(
        " leading and trailing ",
        'quoted"file',
        "-lh --time-style=long-iso \\",
        "tab\tfile",
        "line\nbreak",
      );
    for (const name of names) await writeFile(path.join(cwd, name), "first");
    const initial = await getBuildMetadata(cwd);
    assert.match(initial, /^\d{6}[a-f0-9]{4}$/);
    assert.strictEqual(await getBuildMetadata(cwd), initial);

    await writeFile(path.join(cwd, names[names.length - 1]), "changed");
    assert.notStrictEqual(await getBuildMetadata(cwd), initial);

    await execFileAsync("git", ["add", "--", "ordinary.txt"], { cwd });
    const staged = await getBuildMetadata(cwd);
    await writeFile(path.join(cwd, "ordinary.txt"), "tracked change");
    assert.notStrictEqual(await getBuildMetadata(cwd), staged);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
