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
});
