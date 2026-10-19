import { encodeUtf8ToBytes } from "../../encoding.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type { UserRegex } from "../../regex/index.js";
import { _setTimeout } from "../../timers.js";
import type { RuntimeCommandContext } from "../../types.js";
import { matchesLine } from "../search-engine/matcher.js";
import {
  type PreFilter,
  preFilterMatches,
} from "../search-engine/required-literals.js";
import type { RgOptions } from "./rg-options.js";

/** Search an already decoded file without retaining its complete match output. */
export async function searchFileLines(
  ctx: RuntimeCommandContext,
  content: string,
  regex: UserRegex,
  options: RgOptions,
  filename: string,
  showLineNumbers: boolean,
  preFilter?: PreFilter,
): Promise<boolean> {
  const { stdio, signal, limits } = ctx;
  if (!stdio) throw new Error("rg: streaming output required");
  if (signal?.aborted) throw new ExecutionAbortedError();
  if (
    preFilter &&
    !options.invertMatch &&
    !preFilterMatches(preFilter, content)
  )
    return false;
  const { maxArrayElements, maxLoopIterations } = limits;
  const prefix = filename ? `${filename}:` : "";
  let matched = false;
  let lineNumber = 0;
  let work = 0;
  let checkpoint = 256;
  let yieldAt = Date.now() + 8;
  let yielded = false;
  let output = "";
  for (let start = 0; start < content.length; ) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline;
    const line = content.slice(start, end);
    work += 1 + Math.ceil(line.length / 1024);
    if (++lineNumber > maxArrayElements || work > maxLoopIterations) {
      throw new ExecutionLimitError(
        "rg: matching work limit exceeded",
        "iterations",
      );
    }
    if (matchesLine(line, regex, preFilter) !== options.invertMatch) {
      output += `${prefix}${showLineNumbers ? `${lineNumber}:` : ""}${line}\n`;
      // Deliver the first result promptly; subsequent writes amortize encoding and pipe work.
      if (!matched || output.length >= 16 * 1024) {
        await stdio.write(encodeUtf8ToBytes(output));
        output = "";
      }
      matched = true;
    }
    if (work >= checkpoint) {
      // Empty writes here still notice head closing after the last matching line.
      await stdio.write(encodeUtf8ToBytes(output));
      output = "";
      if ((matched && !yielded) || Date.now() >= yieldAt) {
        await new Promise<void>((resolve) => _setTimeout(resolve, 0));
        yieldAt = Date.now() + 8;
        yielded = true;
      }
      if (signal?.aborted) throw new ExecutionAbortedError();
      checkpoint = work + 256;
    }
    start = end + 1;
  }
  if (output) await stdio.write(encodeUtf8ToBytes(output));
  return matched;
}
