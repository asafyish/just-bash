import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("jq filter files", () => {
  it.each([
    "-r -f filter.jq",
    "-r --from-file filter.jq",
    "-r --from-file=filter.jq",
    "-rf filter.jq",
    "-rffilter.jq",
  ])("loads the filter through %s", async (options) => {
    const bash = new Bash({
      cwd: "/data",
      files: {
        "/data/filter.jq": '# UTF-8 filter\n.value + " café"\n',
        "/data/input.json": '{"value":"hello"}',
      },
    });
    const result = await bash.exec(`jq ${options} input.json`);
    expect(result.stdout).toBe("hello café\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("uses stdin as data rather than as the filter", async () => {
    const bash = new Bash({ files: { "/filter.jq": ". + $increment" } });
    const result = await bash.exec(
      "echo 7 | jq --argjson increment 2 -f /filter.jq",
    );
    expect(result.stdout).toBe("9\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("reports a missing filter file as a file error", async () => {
    const result = await new Bash().exec("jq -n -f missing.jq");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("jq: missing.jq: No such file or directory\n");
    expect(result.exitCode).toBe(2);
  });

  it("requires a filename", async () => {
    const result = await new Bash().exec("jq -f");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "jq: --from-file takes one parameter (a filename)\n",
    );
    expect(result.exitCode).toBe(2);
  });
});
