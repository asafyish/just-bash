import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { encodeUtf8ToBytes } from "../encoding.js";

describe("streaming pipeline stderr redirection", () => {
  it("keeps downstream early termination with stderr redirected", async () => {
    const bash = new Bash({ executionLimits: { maxOutputSize: 32 } });
    expect(
      await bash.exec("seq 1000000 2>/dev/null | head -n 1"),
    ).toMatchObject({
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it.each([">", ">>", ">|"])("routes stderr with 2%s", async (operator) => {
    const producer = defineCommand(
      "producer",
      async (_args, ctx) => {
        if (!ctx.stdio) throw new Error("Expected streaming I/O");
        await ctx.stdio.write(encodeUtf8ToBytes("result\n"));
        return { stdout: "", stderr: "warning\n", exitCode: 7 };
      },
      { streaming: true },
    );
    const bash = new Bash({
      files: { "/err": "previous\n" },
      customCommands: [producer],
    });
    expect(
      await bash.exec(`set -o pipefail; producer 2${operator}/err | cat`),
    ).toMatchObject({
      stdout: "result\n",
      stderr: "",
      exitCode: 7,
    });
    expect(await bash.fs.readFile("/err")).toBe(
      operator === ">>" ? "previous\nwarning\n" : "warning\n",
    );
  });
});
