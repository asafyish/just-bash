import {
  type ByteString,
  decodeBytesToUtf8,
  encodeUtf8ToBytes,
} from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { readBatch } from "../../fs/read-many.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { UserRegex } from "../../regex/index.js";
import { BrokenPipeError } from "../../streams/byte-pipe.js";
import { readCommandStdin } from "../../streams/command-stdio.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { describeFsError } from "../../utils/fs-error.js";
import { matchGlob } from "../../utils/glob.js";
import { showHelp, unknownOption } from "../help.js";
import { getCandidates } from "../search-engine/file-batch.js";
import {
  buildRegex,
  type PreFilter,
  type RegexMode,
  searchContent,
} from "../search-engine/index.js";

/**
 * The name GNU grep prints for the `-` operand. It appears wherever a real
 * file name would: the multi-file `file:line` prefix, `-l`/`-L` listings and
 * `-c` counts.
 */
const STDIN_FILENAME = "(standard input)";

/** File entry with optional type info from glob expansion */
interface FileEntry {
  path: string;
  error?: string;
  isFile?: boolean; // undefined means we need to stat
  /** True for the `-` operand, which names standard input instead of a file. */
  isStdin?: boolean;
  /**
   * True when an earlier `-` already drained stdin. stdin is a stream, so the
   * second `-` of `grep pat - -` reads EOF and contributes nothing.
   */
  stdinAtEof?: boolean;
}

type FileInput =
  | { path: string }
  | { content: string }
  | { error: string }
  | null;

interface GrepTraversalBudget {
  operations: number;
  results: number;
  maxOperations: number;
  maxResults: number;
}

function getMatcherWorkLimit(ctx: RuntimeCommandContext): number {
  const loopLimit = ctx.limits.maxLoopIterations;
  const arrayLimit = ctx.limits.maxArrayElements;
  return Math.max(loopLimit, Math.min(arrayLimit, loopLimit * 10));
}

function useTraversalOperation(budget: GrepTraversalBudget): void {
  if (++budget.operations > budget.maxOperations) {
    throw new ExecutionLimitError(
      `grep: glob operation limit exceeded (${budget.maxOperations})`,
      "glob_operations",
    );
  }
}

function addTraversalResult(budget: GrepTraversalBudget): void {
  if (budget.results >= budget.maxResults) {
    throw new ExecutionLimitError(
      `grep: array element limit exceeded (${budget.maxResults})`,
      "array_elements",
    );
  }
  budget.results++;
}

/**
 * A regex that can never match anything, used when the pattern list is empty
 * (e.g. `grep -f /dev/null`). `[^\s\S]` is the empty character class: no
 * codepoint is both non-whitespace and non-non-whitespace. Wrapping it for
 * -w (`\b(?:...)\b`) or -x (`^(?:...)$`) keeps it unmatchable.
 */
const NEVER_MATCHES = "[^\\s\\S]";

/**
 * Split a `-e`/positional PATTERNS operand into individual patterns.
 *
 * GNU grep documents PATTERNS as "one or more patterns separated by newline
 * characters", so a trailing newline yields a trailing empty pattern (which
 * matches every line). Verified against GNU grep 3.12:
 *   grep -e $'cherry\n' FILE   # prints every line
 */
function splitPatternOperand(value: string): string[] {
  return value.split("\n");
}

/**
 * Split the contents of a `-f FILE` pattern file into individual patterns.
 *
 * Unlike `-e`, the final newline of a pattern file is a terminator rather than
 * a separator, so it does not produce a trailing empty pattern. An empty file
 * contributes no patterns at all. Interior empty lines are kept: an empty
 * pattern matches every line. Verified against GNU grep 3.12.
 */
