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
 * prove is read-only by literal inspection. Shell constructs that could chain,
 * redirect, substitute, background, or group commands void classification, and
 * the command must consist solely of an allowlisted, non-program-spawning base
 * command (or a git read-only subcommand). User `deny` permission rules are
 * still enforced regardless of this result.
 */

// Unquoted characters that can introduce a second command, redirect,
// substitution, subshell, brace expansion, or backgrounding.
const SHELL_METACHARS = new Set(["\n", ";", "|", "&", "<", ">", "(", ")", "{", "}"]);

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

function tokenizeSingleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "$" || ch === "`") {
        return null;
      } else {
        token += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "$" || ch === "`" || SHELL_METACHARS.has(ch)) return null;

    if (/\s/.test(ch)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }

  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function readOnlyGitSubcommand(tokens: string[]): boolean {
  if (tokens.some((t) => t === "--git-dir" || t.startsWith("--git-dir="))) return false;
  if (tokens.some((t) => t === "--work-tree" || t.startsWith("--work-tree="))) return false;

  let i = 1;
  while (tokens[i] === "-C") {
    if (!tokens[i + 1]) return false;
    i += 2;
  }
  const sub = tokens[i];
  return !!sub && GIT_READ_ONLY_SUBCMDS.has(sub);
}

/**
 * True only if `command` is provably a single read-only shell command.
 * Conservative by design — see the security model at the top of this file.
 */
export function isReadOnlyBashCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  const tokens = tokenizeSingleCommand(cmd);
  if (!tokens || tokens.length === 0) return false;

  // 1. Reject env-assignment prefixes (`FOO=bar somecmd` runs somecmd).
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return false;

  // 2. Strip any leading path; classify on the bare program name.
  const base = tokens[0]!.split("/").pop() ?? tokens[0]!;

  // 3. git: only an explicit read-only subcommand qualifies.
  if (base === "git") {
    return readOnlyGitSubcommand(tokens);
  }

  // 4. Must be an allowlisted read-only command.
  if (!SIMPLE_READ_ONLY.has(base)) return false;

  // 5. Per-command flag guards for the few allowlisted commands that CAN write.
  if (base === "find" && tokens.some((t) => FIND_WRITE_FLAGS.has(t))) return false;
  if (base === "sort" && tokens.some((t) => t === "-o" || t.startsWith("--output"))) return false;

  return true;
}
