import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";

// All c-agent state may hold transcripts, notes, credentials, or PII. On a
// shared/multi-user host (gov deployments) these must not be world-readable, so
// every write goes through here: dirs 0700, files 0600. chmod is reapplied after
// write because writeFile's `mode` only takes effect when CREATING a file — an
// existing file written by an older build (0644) would otherwise keep its perms.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Create a directory (and parents) and enforce private (0700) perms on it. */
export function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* best effort — e.g. not owner */
  }
}

/** Write a file with private (0600) perms, creating its parent dir 0700. */
export function writeSecureFile(path: string, data: string): void {
  ensureSecureDir(dirname(path));
  writeFileSync(path, data, { mode: FILE_MODE });
  try {
    chmodSync(path, FILE_MODE); // enforce on overwrite of a pre-existing looser file
  } catch {
    /* best effort */
  }
}

/** Atomic secure write: write temp in the same dir, chmod, then rename over target. */
export function writeSecureFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  ensureSecureDir(dir);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: FILE_MODE });
    try {
      chmodSync(tmp, FILE_MODE);
    } catch {
      /* best effort */
    }
    renameSync(tmp, path);
    try {
      chmodSync(path, FILE_MODE);
    } catch {
      /* best effort */
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}