function splitPatternFile(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * OR-combine several patterns into one regex source.
 *
 * A single pattern is returned untouched so the common case keeps its original
 * mode (and the literal pre-filter fast path). Multiple fixed strings are
 * escaped and lifted into an extended regex, since POSIX BRE/ERE have no way to
 * express "any of these literals" without escaping first.
 */
function combinePatterns(
  patterns: string[],
  mode: RegexMode,
): { pattern: string; mode: RegexMode } {
  if (patterns.length === 1) {
    return { pattern: patterns[0], mode };
  }
  if (mode === "fixed") {
    return {
      pattern: patterns
        .map((p) => `(?:${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`)
        .join("|"),
      mode: "extended",
    };
  }
  if (mode === "basic") {
    // BRE spells alternation `\|`; escapeRegexForBasicGrep turns it into `|`.
    return { pattern: patterns.join("\\|"), mode };
  }
  return { pattern: patterns.map((p) => `(?:${p})`).join("|"), mode };
}

const valueOptions = new Map([
  ["--regexp", "e"],
  ["--file", "f"],
  ["--max-count", "m"],
  ["--after-context", "A"],
  ["--before-context", "B"],
  ["--context", "C"],
  ["--include", "include"],
  ["--exclude", "exclude"],
  ["--exclude-dir", "exclude-dir"],
  ["--binary-files", "binary-files"],
]);

const grepHelp = {
  name: "grep",
  summary: "print lines that match patterns",
  usage: "grep [OPTION]... PATTERN [FILE]...",
  description: [
    "Search for PATTERN in each FILE.",
    "With no FILE, or when FILE is -, read standard input.",
  ],
  options: [
    "-E, --extended-regexp    PATTERN is an extended regular expression",
    "-P, --perl-regexp        PATTERN is a Perl regular expression",
    "-F, --fixed-strings      PATTERN is a set of newline-separated strings",
    "-i, --ignore-case        ignore case distinctions",
    "-v, --invert-match       select non-matching lines",
    "-w, --word-regexp        match only whole words",
    "-x, --line-regexp        match only whole lines",
    "-c, --count              print only a count of matching lines",
    "-l, --files-with-matches print only names of files with matches",
    "-L, --files-without-match print names of files with no matches",
    "-m NUM, --max-count=NUM  stop after NUM matches",
    "-n, --line-number        print line number with output lines",
    "-H, --with-filename      print the file name with output lines",
    "-s, --no-messages        suppress file error messages",
    "-I                      skip binary files",
    "-a, --text              process binary files as text",
    "-Z, --null              terminate file names with a NUL byte",
    "    --binary-files=TYPE  binary, text, or without-match",
    "    --color[=WHEN]       accept color selection; output is plain text",
    "    --line-buffered      accepted; output is returned as a string",
    "-h, --no-filename        suppress the file name prefix on output",
    "-o, --only-matching      show only nonempty parts of lines that match",
    "-q, --quiet, --silent    suppress all normal output",
    "-r, --recursive          recurse; follow operand symlinks only",
    "-R, --dereference-recursive  recurse and follow all symlinks",
    "-A NUM                   print NUM lines of trailing context",
    "-B NUM                   print NUM lines of leading context",
    "-C NUM                   print NUM lines of context",
    "-e PATTERN               use PATTERN for matching",
    "-f FILE, --file=FILE     obtain patterns from FILE, one per line",
    "    --include=GLOB       search only files matching GLOB",
    "    --exclude=GLOB       skip files matching GLOB",
    "    --exclude-dir=DIR    skip directories matching DIR",
    "    --help               display this help and exit",
  ],
};

export const grepCommand: RuntimeCommand = {
  name: "grep",
  streaming: true,

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    let ignoreCase = false;
    let showLineNumbers = false;
    let invertMatch = false;
    let countOnly = false;
    let filesWithMatches = false;
    let filesWithoutMatch = false;
    let recursive = false;
    let followSymlinks = false;
    let wholeWord = false;
    let lineRegexp = false;
    let extendedRegex = false;
    let perlRegex = false;
    let fixedStrings = false;
    let onlyMatching = false;
    let noFilename = false;
    let withFilename = false;
    let noMessages = false;
    let nullFilename = false;
    let binaryMode: "binary" | "text" | "without-match" = "binary";
    let quietMode = false;
    let maxCount = 0; // 0 means unlimited
    let beforeContext = 0;
    let afterContext = 0;
    const includePatterns: string[] = [];
    const excludePatterns: string[] = [];
    const excludeDirPatterns: string[] = [];
    let patterns: string[] = [];
    /** Paths given to -f/--file, in argument order. "-" means stdin. */
    const patternFiles: string[] = [];
    const operands: string[] = [];
    let parseOptions = true;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (parseOptions && arg === "--") {
        parseOptions = false;
        continue;
      }

      if (parseOptions && arg === "--help") {
        return showHelp(grepHelp);
      }

      if (parseOptions && arg.startsWith("-") && arg !== "-") {
        const equals = arg.indexOf("=");
        const option = equals >= 0 ? arg.slice(0, equals) : arg;
        const flags = arg.startsWith("--") ? [option] : arg.slice(1).split("");

        for (let f = 0; f < flags.length; f++) {
          const flag = flags[f];
          const valueOption =
            valueOptions.get(flag) ??
            ("efmABC".includes(flag) && flag.length === 1 ? flag : undefined);
          if (valueOption) {
            let value = flag.startsWith("--")
              ? equals >= 0
                ? arg.slice(equals + 1)
                : undefined
              : flags.slice(f + 1).join("") || undefined;
            if (value === undefined) value = args[++i];
            if (value === undefined) {
              return {
                stdout: "",
                stderr: flag.startsWith("--")
                  ? `grep: option '${flag}' requires an argument\n`
                  : `grep: option requires an argument -- '${flag}'\n`,
                exitCode: 2,
              };
            }
            if (valueOption === "e") patterns.push(value);
            else if (valueOption === "f") patternFiles.push(value);
            else if (valueOption === "include") includePatterns.push(value);
            else if (valueOption === "exclude") excludePatterns.push(value);
            else if (valueOption === "exclude-dir")
              excludeDirPatterns.push(value);
            else if (valueOption === "binary-files") {
              if (
                value !== "binary" &&
                value !== "text" &&
                value !== "without-match"
              )
                return {
                  stdout: "",
                  stderr: `grep: unknown binary-files type: ${value}\n`,
                  exitCode: 2,
                };
              binaryMode = value;
            } else {
              const number = Number(value);
              if (
                (valueOption !== "m" || value !== "-1") &&
                (!/^\+?\d+$/.test(value) || !Number.isSafeInteger(number))
              ) {
                return {
                  stdout: "",
                  stderr: `grep: invalid ${valueOption === "m" ? "max count" : "context length"} argument: ${value}\n`,
                  exitCode: 2,
                };
              }
              if (valueOption === "m") maxCount = number === -1 ? 0 : number;
              if (valueOption === "A" || valueOption === "C")
                afterContext = number;
              if (valueOption === "B" || valueOption === "C")
                beforeContext = number;
            }
            break;
          }
          if (
            equals >= 0 &&
            flag.startsWith("--") &&
            flag !== "--color" &&
            flag !== "--colour"
          ) {
            return { ...unknownOption("grep", arg), exitCode: 2 };
          }
          if (flag === "i" || flag === "--ignore-case") ignoreCase = true;
          else if (flag === "n" || flag === "--line-number")
            showLineNumbers = true;
          else if (flag === "v" || flag === "--invert-match")
            invertMatch = true;
          else if (flag === "c" || flag === "--count") countOnly = true;
          else if (flag === "l" || flag === "--files-with-matches")
            filesWithMatches = true;
          else if (flag === "L" || flag === "--files-without-match")
            filesWithoutMatch = true;
          else if (
            flag === "r" ||
            flag === "R" ||
            flag === "--recursive" ||
            flag === "--dereference-recursive"
          ) {
            recursive = true;
            followSymlinks ||=
              flag === "R" || flag === "--dereference-recursive";
          } else if (flag === "w" || flag === "--word-regexp") wholeWord = true;
          else if (flag === "x" || flag === "--line-regexp") lineRegexp = true;
          else if (flag === "E" || flag === "--extended-regexp")
            extendedRegex = true;
          else if (flag === "P" || flag === "--perl-regexp") perlRegex = true;
          else if (flag === "F" || flag === "--fixed-strings")
            fixedStrings = true;
          else if (flag === "o" || flag === "--only-matching")
            onlyMatching = true;
          else if (flag === "h" || flag === "--no-filename") {
            noFilename = true;
            withFilename = false;
          } else if (flag === "H" || flag === "--with-filename") {
            withFilename = true;
            noFilename = false;
          } else if (flag === "s" || flag === "--no-messages")
            noMessages = true;
          else if (flag === "I") binaryMode = "without-match";
          else if (flag === "a" || flag === "--text") binaryMode = "text";
          else if (flag === "Z" || flag === "--null") nullFilename = true;
          else if (flag === "--line-buffered") {
            /* Output is returned as a string. */
          } else if (flag === "--color" || flag === "--colour") {
            if (
              equals >= 0 &&
              ![
                "always",
                "yes",
                "force",
                "auto",
                "tty",
                "if-tty",
                "never",
                "no",
                "none",
              ].includes(arg.slice(equals + 1).toLowerCase())
            )
              return {
                stdout: "",
                stderr: `grep: invalid argument '${arg.slice(equals + 1)}' for '${flag}'\n`,
                exitCode: 2,
              };
          } else if (flag === "q" || flag === "--quiet" || flag === "--silent")
            quietMode = true;
          else if (flag.startsWith("--")) {
            return { ...unknownOption("grep", flag), exitCode: 2 };
          } else if (flag.length === 1) {
            return { ...unknownOption("grep", `-${flag}`), exitCode: 2 };
          }
        }
      } else {
        operands.push(arg);
      }
    }

    // The first operand is the pattern only when no -e/-f pattern was given.
    if (patterns.length === 0 && patternFiles.length === 0) {
      const positionalPattern = operands.shift();
      if (positionalPattern === undefined) {
        return {
          stdout: "",
          stderr: "grep: missing pattern\n",
          exitCode: 2,
        };
      }
      patterns.push(positionalPattern);
    }

    // A pattern operand can hold several newline-separated patterns, so expand
    // every collected operand once before the -f files are appended.
    patterns = patterns.flatMap(splitPatternOperand);
    let stdin: Promise<ByteString> | undefined;
    const readStdin = () => {
      stdin ??= readCommandStdin(ctx);
      return stdin;
    };

    // Collect patterns: -e/positional first, then each -f file in order.
    // All of them OR-combine, exactly like GNU grep.
    /** True once `-f -` has drained stdin, so it can't also be searched. */
    let stdinUsedForPatterns = false;
    for (const patternFile of patternFiles) {
      let content: string;
      if (patternFile === "") {
        // `-f ""` / `--file=` never names a file; GNU reports the empty name
        // rather than resolving it relative to the working directory.
        return {
          stdout: "",
          stderr: "grep: : No such file or directory\n",
          exitCode: 2,
        };
      }
      if (patternFile === "-") {
        // stdin is a stream: the first `-f -` drains it, any later one reads
        // EOF and contributes nothing.
        content = stdinUsedForPatterns
          ? ""
          : decodeBytesToUtf8(await readStdin());
        stdinUsedForPatterns = true;
      } else {
        try {
          const path = ctx.fs.resolvePath(ctx.cwd, patternFile);
          const stat = await ctx.fs.stat(path);
          if (stat.isDirectory) {
            return {
              stdout: "",
              stderr: `grep: ${patternFile}: Is a directory\n`,
              exitCode: 2,
            };
          }
          content = await ctx.fs.readFile(path);
        } catch (error) {
          rethrowFatalExecutionError(error);
          return {
            stdout: "",
            stderr: `grep: ${patternFile}: No such file or directory\n`,
            exitCode: 2,
          };
        }
      }
      const filePatterns = splitPatternFile(content);
      if (patterns.length + filePatterns.length > ctx.limits.maxArrayElements) {
        throw new ExecutionLimitError(
          `grep: array element limit exceeded (${ctx.limits.maxArrayElements})`,
          "array_elements",
        );
      }
      patterns.push(...filePatterns);
    }

    // An empty pattern list (e.g. `grep -f /dev/null`) selects no lines at all.
    // GNU grep short-circuits: no output, no per-file counts, no "no such file"
    // diagnostics, exit 1. With -v every line is selected instead, and -L still
    // has to visit the files, so both keep the normal path with a regex that
    // can never match.
    if (patterns.length === 0 && !invertMatch && !filesWithoutMatch) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    const files = operands;
    if (recursive && files.length === 0) files.push("");

    // Build regex using shared search-engine
    const regexMode: RegexMode = fixedStrings
      ? "fixed"
      : extendedRegex
        ? "extended"
        : perlRegex
          ? "perl"
          : "basic";
    // GNU's PCRE backend cannot express an alternation of independent
    // patterns, so it refuses more than one under -P. Duplicates are folded
    // first, matching GNU: `-P -e apple -e apple` is accepted.
    if (regexMode === "perl" && new Set(patterns).size > 1) {
      return {
        stdout: "",
        stderr: "grep: the -P option only supports a single pattern\n",
        exitCode: 2,
      };
    }

    // Alternatives are concatenated textually, so a malformed pattern could
    // otherwise swallow the separator and silently absorb its neighbour
    // (`a\` + `banana` becoming the literal `a|banana`). Compile each pattern
    // on its own first so a syntax error is reported instead. Fixed strings
    // are escaped before joining and can never be malformed.
    if (patterns.length > 1 && regexMode !== "fixed") {
      for (const p of patterns) {
        try {
          buildRegex(p, { mode: regexMode });
        } catch {
          return {
            stdout: "",
            stderr: `grep: invalid regular expression: ${p}\n`,
            exitCode: 2,
          };
        }
      }
    }

    const combined =
      patterns.length === 0
        ? { pattern: NEVER_MATCHES, mode: "extended" as RegexMode }
        : combinePatterns(patterns, regexMode);

    let regex: UserRegex;
    let kResetGroup: number | undefined;
    let preFilter: PreFilter | undefined;
    try {
      const regexResult = buildRegex(combined.pattern, {
        mode: combined.mode,
        ignoreCase,
        wholeWord,
        lineRegexp,
      });
      regex = regexResult.regex;
      kResetGroup = regexResult.kResetGroup;
      preFilter = regexResult.preFilter;
    } catch {
      return {
        stdout: "",
        stderr: `grep: invalid regular expression: ${patterns.join("\n")}\n`,
        exitCode: 2,
      };
    }

    // If no files and stdin is provided (including empty string), read from
    // stdin. grep runs regex over text — decode bytes to UTF-8 so multibyte
    // codepoints match `.` / character classes correctly.
    if (files.length === 0) {
      let input = stdinUsedForPatterns ? "" : decodeBytesToUtf8(await readStdin());
      const binary = input.includes("\0");
      if (binary && binaryMode === "without-match") input = "";
      const result = searchContent(input, regex, {
        invertMatch,
        showLineNumbers,
        countOnly,
        filename: withFilename ? STDIN_FILENAME : "",
        filenameSeparator: nullFilename ? "\0" : undefined,
        onlyMatching,
        beforeContext,
        afterContext,
        maxCount,
        matchBeyondMaxCount: false,
        kResetGroup,
        preFilter,
        maxWork: getMatcherWorkLimit(ctx),
        maxMatches: ctx.limits.maxArrayElements,
        signal: ctx.signal,
      });
      if (quietMode) {
        return { stdout: "", stderr: "", exitCode: result.matched ? 0 : 1 };
      }
      // grep emits text; the pipeline handles encoding.
      return {
        stdout:
          binary && binaryMode === "binary" && result.matched && !countOnly
            ? ""
            : result.output,
        stderr:
          binary && binaryMode === "binary" && result.matched && !countOnly
            ? `grep: ${STDIN_FILENAME}: binary file matches\n`
            : "",
        exitCode: result.matched ? 0 : 1,
      };
    }

    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "grep: no input files\n",
        exitCode: 2,
      };
    }

    let stdout = "";
    let stderr = "";
    let anyMatch = false;
    let anyError = false;

    const traversalBudget: GrepTraversalBudget = {
      operations: 0,
      results: 0,
      maxOperations: ctx.limits.maxGlobOperations,
      maxResults: ctx.limits.maxArrayElements,
    };
    // Keep operand and traversal order, discovering the next file only when
    // its output can be consumed. Two entries determine filename prefixes.
    async function* entries(): AsyncGenerator<FileEntry> {
      let stdinConsumed = false;
      for (const file of files) {
        if (file === "-") {
          yield {
            path: STDIN_FILENAME,
            isFile: true,
            isStdin: true,
            stdinAtEof: stdinConsumed,
          };
          stdinConsumed = true;
        } else if (
          file.includes("*") ||
          file.includes("?") ||
          file.includes("[")
        ) {
          const expanded = await expandGlobPatternWithTypes(
            file,
            ctx,
            traversalBudget,
          );
          for (const entry of expanded) {
            if (recursive) {
              yield* expandRecursiveWithTypes(
                entry.path,
                ctx,
                includePatterns,
                excludePatterns,
                excludeDirPatterns,
                entry.isFile,
                traversalBudget,
                followSymlinks,
              );
            } else {
              yield entry;
            }
          }
        } else if (recursive) {
          yield* expandRecursiveWithTypes(
            file,
            ctx,
            includePatterns,
            excludePatterns,
            excludeDirPatterns,
            undefined,
            traversalBudget,
            followSymlinks,
          );
        } else {
          yield { path: file };
        }
      }
    }
    const iterator = entries();
    const first: FileEntry[] = [];
    const recursiveFilename = recursive && files.some((file) => file !== "-");
    for (let i = 0; i < (recursiveFilename || noFilename ? 1 : 2); i++) {
      const entry = await iterator.next();
      if (entry.done) break;
      first.push(entry.value);
    }
    const showFilename =
      (withFilename || first.length > 1 || recursiveFilename) &&
      !noFilename;

    // Keep parallel reads bounded to one batch. Emit each result before
    // discovering the next batch, so downstream closure stops further work.
    const batchSize = ctx.stdio && files.includes("-") ? 1 : 50;
    for await (const batch of fileBatches(
      iterator,
      first,
      batchSize,
      traversalBudget.maxResults,
      ctx.stdio ? 1 : batchSize,
    )) {
      const inputs = await Promise.allSettled(
        batch.map(async (entry): Promise<FileInput> => {
          if (entry.error) return { error: entry.error };
          if (entry.isStdin) {
            return {
              content:
                entry.stdinAtEof
                  ? ""
                  : decodeBytesToUtf8(await readStdin()),
            };
          }
          const basename = entry.path.split("/").pop() || entry.path;
          if (
            !recursive &&
            (excludePatterns.some((p) =>
              matchGlob(basename, p, { stripQuotes: true }),
            ) ||
              (includePatterns.length > 0 &&
                !includePatterns.some((p) =>
                  matchGlob(basename, p, { stripQuotes: true }),
                )))
          )
            return null;
          const path = ctx.fs.resolvePath(ctx.cwd, entry.path);
          const isDirectory =
            entry.isFile === undefined
              ? (await ctx.fs.stat(path)).isDirectory
              : !entry.isFile;
          if (isDirectory) {
            if (!recursive)
              return { error: `grep: ${entry.path}: Is a directory\n` };
            return null;
          }
          return { path };
        }),
      );
      const readable = inputs.flatMap((input, index) => {
        if (input.status === "rejected") {
          rethrowFatalExecutionError(input.reason);
          return [];
        }
        return input.value && "path" in input.value
          ? [{ path: input.value.path, index }]
          : [];
      });
      const candidates = await getCandidates(
        ctx.fs,
        readable.map((input) => input.path),
        !invertMatch && !countOnly && !filesWithoutMatch
          ? preFilter
          : undefined,
        ctx.signal,
      );
      const selected = candidates
        ? readable.filter((input) => candidates.has(input.path))
        : readable;
      let contents: Map<number, PromiseSettledResult<Uint8Array>> | undefined;
      if (ctx.fs.readMany && selected.length) {
        const reads = await readBatch(
          ctx.fs,
          selected.map((input) => input.path),
          ctx.signal,
        );
        contents = new Map(
          selected.map((input, index) => [input.index, reads[index]]),
        );
      }

      const results = await Promise.all(
        inputs.map(async (input, index) => {
          const file = batch[index].path;
          try {
            if (input.status === "rejected") throw input.reason;
            if (!input.value || "error" in input.value) return input.value;
            let content: string;
            if ("content" in input.value) {
              content = input.value.content;
            } else {
              const path = input.value.path;
              if (candidates && !candidates.has(path)) return null;
              const read = contents?.get(index);
              if (read?.status === "rejected") throw read.reason;
              content =
                read?.status === "fulfilled"
                  ? new TextDecoder().decode(read.value)
                  : await ctx.fs.readFile(path);
            }

            const binary = content.includes("\0");
            if (binary && binaryMode === "without-match") content = "";

            const result = searchContent(content, regex, {
              invertMatch,
              showLineNumbers,
              countOnly,
              filename: showFilename ? file : "",
              filenameSeparator: nullFilename ? "\0" : undefined,
              onlyMatching,
              beforeContext,
              afterContext,
              maxCount,
              matchBeyondMaxCount: false,
              kResetGroup,
              preFilter,
              maxWork: getMatcherWorkLimit(ctx),
              maxMatches: ctx.limits.maxArrayElements,
              signal: ctx.signal,
            });

            if (
              binary &&
              binaryMode === "binary" &&
              result.matched &&
              !countOnly &&
              !filesWithMatches &&
              !filesWithoutMatch &&
              !quietMode
            ) {
              result.output = "";
              return {
                file,
                result,
                binaryMessage: `grep: ${file}: binary file matches\n`,
              };
            }
            return { file, result };
          } catch (error) {
            rethrowFatalExecutionError(error);
            return { error: `grep: ${file}: No such file or directory\n` };
          }
        }),
      );

      // Process results from batch
      for (const res of results) {
        if (res === null) continue;

        if ("error" in res && res.error) {
          if (!noMessages) stderr += res.error;
          anyError = true;
          continue;
        }

        if (!("file" in res) || !res.result) continue;

        if ("binaryMessage" in res) stderr += res.binaryMessage;
        const { file, result } = res;
        if (result.matched) {
          anyMatch = true;
          if (quietMode) {
            // In quiet mode, exit immediately on first match
            return { stdout: "", stderr, exitCode: 0 };
          }
          if (filesWithMatches) {
            stdout += `${file}${nullFilename ? "\0" : "\n"}`;
          } else if (!filesWithoutMatch) {
            stdout += result.output;
          }
        } else {
          // No match in this file
          if (filesWithoutMatch) {
            stdout += `${file}${nullFilename ? "\0" : "\n"}`;
          } else if (countOnly && !filesWithMatches) {
            stdout += result.output;
          }
        }
        if (ctx.stdio && stdout) {
          try {
            await ctx.stdio.write(encodeUtf8ToBytes(stdout));
          } catch (error) {
            if (!(error instanceof BrokenPipeError)) throw error;
            return { stdout: "", stderr, exitCode: 141 };
          }
          stdout = "";
        }
      }
    }

    // Exit codes: 0 = a line was selected, 1 = no line was selected, 2 = error.
    //
    // -L deliberately does NOT get its own rule. GNU grep's status reports
    // whether a line was *selected*, never whether a filename was *printed*, so
    // `grep -L` exits 0 when every file matched (and it printed nothing) and 1
    // when no file matched (and it listed them all). Verified against GNU grep
    // 3.12 and BSD grep 2.6.0-FreeBSD; note that ripgrep 15.1.0's
    // --files-without-match really does invert this, which is why
    // src/commands/rg/rg-search.ts keeps the opposite rule on purpose.
    let exitCode: number;
    if (anyError) {
      exitCode = 2;
    } else {
      exitCode = anyMatch ? 0 : 1;
    }

    if (quietMode) {
      return { stdout: "", stderr, exitCode };
    }

    return {
      stdout,
      stderr,
      exitCode,
    };
  },
};

