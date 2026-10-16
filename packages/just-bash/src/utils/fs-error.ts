import { getErrorCode } from "../interpreter/helpers/errors.js";

const reasons = new Map([
  ["ENOENT", "No such file or directory"],
  ["ENOTDIR", "Not a directory"],
  ["EISDIR", "Is a directory"],
  ["EACCES", "Permission denied"],
  ["EPERM", "Operation not permitted"],
  ["EROFS", "Read-only file system"],
  ["ENOSPC", "No space left on device"],
  ["EFBIG", "File too large"],
  ["EIO", "Input/output error"],
  ["ENAMETOOLONG", "File name too long"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["EINVAL", "Invalid argument"],
]);

/** Describe filesystem failures without exposing paths from the underlying error. */
export function describeFsError(error: unknown): string {
  const code = getErrorCode(error);
  const reason = code && reasons.get(code);
  if (reason) return reason;
  throw error;
}
