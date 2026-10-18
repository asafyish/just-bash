import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("rg existence-only searches", () => {
  it.each([
    ["-l", "/input\n", 0],
    ["-q", "", 0],
    ["--files-without-match", "", 1],
    ["-vl", "/input\n", 0],
  ])("stops matching after the answer is known for %s", async (flags, stdout, exitCode) => {
    const bash = new Bash({
      files: { "/input": `first\n${"match\n".repeat(4000)}` },
      executionLimits: { maxLoopIterations: 100 },
    });
    expect(await bash.exec(`rg ${flags} match /input`)).toMatchObject({
      stdout,
      stderr: "",
      exitCode,
    });
  });

  it("still searches through the last line and handles no match", async () => {
    const bash = new Bash({
      files: { "/a": `${"other\n".repeat(100)}match\n`, "/b": "other\n" },
    });
    expect(await bash.exec("rg -l match /a /b")).toMatchObject({
      stdout: "/a\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.exec("rg --files-without-match match /a /b")).toMatchObject({
      stdout: "/b\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.exec("rg -l -m0 match /a")).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 1,
    });
    expect(await bash.exec("rg -c match /a")).toMatchObject({
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
