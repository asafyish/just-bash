import { describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";

describe("jq per-input pipeline output", () => {
  it("stops reading later batches when head closes", async () => {
    const fs = new InMemoryFs(
      Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [`/f${i}.json`, `{"id":${i}}`]),
      ),
    );
    const reads = vi.spyOn(fs, "readFileBuffer");
    const bash = new Bash({ fs });
    const result = await bash.exec(
      `jq -r .id ${Array.from({ length: 1000 }, (_, i) => `/f${i}.json`).join(" ")} | head -n 1`,
    );
    expect(result).toMatchObject({ stdout: "0\n", stderr: "", exitCode: 0 });
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(reads.mock.calls.length).toBeLessThan(1000);
  });

  it.each([
    "-r .id",
    "-cs .",
    "-R .",
    "-Rs .",
    "-j .id",
    "-n 42",
  ])("preserves all results for %s", async (filter) => {
    const files = { "/a": '{"id":"é"}\n{"id":2}\n', "/b": '{"id":3}\n' };
    const expected = await new Bash({ files }).exec(`jq ${filter} /a /b`);
    expect(
      await new Bash({ files }).exec(
        `set -o pipefail; jq ${filter} /a /b | cat`,
      ),
    ).toMatchObject({
      stdout: expected.stdout,
      stderr: expected.stderr,
      exitCode: expected.exitCode,
    });
  });
  it("reads piped stdin and preserves file failures", async () => {
    expect(await new Bash().exec("seq 3 | jq -c . | cat")).toMatchObject({
      stdout: "1\n2\n3\n",
      stderr: "",
      exitCode: 0,
    });
    expect(
      await new Bash().exec("set -o pipefail; jq . /missing | cat"),
    ).toMatchObject({
      stdout: "",
      stderr: "jq: /missing: No such file or directory\n",
      exitCode: 2,
    });
  });
});
