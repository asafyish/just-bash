import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("rg incremental file matching", () => {
  it("does not match the rest of a file after head closes", async () => {
    const bash = new Bash({
      files: { "/in": "match\n".repeat(10000) },
      executionLimits: { maxLoopIterations: 1000 },
    });
    expect(await bash.exec("rg -n match /in | head -n 1")).toMatchObject({
      stdout: "1:match\n",
      stderr: "",
      exitCode: 0,
    });
  });
  it("observes downstream closure through a long nonmatching tail", async () => {
    const bash = new Bash({
      files: { "/in": `needle\n${"other\n".repeat(10000)}` },
      executionLimits: { maxLoopIterations: 1000 },
    });
    expect(await bash.exec("rg -n needle /in | head -n 1")).toMatchObject({
      stdout: "1:needle\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves complete and prefix results for concurrent Unicode and regex searches", async () => {
    const files = {
      "/a": `${"match שלום 😀\nſap Key İ\n\nMATCH é\r\n".repeat(300)}last`,
      "/b": `${"other\n".repeat(300)}match\n`,
    };
    const patterns = [
      "-n match",
      "-ni 'sap|key'",
      "-nv match",
      "-n '^$|שלום'",
      "-n 'm.tch'",
      "-ni 'i|k'",
      "-n last",
      "-n missing",
    ];
    const expected = await Promise.all(
      patterns.map((flags) => new Bash({ files }).exec(`rg ${flags} /a /b`)),
    );
    await Promise.all(
      Array.from({ length: 16 }, async (_, lane) => {
        const index = lane % patterns.length;
        const prefix = lane >= patterns.length;
        const result = await new Bash({ files }).exec(
          `rg ${patterns[index]} /a /b | ${prefix ? "head -n 1" : "cat"}`,
        );
        const full = expected[index];
        expect(full.stderr).toBe("");
        expect(result).toMatchObject({
          stdout:
            prefix && full.stdout
              ? full.stdout.slice(0, full.stdout.indexOf("\n") + 1)
              : full.stdout,
          stderr: "",
          exitCode: 0,
        });
      }),
    );
  });

  it("cancels a long nonmatching scan while another search completes", async () => {
    const controller = new AbortController();
    const bash = new Bash({
      files: { "/in": "nothing\n".repeat(500000) },
      defenseInDepth: false,
      executionLimits: {
        maxArrayElements: 1000000,
        maxLoopIterations: 2000000,
      },
    });
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      const [cancelled, complete] = await Promise.all([
        bash.exec("set -o pipefail; rg '^.*[zZ]$' /in | cat", {
          signal: controller.signal,
        }),
        new Bash({
          files: { "/in": "needle שלום\n" },
          defenseInDepth: false,
        }).exec("rg needle /in | cat"),
      ]);
      expect(cancelled.exitCode).toBe(124);
      expect(complete).toMatchObject({
        stdout: "needle שלום\n",
        stderr: "",
        exitCode: 0,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  it.each([
    "-n",
    "-nv",
    "-n -i",
    "-n -e '^$' -e match",
  ])("preserves complete output for %s", async (flags) => {
    const files = { "/a": "match\n\nMATCH é\r\nlast", "/b": "\nmatch\n" };
    const expected = await new Bash({ files }).exec(`rg ${flags} match /a /b`);
    const actual = await new Bash({ files }).exec(
      `set -o pipefail; rg ${flags} match /a /b | cat`,
    );
    expect(actual).toMatchObject({
      stdout: expected.stdout,
      stderr: expected.stderr,
      exitCode: expected.exitCode,
    });
  });

  it("fully consumes a file past the periodic yield with defense enabled", async () => {
    const bash = new Bash({ files: { "/in": "match\n".repeat(80) } });
    expect(
      await bash.exec("rg --no-line-number match /in | cat"),
    ).toMatchObject({
      stdout: "match\n".repeat(80),
      stderr: "",
      exitCode: 0,
    });
  });
});
