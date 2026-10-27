import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("xargs argument files", () => {
  it.each([
    "-a args",
    "-aargs",
    "--arg-file args",
    "--arg-file=args",
  ])("reads arguments with %s", async (flag) => {
    const bash = new Bash({
      cwd: "/work",
      files: { "/work/args": "café\n東京\n" },
    });
    const result = await bash.exec(`printf ignored | xargs ${flag} -n 1 echo`);
    expect(result).toMatchObject({
      stdout: "café\n東京\n",
      stderr: "",
      exitCode: 0,
    });
  });
  it("preserves standard input for the invoked command", async () => {
    const bash = new Bash({ files: { "/args": "-\n" } });
    const result = await bash.exec(
      "printf 'café payload' | xargs -a /args cat",
    );
    expect(result).toMatchObject({
      stdout: "café payload",
      stderr: "",
      exitCode: 0,
    });
  });
  it("uses the existing null-delimited parser", async () => {
    const bash = new Bash({ files: { "/args": "a b\0c\0" } });
    const result = await bash.exec("xargs -0 -a /args -n 1 echo");
    expect(result).toMatchObject({
      stdout: "a b\nc\n",
      stderr: "",
      exitCode: 0,
    });
  });
  it("reports a missing argument file", async () => {
    const result = await new Bash().exec("xargs -a /missing echo");
    expect(result).toMatchObject({
      stdout: "",
      stderr:
        "xargs: /missing: ENOENT: no such file or directory, open '/missing'\n",
      exitCode: 1,
    });
  });
  it.each([
    "-a",
    "--arg-file",
  ])("reports a missing operand for %s", async (flag) => {
    const result = await new Bash().exec(`xargs ${flag}`);
    expect(result).toMatchObject({
      stdout: "",
      stderr: `xargs: option '${flag}' requires an argument\n`,
      exitCode: 1,
    });
  });
});
