import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("awk parenthesized concatenation", () => {
  it.each([
    " ",
    "\t",
    " \\\n",
  ])("concatenates a variable and parentheses separated by %j", async (separator) => {
    const bash = new Bash();
    const result = await bash.exec(
      `awk 'BEGIN { a[1]="x"; a[2]="y"; s=""; for(i=1;i<=2;i++) s=s${separator}((a[i]=="x")?"T":"F"); print "s="s }'`,
    );
    expect(result.stdout).toBe("s=TF\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("preserves adjacent user calls and whitespace before built-in calls", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      `awk 'function twice(x) { return x*2 } BEGIN { print twice(3), length ("abc"), substr ("abc",2) }'`,
    );
    expect(result.stdout).toBe("6 3 bc\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
