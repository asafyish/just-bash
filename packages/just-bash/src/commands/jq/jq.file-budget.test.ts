import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

const input = JSON.stringify("x".repeat(98));

describe("jq file input budgets", () => {
  it("charges file operands and argument files to the aggregate input budget", async () => {
    for (const command of [
      "jq empty /a /b",
      "jq -n --rawfile a /a --rawfile b /b empty",
      "jq -n --slurpfile a /a --slurpfile b /b empty",
    ]) {
      const bash = new Bash({
        files: { "/a": input, "/b": input },
        executionLimits: { maxInputBytes: 150 },
      });
      const result = await bash.exec(command);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "bash: jq: aggregate input size limit exceeded (150 bytes)\n",
      );
      expect(result.exitCode).toBe(126);
    }
  });

  it("reserves retained file text across the input batch", async () => {
    const bash = new Bash({
      files: { "/a": input, "/b": input },
      executionLimits: { maxLiveBytes: 300 },
    });
    const result = await bash.exec("jq empty /a /b");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "bash: jq: live byte limit exceeded (300 bytes)\n",
    );
    expect(result.exitCode).toBe(126);
  });

  it("releases file reservations after file errors and successful commands", async () => {
    const bash = new Bash({
      files: { "/a": input },
      executionLimits: { maxLiveBytes: 300 },
    });
    const result = await bash.exec(
      "jq empty /missing /a; jq empty /a; jq empty /a",
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("jq: /missing: No such file or directory\n");
    expect(result.exitCode).toBe(0);
  });

  it("releases streamed batches but retains collected input", async () => {
    const files = Array.from({ length: 101 }, () => "/a").join(" ");
    for (const [args, exitCode] of [
      ["empty", 0],
      ["-s empty", 126],
      ["-n 'inputs | empty'", 126],
      ["-R empty", 126],
    ] as const) {
      const bash = new Bash({
        files: { "/a": input },
        executionLimits: { maxLiveBytes: 10200 },
      });
      const result = await bash.exec(`jq ${args} ${files}`);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(exitCode);
      expect(result.stderr).toBe(
        exitCode === 0
          ? ""
          : "bash: jq: live byte limit exceeded (10200 bytes)\n",
      );
    }
  });
});