async function* fileBatches(
  iterator: AsyncGenerator<FileEntry>,
  first: FileEntry[],
  size: number,
  limit: number,
  firstBatchSize: number,
): AsyncGenerator<FileEntry[]> {
  let batch: FileEntry[] = [];
  let firstIndex = 0;
  let count = 0;
  try {
    for (;;) {
      while (batch.length < (count === 0 ? firstBatchSize : size)) {
        const next =
          firstIndex < first.length
            ? { done: false, value: first[firstIndex++] }
            : await iterator.next();
        if (next.done) break;
        batch.push(next.value);
      }
      if (batch.length === 0) return;
      count += batch.length;
      if (count > limit) {
        throw new ExecutionLimitError(
          `grep: array element limit exceeded (${limit})`,
          "array_elements",
        );
      }
      yield batch;
      batch = [];
    }
  } finally {
    await iterator.return(undefined);
  }
}

/** Safety limit to prevent stack overflow on deeply nested directories */
const MAX_GREP_DEPTH = 256;

async function expandRecursiveGlob(
  baseDir: string,
  afterGlob: string,
  ctx: RuntimeCommandContext,
  result: string[],
  budget: GrepTraversalBudget,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_GREP_DEPTH) return;
  const fullBasePath = ctx.fs.resolvePath(ctx.cwd, baseDir);

  try {
    useTraversalOperation(budget);
    const stat = await ctx.fs.stat(fullBasePath);

    if (!stat.isDirectory) {
      // Check if the file matches afterGlob pattern
      const filename = baseDir.split("/").pop() || "";
      if (afterGlob) {
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(filename, pattern, { stripQuotes: true })) {
          addTraversalResult(budget);
          result.push(baseDir);
        }
      }
      return;
    }

    // Check files in current directory
    useTraversalOperation(budget);
    const entries = await ctx.fs.readdir(fullBasePath);
    for (const entry of entries) {
      const entryPath = baseDir === "." ? entry : `${baseDir}/${entry}`;
      const fullEntryPath = ctx.fs.resolvePath(ctx.cwd, entryPath);
      useTraversalOperation(budget);
      const entryStat = await ctx.fs.stat(fullEntryPath);

      if (entryStat.isDirectory) {
        // Recurse into directory
        await expandRecursiveGlob(
          entryPath,
          afterGlob,
          ctx,
          result,
          budget,
          depth + 1,
        );
      } else if (afterGlob) {
        // Check if file matches afterGlob pattern
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(entry, pattern, { stripQuotes: true })) {
          addTraversalResult(budget);
          result.push(entryPath);
        }
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Ignore errors
  }
}

