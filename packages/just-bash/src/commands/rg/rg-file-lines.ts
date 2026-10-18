import { encodeUtf8ToBytes } from "../../encoding.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { UserRegex } from "../../regex/index.js";
import type { RuntimeCommandContext } from "../../types.js";
import { searchContent } from "../search-engine/index.js";
import type { RgOptions } from "./rg-options.js";

/** Search an already decoded file without retaining its complete match output. */
export async function searchFileLines(
  ctx: RuntimeCommandContext,
  content: string,
  regex: UserRegex,
  options: RgOptions,
  filename: string,
  showLineNumbers: boolean,
): Promise<boolean> {
  if (!ctx.stdio) throw new Error("rg: streaming output required");
  let matched = false;
  let lineNumber = 0;
  let work = 0;
  for (let start = 0; start < content.length; ) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline;
    const line = content.slice(start, end);
    work += 1 + Math.ceil(line.length / 1024);
    if (
      ++lineNumber > ctx.limits.maxArrayElements ||
      work > ctx.limits.maxLoopIterations
    ) {
      throw new ExecutionLimitError(
        "rg: matching work limit exceeded",
        "iterations",
      );
    }
    if ((lineNumber & 63) === 0)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const result = searchContent(`${line}\n`, regex, {
      invertMatch: options.invertMatch,
      signal: ctx.signal,
      maxWork: ctx.limits.maxLoopIterations,
    });
    const selected = result.matched;
    matched ||= selected;
    const prefix = `${filename ? `${filename}:` : ""}${showLineNumbers ? `${lineNumber}:` : ""}`;
    await ctx.stdio.write(
      encodeUtf8ToBytes(selected ? `${prefix}${line}\n` : ""),
    );
    start = end + 1;
  }
  return matched;
}
