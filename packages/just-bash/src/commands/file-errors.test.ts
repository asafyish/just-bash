import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";

class ReadOnlyFs extends InMemoryFs {
  override async writeFile(): Promise<void> {
    throw Object.assign(new Error("host path must not be printed"), {
      code: "EROFS",
    });
  }
}

describe("file error messages", () => {
  it("preserves nl's virtual operand in missing-file errors", async () => {
    const result = await new Bash().exec("nl /tmp/t/missing.txt");
    expect(result).toMatchObject({
      stdout: "",
      stderr: "nl: /tmp/t/missing.txt: No such file or directory\n",
      exitCode: 1,
    });
  });

  it.each([
    ["tee /ro/f.txt <<< hi", "tee", "hi\n"],
    ["sed -i 's/x/y/' /ro/f.txt", "sed", ""],
  ])("reports write refusal for %s", async (script, command, stdout) => {
    const fs = new ReadOnlyFs({ "/ro/f.txt": "x\n" });
    const result = await new Bash({ fs }).exec(script);
    expect(result).toMatchObject({
      stdout,
      stderr: `${command}: /ro/f.txt: Read-only file system\n`,
      exitCode: 1,
    });
    expect(await fs.readFile("/ro/f.txt")).toBe("x\n");
  });
});