/**
 * Optimized glob expansion that returns FileEntry with type info
 * Uses readdirWithFileTypes when available to avoid stat calls
 */
async function expandGlobPatternWithTypes(
  pattern: string,
  ctx: RuntimeCommandContext,
  budget: GrepTraversalBudget,
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Find the directory part and the glob part
  const lastSlash = pattern.lastIndexOf("/");
  let dirPath: string;
  let globPart: string;

  if (lastSlash === -1) {
    dirPath = ctx.cwd;
    globPart = pattern;
  } else {
    dirPath = pattern.slice(0, lastSlash) || "/";
    globPart = pattern.slice(lastSlash + 1);
  }

  // Handle ** (recursive glob) - fall back to old method
  if (pattern.includes("**")) {
    const oldResult: string[] = [];
    const parts = pattern.split("**");
    const baseDir = parts[0].replace(/\/$/, "") || ".";
    const afterGlob = parts[1] || "";
    await expandRecursiveGlob(baseDir, afterGlob, ctx, oldResult, budget);
    return oldResult.map((p) => ({ path: p }));
  }

  // Resolve the directory path
  const fullDirPath = ctx.fs.resolvePath(ctx.cwd, dirPath);

  try {
    // Use readdirWithFileTypes if available for better performance
    if (ctx.fs.readdirWithFileTypes) {
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdirWithFileTypes(fullDirPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (matchGlob(entry.name, globPart, { stripQuotes: true })) {
          const fullPath =
            lastSlash === -1 ? entry.name : `${dirPath}/${entry.name}`;
          addTraversalResult(budget);
          result.push({
            path: fullPath,
            isFile: entry.isFile,
          });
        }
      }
    } else {
      // Fall back to regular readdir
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdir(fullDirPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (matchGlob(entry, globPart, { stripQuotes: true })) {
          const fullPath = lastSlash === -1 ? entry : `${dirPath}/${entry}`;
          addTraversalResult(budget);
          result.push({ path: fullPath });
        }
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Directory doesn't exist - return empty
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Optimized recursive expansion that returns FileEntry with type info
 * Uses readdirWithFileTypes when available to avoid stat calls
 */
async function* expandRecursiveWithTypes(
  path: string,
  ctx: RuntimeCommandContext,
  includePatterns: string[] = [],
  excludePatterns: string[] = [],
  excludeDirPatterns: string[] = [],
  knownIsFile?: boolean,
  budget: GrepTraversalBudget = {
    operations: 0,
    results: 0,
    maxOperations: ctx.limits.maxGlobOperations,
    maxResults: ctx.limits.maxArrayElements,
  },
  followSymlinks = false,
  depth = 0,
): AsyncGenerator<FileEntry> {
  if (depth >= MAX_GREP_DEPTH) return;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);

  try {
    // Determine if it's a file or directory
    let isFile: boolean;
    let isDirectory: boolean;

    if (knownIsFile !== undefined) {
      isFile = knownIsFile;
      isDirectory = !knownIsFile;
    } else {
      useTraversalOperation(budget);
      const stat =
        depth > 0 && !followSymlinks
          ? await ctx.fs.lstat(fullPath)
          : await ctx.fs.stat(fullPath);
      if (stat.isSymbolicLink) return;
      isFile = stat.isFile;
      isDirectory = stat.isDirectory;
    }

    if (isFile) {
      const basename = path.split("/").pop() || path;

      // Check exclude patterns
      if (excludePatterns.length > 0) {
        if (
          excludePatterns.some((p) =>
            matchGlob(basename, p, { stripQuotes: true }),
          )
        ) {
          return;
        }
      }

      // Check include patterns
      if (includePatterns.length > 0) {
        if (
          !includePatterns.some((p) =>
            matchGlob(basename, p, { stripQuotes: true }),
          )
        ) {
          return;
        }
      }
      addTraversalResult(budget);
      yield { path, isFile: true };
      return;
    }

    if (!isDirectory) {
      return;
    }

    // Check if directory should be excluded
    const dirName = path.split("/").pop() || path;
    if (excludeDirPatterns.length > 0) {
      if (
        excludeDirPatterns.some((p) =>
          matchGlob(dirName, p, { stripQuotes: true }),
        )
      ) {
        return;
      }
    }

    // Use readdirWithFileTypes if available
    if (ctx.fs.readdirWithFileTypes) {
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdirWithFileTypes(fullPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (entry.isSymbolicLink && !followSymlinks) continue;

        const entryPath = path
          ? `${path.replace(/\/$/, "")}/${entry.name}`
          : entry.name;
        yield* expandRecursiveWithTypes(
          entryPath,
          ctx,
          includePatterns,
          excludePatterns,
          excludeDirPatterns,
          entry.isSymbolicLink ? undefined : entry.isFile,
          budget,
          followSymlinks,
          depth + 1,
        );
      }
    } else {
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdir(fullPath);
      for (const entry of entries) {
        useTraversalOperation(budget);

        const entryPath = path ? `${path.replace(/\/$/, "")}/${entry}` : entry;
        yield* expandRecursiveWithTypes(
          entryPath,
          ctx,
          includePatterns,
          excludePatterns,
          excludeDirPatterns,
          undefined,
          budget,
          followSymlinks,
          depth + 1,
        );
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    addTraversalResult(budget);
    yield { path, error: `grep: ${path}: ${describeFsError(error)}\n` };
  }

  return;
}

// fgrep is equivalent to grep -F
export const fgrepCommand: RuntimeCommand = {
  name: "fgrep",
  streaming: true,

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    // Insert -F at the beginning of args
    return grepCommand.execute(["-F", ...args], ctx);
  },
};

// egrep is equivalent to grep -E
export const egrepCommand: RuntimeCommand = {
  name: "egrep",
  streaming: true,

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    // Insert -E at the beginning of args
    return grepCommand.execute(["-E", ...args], ctx);
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "grep",
  flags: [
    { flag: "-E", type: "boolean" },
    { flag: "-F", type: "boolean" },
    { flag: "-P", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-x", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-l", type: "boolean" },
    { flag: "-L", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-h", type: "boolean" },
    { flag: "-o", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-m", type: "value", valueHint: "number" },
    { flag: "-A", type: "value", valueHint: "number" },
    { flag: "-B", type: "value", valueHint: "number" },
    { flag: "-C", type: "value", valueHint: "number" },
    { flag: "-e", type: "value", valueHint: "pattern" },
    { flag: "-f", type: "value", valueHint: "path" },
  ],
  stdinType: "text",
  needsArgs: true,
};

export const fgrepFlagsForFuzzing: CommandFuzzInfo = {
  name: "fgrep",
  flags: [],
  stdinType: "text",
  needsArgs: true,
};

export const egrepFlagsForFuzzing: CommandFuzzInfo = {
  name: "egrep",
  flags: [],
  stdinType: "text",
  needsArgs: true,
};
