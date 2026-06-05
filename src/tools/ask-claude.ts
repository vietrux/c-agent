import type { Tool, ToolContext } from "./registry.js";

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TURNS = 20;
const AUP_URL = "https://www.anthropic.com/legal/aup";

// The consultant runs Claude Code's full agent loop in its OWN process, talking
// directly to Anthropic — it does NOT pass through c-agent's PermissionEngine or
// the undercover RedactingProvider. So: pin it read-only (permissionMode "plan"),
// don't inherit the user's local settings/skills (settingSources []), and warn
// before sending when undercover masking is active (see run()).
const CONSULTANT_SYSTEM =
  `You are an expert software-engineering consultant invoked programmatically by ANOTHER AI ` +
  `agent (not a human) that has hit a hard problem — complex logic, an algorithm, a subtle bug, ` +
  `or a non-trivial program to write. Give a complete, directly-usable answer: working code, ` +
  `precise reasoning, and any important caveats. Be concrete and thorough; the caller applies your ` +
  `output itself, so make it self-contained.\n\n` +
  `You are READ-ONLY in the caller's repository: you may read files for context, but you MUST NOT ` +
  `modify, create, or delete files, or run state-changing commands.\n\n` +
  `You must comply with Anthropic's Acceptable Use Policy (${AUP_URL}). If a request would violate ` +
  `it, refuse and briefly explain why rather than complying.`;

/** Assemble the structured fields into one detailed prompt for the consultant. */
function buildPrompt(input: any): string {
  const sections: [string, string | undefined][] = [
    ["Problem", input.problem],
    ["Context", input.context],
    ["Constraints", input.constraints],
    ["Already attempted", input.attempted],
    ["Expected output", input.expected_output],
  ];
  return sections
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([h, v]) => `# ${h}\n${(v as string).trim()}`)
    .join("\n\n");
}

function authHint(msg: string): boolean {
  return /api[_\s-]?key|unauthorized|authenticat|not logged in|login|401|403|credential/i.test(msg);
}

export const askClaudeTool: Tool = {
  spec: {
    name: "ask_claude",
    description:
      "Consult an external Claude expert agent (Claude Agent SDK) for a hard problem you cannot " +
      "confidently solve yourself — complex algorithms/logic, writing a non-trivial program, or a " +
      "stubborn bug. It runs a separate read-only Claude in its own context and returns its answer. " +
      "Costs money/credits and sends your prompt off-machine, so the user must approve each call: " +
      "write a COMPLETE, detailed, self-contained prompt via the structured fields (the expert does " +
      "not see this conversation). Do not put secrets or content that violates Anthropic's " +
      "Acceptable Use Policy (" + AUP_URL + ") in the prompt. Use sparingly, only when genuinely stuck.",
    parameters: {
      type: "object",
      properties: {
        problem: {
          type: "string",
          description: "The precise problem/question to solve. Be specific and complete.",
        },
        context: {
          type: "string",
          description:
            "Background the expert needs: relevant code, data shapes, environment, prior decisions. " +
            "It has no view of this conversation, so include everything that matters.",
        },
        constraints: {
          type: "string",
          description: "Requirements/limits: language, perf, style, APIs to use or avoid, edge cases.",
        },
        attempted: {
          type: "string",
          description: "What you already tried and how it failed (so it doesn't repeat dead ends).",
        },
        expected_output: {
          type: "string",
          description: "What a good answer looks like (e.g. 'a working TypeScript function + reasoning').",
        },
      },
      required: ["problem", "context"],
    },
  },
  risky: true,

  async run(input: any, ctx: ToolContext, signal?: AbortSignal) {
    const problem = String(input.problem ?? "").trim();
    const context = String(input.context ?? "").trim();
    // Enforce the "detailed prompt" rule: reject thin requests so the model
    // re-asks with real detail instead of wasting an off-machine call.
    if (problem.length + context.length < 40) {
      return {
        text:
          "✗ prompt too thin for an external consult. Provide a detailed, self-contained `problem` " +
          "and `context` (the expert sees none of this conversation).",
        isError: true,
      };
    }

    // Undercover masking lives on c-agent's own provider wire; the SDK bypasses
    // it entirely, so PII in this prompt would be sent UNMASKED. Warn + confirm.
    if (ctx.undercover?.enabled) {
      if (!ctx.confirm) {
        return {
          text:
            "✗ undercover mode is ON and there is no approval channel. The external Claude Agent SDK " +
            "bypasses PII masking — refusing to send unmasked data. Turn off undercover to consult.",
          isError: true,
        };
      }
      const decision = await ctx.confirm({
        name: "ask_claude — UNDERCOVER BYPASS",
        preview:
          "⚠ Undercover masking does NOT apply: this prompt is sent UNMASKED to an external Claude. " +
          `Question: ${problem.slice(0, 140)}`,
      });
      if (decision.decision === "deny")
        return { text: "✗ denied — not sending unmasked data to external Claude", isError: true };
    }

    const model = ctx.consultant?.model ?? DEFAULT_MODEL;
    const maxTurns = ctx.consultant?.maxTurns ?? DEFAULT_MAX_TURNS;
    const prompt = buildPrompt(input);

    // Bridge Esc/interrupt into the SDK's own abort.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      // Loose import: the SDK is an optional, heavy dep and its option typings
      // shouldn't gate c-agent's build. Failure here surfaces as a tool error.
      const mod: any = await import("@anthropic-ai/claude-agent-sdk");
      const q = mod.query({
        prompt,
        options: {
          model,
          systemPrompt: CONSULTANT_SYSTEM,
          permissionMode: "plan", // read-only: consultant can't mutate the repo
          cwd: ctx.cwd,
          maxTurns,
          settingSources: [], // don't inherit the user's ~/.claude config/skills
          abortController: ac,
        },
      });

      let resultText = "";
      let cost: number | undefined;
      let subtype = "";
      for await (const m of q) {
        if (signal?.aborted) break;
        if (m?.type === "result") {
          subtype = m.subtype ?? "";
          if (typeof m.result === "string") resultText = m.result;
          if (typeof m.total_cost_usd === "number") cost = m.total_cost_usd;
        }
      }

      if (signal?.aborted) return { text: "✗ interrupted", isError: true };
      if (!resultText) {
        return {
          text: `(external Claude returned no answer${subtype ? `: ${subtype}` : ""})`,
          isError: true,
        };
      }
      const footer = `\n\n— external Claude (${model}${cost != null ? `, ~$${cost.toFixed(4)}` : ""})`;
      return { text: resultText + footer };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      const hint = authHint(msg)
        ? " — log in with the `claude` CLI or set ANTHROPIC_API_KEY, then retry"
        : "";
      return { text: `✗ ask_claude failed: ${msg}${hint}`, isError: true };
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  },
};
