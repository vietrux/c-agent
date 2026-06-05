import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { Session, type SessionData } from "./session.js";
import { ensureSecureDir, writeSecureFile } from "./utils/secure-fs.js";

const ROOT = join(homedir(), ".c-agent", "sessions");

function projectKey(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

/** Per-project on-disk session store: ~/.c-agent/sessions/<projhash>/<id>.json */
export class SessionStore {
  private dir: string;

  constructor(private cwd: string) {
    this.dir = join(ROOT, projectKey(cwd));
  }

  /** Persist a session and wire it to autosave on every change. */
  attach(session: Session) {
    ensureSecureDir(this.dir);
    session.onChange = () => this.save(session);
    this.save(session);
  }

  save(session: Session) {
    if (session.messages.length === 0) return; // don't litter empty sessions
    const file = join(this.dir, `${session.id}.json`);
    writeSecureFile(file, JSON.stringify(session.toData())); // 0600 — may hold PII/secrets
  }

  load(id: string): Session | null {
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as SessionData;
      return Session.fromData(d);
    } catch {
      return null;
    }
  }

  /** Sessions for this project, newest first. */
  list(): SessionData[] {
    if (!existsSync(this.dir)) return [];
    const out: SessionData[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as SessionData);
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  latest(): Session | null {
    const all = this.list();
    return all.length ? Session.fromData(all[0]) : null;
  }
}
