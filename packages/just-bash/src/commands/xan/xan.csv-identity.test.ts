import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("xan CSV cell identity", () => {
  const files = {
    "/codes.csv": "id,amount,flag\n00123,02.50,TRUE\n123,10,false\n",
    "/lookup.csv": "id,label\n00123,match\n",
  };
  it.each([
    ["xan select id,amount,flag /codes.csv", files["/codes.csv"]],
    [
      "xan join id /codes.csv id /lookup.csv",
      "id,amount,flag,label\n00123,02.50,TRUE,match\n",
    ],
    [
      "xan filter 'amount < 5' /codes.csv",
      "id,amount,flag\n00123,02.50,TRUE\n",
    ],
    [
      `xan filter 'id eq "00123"' /codes.csv`,
      "id,amount,flag\n00123,02.50,TRUE\n",
    ],
    [
      "xan map 'amount + 1 as total' /codes.csv",
      "id,amount,flag,total\n00123,02.50,TRUE,3.5\n123,10,false,11\n",
    ],
    ["xan agg 'sum(amount) as total' /codes.csv", "total\n12.5\n"],
    ["xan dedup -s id /codes.csv", files["/codes.csv"]],
  ])("preserves source cells with %s", async (command, stdout) => {
    const result = await new Bash({ files }).exec(command);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
  it("preserves explicitly selected JSON string columns", async () => {
    const result = await new Bash({ files }).exec(
      "xan to json --strings id,flag /codes.csv",
    );
    expect(result.stdout).toBe(
      `${JSON.stringify(
        [
          { id: "00123", amount: 2.5, flag: "TRUE" },
          { id: "123", amount: 10, flag: "false" },
        ],
        null,
        2,
      )}\n`,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
