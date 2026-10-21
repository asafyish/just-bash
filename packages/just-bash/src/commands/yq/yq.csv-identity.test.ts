import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("yq CSV auto parsing", () => {
  it.each([
    "false",
    "f",
  ])("preserves cells with --csv-auto-parse=%s", async (value) => {
    const bash = new Bash({
      files: { "/data.csv": "code,n,flag,empty\n01,2,TRUE,\n" },
    });
    const result = await bash.exec(
      `yq -p csv -o json -c --csv-auto-parse=${value} '.' /data.csv`,
    );
    expect(result.stdout).toBe(
      '[{"code":"01","n":"2","flag":"TRUE","empty":""}]\n',
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
  it("retains default type inference", async () => {
    const result = await new Bash({
      files: { "/data.csv": "code,n,flag\n01,2,true\n" },
    }).exec("yq -p csv -o json -c '.' /data.csv");
    expect(result.stdout).toBe('[{"code":1,"n":2,"flag":true}]\n');
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
