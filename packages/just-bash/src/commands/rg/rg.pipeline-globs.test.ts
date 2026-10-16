import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("rg pipeline output and brace globs", () => {
  it("omits line numbers in pipelines unless -n is requested", async () => {
    const result = await new Bash().exec(
      "printf 'a\\nb\\n' | rg b; printf 'a\\nb\\n' | rg -n b",
    );
    expect(result).toMatchObject({
      stdout: "b\n2:b\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("matches brace alternatives and keeps later exclusions", async () => {
    const bash = new Bash({
      cwd: "/w",
      files: {
        "/w/b.cls": "class B\n",
        "/w/c.xml": "<x/>\n",
        "/w/d.txt": "text\n",
      },
    });
    const result = await bash.exec(
      "rg -l -g '*.{cls,xml}' -g '!*.xml' .; rg --files -g '*.{cls,xml}' | rg cls",
    );
    expect(result).toMatchObject({
      stdout: "b.cls\nb.cls\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
