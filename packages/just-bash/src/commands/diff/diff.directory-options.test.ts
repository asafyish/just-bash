import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("diff directory and comparison options", () => {
  it("compares directory entries and recurses only with -r", async () => {
    const bash = new Bash({
      files: {
        "/a/x.txt": "1\n",
        "/b/x.txt": "2\n",
        "/a/y.txt": "y\n",
        "/a/sub/z": "old\n",
        "/b/sub/z": "new\n",
      },
    });
    expect(await bash.exec("diff -ru /a /b")).toMatchObject({
      stdout:
        "diff -ru /a/sub/z /b/sub/z\n--- /a/sub/z\n+++ /b/sub/z\n@@ -1 +1 @@\n-old\n+new\ndiff -ru /a/x.txt /b/x.txt\n--- /a/x.txt\n+++ /b/x.txt\n@@ -1 +1 @@\n-1\n+2\nOnly in /a: y.txt\n",
      stderr: "",
      exitCode: 1,
    });
    expect(await bash.exec("diff -q /a /b")).toMatchObject({
      stdout:
        "Common subdirectories: /a/sub and /b/sub\nFiles /a/x.txt and /b/x.txt differ\nOnly in /a: y.txt\n",
      stderr: "",
      exitCode: 1,
    });
    expect(await bash.exec("diff -r /a /a")).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.exec("diff -r /a /missing")).toMatchObject({
      stdout: "",
      stderr: "diff: /missing: No such file or directory\n",
      exitCode: 2,
    });
  });

  it("honors unified context counts and returns trouble for invalid options", async () => {
    const bash = new Bash({
      files: { "/a": "before\nold\nafter\n", "/b": "before\nnew\nafter\n" },
    });
    for (const option of ["-U0", "-U 0", "--unified=0"]) {
      expect(await bash.exec(`diff ${option} /a /b`)).toMatchObject({
        stdout: "--- /a\n+++ /b\n@@ -2 +2 @@\n-old\n+new\n",
        stderr: "",
        exitCode: 1,
      });
    }
    expect(await bash.exec("diff --invalid /a /b")).toMatchObject({
      stdout: "",
      stderr: "diff: unrecognized option '--invalid'\n",
      exitCode: 2,
    });
    expect(await bash.exec("diff -U nope /a /b")).toMatchObject({
      stdout: "",
      stderr: "diff: invalid context length 'nope'\n",
      exitCode: 2,
    });
  });

  it("ignores requested whitespace and blank-only changes without hiding real edits", async () => {
    const bash = new Bash({
      files: {
        "/a": "a b\nend\n",
        "/b": "ab\nend\n",
        "/c": "a   b \nend\n",
        "/blank": "a b\n\nend\n",
        "/changed": "a b\n\nchanged\n",
      },
    });
    for (const command of [
      "diff -w /a /b",
      "diff -b /a /c",
      "diff -B /a /blank",
      "diff -qw /a /b",
    ]) {
      expect(await bash.exec(command)).toMatchObject({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    }
    expect(await bash.exec("diff -b /a /b")).toMatchObject({
      stdout: "1c1\n< a b\n---\n> ab\n",
      stderr: "",
      exitCode: 1,
    });
    expect(await bash.exec("diff -B /a /changed")).toMatchObject({
      stdout: "2c2,3\n< end\n---\n> \n> changed\n",
      stderr: "",
      exitCode: 1,
    });
  });
});
