import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("sed GNU forms", () => {
  it("keeps the original contents in an in-place backup", async () => {
    const bash = new Bash({ files: { "/s.txt": "a\nb\n" } });
    const result = await bash.exec("sed -i.bak 's/a/A/' /s.txt");
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(await bash.fs.readFile("/s.txt")).toBe("A\nb\n");
    expect(await bash.fs.readFile("/s.txt.bak")).toBe("a\nb\n");
  });

  it("consumes the backslash before same-line a/i/c text", async () => {
    const result = await new Bash().exec(
      "printf 'one\\ntwo\\n' | sed -e '1a\\added' -e '2i\\inserted' -e '2c\\changed'",
    );
    expect(result).toMatchObject({
      stdout: "one\nadded\ninserted\nchanged\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("applies case conversion to literals, matches and backreferences", async () => {
    const result = await new Bash().exec(
      String.raw`echo 'hello hello' | sed 's/\(hello\)/\U&-\1\Etail/g'`,
    );
    expect(result).toMatchObject({
      stdout: "HELLO-HELLOtail HELLO-HELLOtail\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
