import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("rg empty path operands", () => {
  const createBash = () =>
    new Bash({
      cwd: "/data",
      files: { "/data/visible.txt": "needle\n" },
    });

  it.each([
    'rg -n needle ""',
    'rg --files ""',
  ])("reports an empty filename instead of searching cwd: %s", async (command) => {
    const result = await createBash().exec(command);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("rg: : Unable to access path\n");
    expect(result.exitCode).toBe(2);
  });

  it("continues searching other explicit operands after an empty filename", async () => {
    const result = await createBash().exec('rg -n needle "" visible.txt');
    expect(result.stdout).toBe("visible.txt:1:needle\n");
    expect(result.stderr).toBe("rg: : Unable to access path\n");
    expect(result.exitCode).toBe(2);
  });
});
