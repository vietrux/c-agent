/**
 * Read-only bash classifier.
 *
 * SECURITY MODEL — read this before touching the lists below.
 *
 * A `true` result downgrades a bash call: it is treated as side-effect-free, so
 * it (a) may run concurrently and (b) skips the interactive permission prompt
 * (same trust level as the always-allowed read/grep/glob tools). A WRONG `true`
 * therefore lets a mutating command run without approval — a security incident.
 *
 * Consequences of the two error directions are deliberately asymmetric:
 *   - false-positive (a safe command classified NOT read-only) → one extra
 *     permission prompt. Harmless.
 *   - false-negative (a mutating command classified read-only) → unapproved
 *     side effect. Catastrophic.
 *
 * So the bias is hard toward `false`: we only return `true` for a command we can
 * prove is read-only by literal inspection. ANY shell construct that could
 * chain, redirect, substitute, background, or group commands voids the
 * classification, and the command must consist solely of an allowlisted,
 * non-program-spawning base command (or a git read-only subcommand). User `deny`
 * permission rules are still enforced regardless of this result.
 *
 * We do NOT parse quotes. A metacharacter inside quotes (e.g. `grep ">" f`) is
 * treated the same as an unquoted one → not read-only → prompt. Safe over clever.
 */

// Any of these characters can introduce a second command, a redirect, a
// substitution, a subshell, brace expansion, or backgrounding. Presence of even
// one (quoted or not) voids read-only classification.
//   ; | &   → chaining / backgrounding / pipelines
//   < >     → redirects (and <( ) process substitution, << heredocs)
//   ( ) ` $ are handled below; ( ) also via this set
//   { }     → brace expansion
//   \n      → multiple lines
const SHELL_METACHARS = /[\n;|&<>`(){}]/;

// Commands that read/inspect only and never spawn another program. Anything that
// can execute a sub-program (env, xargs, sudo, timeout, nohup, watch, ssh, find
// -exec, awk system(), sed -i/w …) is intentionally excluded.
const SIMPLE_READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf",
  "stat", "file", "du", "df", "date", "whoami", "id", "hostname", "uname",
  "printenv", "which", "type", "tree", "basename", "dirname", "realpath",
  "readlink", "cksum", "md5sum", "sha1sum", "sha256sum", "sha512sum",
  "uniq", "cut", "tr", "nl", "tac", "rev", "fold", "comm", "diff", "cmp",
  "column", "grep", "egrep", "fgrep", "rg", "ag", "fd", "find", "sort",
  "true", "false", "test", "ps",
]);

// git subcommands that only read history/state. Excludes anything whose flags
// can mutate (branch -d, tag -d, remote add, config, stash, checkout, …).
const GIT_READ_ONLY_SUBCMDS = new Set([
  "status", "log", "diff", "show", "blame", "ls-files", "ls-tree",
  "shortlog", "reflog", "whatchanged", "cat-file", "rev-parse", "rev-list",
  "describe", "name-rev", "symbolic-ref",
]);

// `find` flags that execute or write — void classification even though `find` is
// otherwise read-only.
const FIND_WRITE_FLAGS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir",
  "-fprint", "-fprintf", "-fprint0", "-fls",
]);

/**
 * True only if `command` is provably a single read-only shell command.
 * Conservative by design — see the security model at the top of this file.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  // 1. Reject any construct that could chain / redirect / substitute / group.
  if (SHELL_METACHARS.test(cmd)) return false;
  if (cmd.includes("$(")) return false; // command substitution (also caught by `(`, belt-and-braces)

  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // 2. Reject env-assignment prefixes (`FOO=bar somecmd` runs somecmd).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return false;

  // 3. Strip any leading path; classify on the bare program name.
  const base = tokens[0]!.split("/").pop() ?? tokens[0]!;

  // 4. git: only an explicit read-only subcommand qualifies.
  if (base === "git") {
    const sub = tokens[1];
    return !!sub && GIT_READ_ONLY_SUBCMDS.has(sub);
  }

  // 5. Must be an allowlisted read-only command.
  if (!SIMPLE_READ_ONLY.has(base)) return false;

  // 6. Per-command flag guards for the few allowlisted commands that CAN write.
  if (base === "find" && tokens.some((t) => FIND_WRITE_FLAGS.has(t))) return false;
  if (base === "sort" && tokens.some((t) => t === "-o" || t.startsWith("--output"))) return false;

  return true;
}
