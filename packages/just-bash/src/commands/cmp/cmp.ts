import { BoundedStringBuilder } from "../../bounded-builder.js";
import { latin1FromBytes, readBytesFrom } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { getErrorCode } from "../../interpreter/helpers/errors.js";
import type { RuntimeCommand } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { accountFileInput } from "../../utils/file-reader.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";
import { hasHelpFlag, showHelp } from "../help.js";

const help = {
  name: "cmp",
  summary: "compare two files byte by byte",
  usage: "cmp [OPTION]... FILE1 [FILE2]",
  options: [
    "-s, --silent, --quiet  suppress output; report differences by exit status",
    "-l, --verbose          list differing byte positions and octal values",
    "    --help             display this help and exit",
  ],
  description:
    "FILE2 defaults to standard input. Use - for standard input. Exit status: 0 identical, 1 different, 2 trouble.",
};

export const cmpCommand: RuntimeCommand = {
  name: "cmp",
  async execute(args, ctx) {
    if (hasHelpFlag(args)) return showHelp(help);
    const parsed = parseArgs("cmp", args, {
      silent: { short: "s", long: "silent", type: "boolean" },
      quiet: { long: "quiet", type: "boolean" },
      verbose: { short: "l", long: "verbose", type: "boolean" },
    });
    if (!parsed.ok) return { ...parsed.error, exitCode: 2 };
    const { positional: files, flags } = parsed.result;
    if (files.length < 1 || files.length > 2) {
      return {
        stdout: "",
        stderr: "cmp: expected one or two file operands\n",
        exitCode: 2,
      };
    }
    if (files.length === 1) files.push("-");
    const silent = flags.silent || flags.quiet;
    const contents: string[] = [];
    for (const file of files) {
      try {
        if (file === "-") contents.push(latin1FromBytes(ctx.stdin));
        else {
          const path = ctx.fs.resolvePath(ctx.cwd, file);
          const stat = await ctx.fs.stat(path);
          if (stat.isDirectory) throw new Error("EISDIR");
          accountFileInput(ctx, stat.size, "cmp");
          contents.push(latin1FromBytes(await readBytesFrom(ctx.fs, path)));
        }
      } catch (error) {
        rethrowFatalExecutionError(error);
        const code = getErrorCode(error);
        const reason =
          code === "ENOENT"
            ? "No such file or directory"
            : code === "EISDIR"
              ? "Is a directory"
              : code === "EACCES" || code === "EPERM"
                ? "Permission denied"
                : "Unable to read file";
        return {
          stdout: "",
          stderr: silent ? "" : `cmp: ${file}: ${reason}\n`,
          exitCode: 2,
        };
      }
    }
    const [a, b] = contents;
    const length = Math.min(a.length, b.length);
    ctx.executionScope?.consumeWork(length, "cmp");
    const output = new BoundedStringBuilder(
      Math.min(ctx.limits.maxOutputSize, ctx.limits.maxStringLength),
      "cmp",
    );
    let line = 1;
    let different = false;
    for (let i = 0; i < length; i++) {
      const left = a.charCodeAt(i);
      const right = b.charCodeAt(i);
      if (left !== right) {
        if (silent) return { stdout: "", stderr: "", exitCode: 1 };
        if (!flags.verbose)
          return {
            stdout: `${files[0]} ${files[1]} differ: byte ${i + 1}, line ${line}\n`,
            stderr: "",
            exitCode: 1,
          };
        output.append(
          `${i + 1} ${left.toString(8).padStart(3)} ${right.toString(8).padStart(3)}\n`,
        );
        different = true;
      }
      if (left === 10) line++;
    }
    let stderr = "";
    if (a.length !== b.length) {
      different = true;
      const shorter = files[a.length < b.length ? 0 : 1];
      if (!silent)
        stderr = `cmp: EOF on ${shorter}${length === 0 ? " which is empty" : ` after byte ${length}${flags.verbose ? "" : `, in line ${line}`}`}\n`;
    }
    return { stdout: output.build(), stderr, exitCode: different ? 1 : 0 };
  },
};

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "cmp",
  flags: [
    { flag: "-s", type: "boolean" },
    { flag: "-l", type: "boolean" },
  ],
  stdinType: "text",
  needsFiles: true,
};
