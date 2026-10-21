import type { IFileSystem } from "../../fs/interface.js";
import type { PreFilter } from "./regex.js";

/** Candidate membership never determines command ordering or duplicates. */
export async function getCandidates(
  fs: IFileSystem,
  paths: readonly string[],
  preFilter: PreFilter | undefined,
  signal?: AbortSignal,
): Promise<ReadonlySet<string> | undefined> {
  // Case folding differs across engines/locales, and rg preserves invalid
  // UTF-8 as raw bytes. Exact ASCII literals are safe for both decoders.
  if (
    !fs.searchCandidates ||
    !preFilter ||
    preFilter.ignoreCase ||
    !paths.length
  ) {
    return undefined;
  }
  // #626 represents alternatives as conjunctions. The remote API accepts an
  // OR, so flattening keeps a safe superset; the matcher checks the full pattern.
  const needles = preFilter.groups.flat();
  if (
    needles.length > 50 ||
    needles.reduce((bytes, needle) => bytes + needle.length, 0) > 64 * 1024 ||
    needles.some((needle) => /[^\x00-\x7f]/.test(needle))
  )
    return undefined;
  signal?.throwIfAborted();
  const candidates = await fs.searchCandidates({
    paths,
    anyOf: needles,
    signal,
  });
  signal?.throwIfAborted();
  return candidates === undefined ? undefined : new Set(candidates);
}
