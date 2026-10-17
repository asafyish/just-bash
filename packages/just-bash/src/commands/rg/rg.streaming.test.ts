import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { defineCommand } from "../../custom-commands.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";

const files = {
  "/src/a": "hello שלום\nother\nhello again\n",
  "/src/sub/b": "hello world\n",
  "/src/miss": "other\n",
};

describe("rg streaming pipelines", () => {
  it("stops discovery and reading after head closes its pipe", async () => {
    const fs = new InMemoryFs({
      ...files,
      "/src/a": "hello שלום\n".repeat(10000),
    });
    const read = fs.readFileBuffer.bind(fs);
    const readPaths: string[] = [];
    fs.readFileBuffer = async (path) => {
      readPaths.push(path);
      return read(path);
    };
    const readdir = fs.readdirWithFileTypes.bind(fs);
    const directories: string[] = [];
    fs.readdirWithFileTypes = async (path) => {
      directories.push(path);
      return readdir(path);
    };
    const result = await new Bash({ fs }).exec("rg -n hello /src | head -n 1");
    expect(result).toMatchObject({
      stdout: "/src/a:1:hello שלום\n",
      stderr: "",
      exitCode: 0,
    });
    expect(readPaths).not.toContain("/src/sub/b");
    expect(directories).not.toContain("/src/sub");
  });

  it.each([
    "rg -n hello /src",
    "rg --heading hello /src",
    "rg -l hello /src",
    "rg --files-without-match hello /src",
    "rg --files-without-match -q hello /src",
    "rg -c --include-zero hello /src",
    "rg -A 1 hello /src",
    "rg -o hello /src",
    "rg -n hello /src/a",
    "rg --sort path hello /src",
    "rg --json hello /src",
    "rg --stats hello /src",
    "rg hello /missing",
    "rg --files /src",
    "rg hello /src/a /missing",
    "rg -g '*.js' hello /src/a",
  ])("preserves output and status: %s", async (command) => {
    const bash = new Bash({ files });
    const buffered = await bash.exec(command);
    const streamed = await bash.exec(`set -o pipefail; ${command} | cat`);
    expect(streamed).toMatchObject({
      stdout: buffered.stdout,
      stderr: buffered.stderr,
      exitCode: buffered.exitCode,
    });
  });

  it("preserves global path ordering while descending directories lazily", async () => {
    const bash = new Bash({
      files: {
        "/src/a/file": "hit\n",
        "/src/a.txt": "hit\n",
        "/src/a-/file": "hit\n",
        "/src/z": "hit\n",
      },
    });
    expect(await bash.exec("rg --no-line-number hit /src | cat")).toMatchObject(
      {
        stdout:
          "/src/a-/file:hit\n/src/a.txt:hit\n/src/a/file:hit\n/src/z:hit\n",
        stderr: "",
        exitCode: 0,
      },
    );
  });

  it("reads piped data and stdin pattern files through a custom command wrapper", async () => {
    const rg = defineCommand(
      "rg",
      async (args, ctx) => {
        if (!ctx.origCommand) throw new Error("Expected original rg");
        return ctx.origCommand(args);
      },
      { streaming: true },
    );
    const bash = new Bash({ files, customCommands: [rg] });
    expect(
      await bash.exec("seq 3 | rg --no-line-number 2 | cat"),
    ).toMatchObject({
      stdout: "2\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.exec("seq 3 | rg -f - /src/a | cat")).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.exec("rg -n hello /src | head -n 1")).toMatchObject({
      stdout: "/src/a:1:hello שלום\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("distinguishes a producer from an empty upstream pipe", async () => {
    const contexts: boolean[] = [];
    const rg = defineCommand(
      "rg",
      async (args, ctx) => {
        contexts.push(ctx.stdio?.hasInput ?? false);
        if (!ctx.origCommand) throw new Error("Expected original rg");
        return ctx.origCommand(args);
      },
      { streaming: true },
    );
    const bash = new Bash({
      files: { "/src/a": "needle file\n" },
      cwd: "/src",
      customCommands: [rg],
    });
    expect(
      await bash.exec("rg --no-line-number needle | head -n 1"),
    ).toMatchObject({ stdout: "a:needle file\n", stderr: "", exitCode: 0 });
    expect(
      await bash.exec("set -o pipefail; seq 0 | rg needle | cat"),
    ).toMatchObject({ stdout: "", stderr: "", exitCode: 1 });
    expect(contexts).toEqual([false, true]);
  });
});
