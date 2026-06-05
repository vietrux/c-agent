import { ToolRegistry } from "./registry.js";
import { bashTool, procListTool, procReadTool, procTailTool, procKillTool } from "./bash.js";
import { readTool, writeTool, editTool, multiEditTool, globTool, grepTool } from "./files.js";
import { todoTool, askTool } from "./meta.js";
import { httpRequestTool } from "./http.js";
import { codecTool } from "./codec.js";
import { notesTool } from "./notes.js";

export function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of [
    bashTool,
    procListTool,
    procReadTool,
    procTailTool,
    procKillTool,
    readTool,
    writeTool,
    editTool,
    multiEditTool,
    globTool,
    grepTool,
    todoTool,
    askTool,
    httpRequestTool,
    codecTool,
    notesTool,
  ]) {
    r.register(t);
  }
  return r;
}

export * from "./registry.js";
