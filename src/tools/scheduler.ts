import type { ToolCall } from "../provider/types.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

export interface ToolEventInfo {
  index: number;
  total: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  queueMs?: number;
  durationMs?: number;
  concurrencySafe: boolean;
  batch: number;
}

export interface ToolSchedulerEvents {
  toolQueued?(id: string, name: string, input: any, info: ToolEventInfo): void;
  toolStart(id: string, name: string, input: any, info: ToolEventInfo): void;
  toolEnd(
    id: string,
    result: string,
    isError: boolean,
    info: ToolEventInfo,
  ): void;
}

export interface ToolSchedulerOptions {
  maxConcurrency?: number;
}

export interface ScheduledToolResult {
  id: string;
  content: string;
  isError: boolean;
}

interface TrackedCall {
  call: ToolCall;
  index: number;
  info: ToolEventInfo;
  status: "queued" | "running" | "done";
  result?: ScheduledToolResult;
  promise?: Promise<void>;
}

function now(): number {
  return Date.now();
}

function eventInfo(info: ToolEventInfo): ToolEventInfo {
  return { ...info };
}

function interruptedResult(id: string): ScheduledToolResult {
  return { id, content: "✗ interrupted", isError: true };
}

function configuredConcurrency(value?: number): number {
  const raw = value ?? (Number(process.env.C_AGENT_MAX_TOOL_CONCURRENCY || "") || 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(1, Math.floor(raw));
}

export interface StreamingToolSchedulerOptions extends ToolSchedulerOptions {
  /** When true, only concurrency-safe calls can start before releaseUnsafe(). */
  deferUnsafeUntilReleased?: boolean;
}

export class StreamingToolScheduler {
  private items: TrackedCall[] = [];
  private byId = new Map<string, TrackedCall>();
  private maxConcurrency: number;
  private unsafeReleased: boolean;

  constructor(
    private registry: ToolRegistry,
    private ctx: ToolContext,
    private events: ToolSchedulerEvents,
    private signal?: AbortSignal,
    options: StreamingToolSchedulerOptions = {},
  ) {
    this.maxConcurrency = configuredConcurrency(options.maxConcurrency);
    this.unsafeReleased = !options.deferUnsafeUntilReleased;
  }

  add(call: ToolCall): boolean {
    if (this.byId.has(call.id)) return false;
    const index = this.items.length;
    const info: ToolEventInfo = {
      index,
      total: index + 1,
      queuedAt: now(),
      concurrencySafe: this.registry.isConcurrencySafe(call.name, call.input),
      batch: -1,
    };
    const item: TrackedCall = { call, index, info, status: "queued" };
    this.items.push(item);
    this.byId.set(call.id, item);
    this.events.toolQueued?.(call.id, call.name, call.input, eventInfo(info));
    this.processQueue();
    return true;
  }

  releaseUnsafe() {
    this.unsafeReleased = true;
    this.processQueue();
  }

  async waitFor(finalCalls: ToolCall[]): Promise<ScheduledToolResult[]> {
    for (const call of finalCalls) this.add(call);
    for (const item of this.items) item.info.total = finalCalls.length;
    this.processQueue();

    const wanted = finalCalls
      .map((call) => this.byId.get(call.id))
      .filter((item): item is TrackedCall => !!item);

    while (wanted.some((item) => item.status !== "done")) {
      const running = wanted
        .filter((item) => item.status === "running" && item.promise)
        .map((item) => item.promise!);
      if (running.length === 0) {
        this.processQueue();
        const after = wanted
          .filter((item) => item.status === "running" && item.promise)
          .map((item) => item.promise!);
        if (after.length === 0) break;
        await Promise.race(after);
      } else {
        await Promise.race(running);
      }
    }

    for (const item of wanted) {
      if (item.status === "done") continue;
      const interrupted = interruptedResult(item.call.id);
      item.info.endedAt = now();
      item.info.durationMs =
        item.info.startedAt === undefined
          ? 0
          : item.info.endedAt - item.info.startedAt;
      item.result = interrupted;
      item.status = "done";
      this.events.toolEnd(
        item.call.id,
        interrupted.content,
        true,
        eventInfo(item.info),
      );
    }

    return finalCalls.map((call) => {
      const item = this.byId.get(call.id);
      return item?.result ?? interruptedResult(call.id);
    });
  }

  private processQueue() {
    for (;;) {
      const next = this.items.find((item) => item.status === "queued");
      if (!next || !this.canStart(next)) return;
      this.start(next);
    }
  }

  private canStart(item: TrackedCall): boolean {
    if (!item.info.concurrencySafe && !this.unsafeReleased) return false;
    const running = this.items.filter((other) => other.status === "running");
    if (running.length === 0) return true;
    return (
      item.info.concurrencySafe &&
      running.length < this.maxConcurrency &&
      running.every((other) => other.info.concurrencySafe)
    );
  }

  private start(item: TrackedCall) {
    item.status = "running";
    item.info.startedAt = now();
    item.info.queueMs = item.info.startedAt - item.info.queuedAt;
    item.info.batch = this.batchFor(item);
    this.events.toolStart(
      item.call.id,
      item.call.name,
      item.call.input,
      eventInfo(item.info),
    );

    item.promise = this.run(item).finally(() => this.processQueue());
  }

  private batchFor(item: TrackedCall): number {
    const previous = this.items
      .slice(0, item.index)
      .reverse()
      .find((candidate) => candidate.info.batch >= 0);
    if (!previous) return 0;
    if (
      item.info.concurrencySafe &&
      previous.info.concurrencySafe &&
      previous.status === "running"
    ) {
      return previous.info.batch;
    }
    return previous.info.batch + 1;
  }

  private async run(item: TrackedCall) {
    const { call, info } = item;
    if (this.signal?.aborted) {
      this.finish(item, interruptedResult(call.id));
      return;
    }

    try {
      const res = await this.registry.dispatch(
        call.name,
        call.input,
        this.ctx,
        this.signal,
      );
      this.finish(item, {
        id: call.id,
        content: res.text,
        isError: res.isError ?? false,
      });
    } catch (err: any) {
      this.finish(item, {
        id: call.id,
        content: `tool ${call.name} failed: ${err?.message ?? String(err)}`,
        isError: true,
      });
    }
  }

  private finish(item: TrackedCall, result: ScheduledToolResult) {
    item.info.endedAt = now();
    item.info.durationMs =
      item.info.startedAt === undefined ? 0 : item.info.endedAt - item.info.startedAt;
    item.result = result;
    item.status = "done";
    this.events.toolEnd(
      item.call.id,
      result.content,
      result.isError,
      eventInfo(item.info),
    );
  }
}

/**
 * Deterministic tool scheduler inspired by Claude Code's orchestration model:
 * consecutive concurrency-safe calls run in bounded parallel batches, while any
 * unsafe call is an exclusive barrier. Results are always returned in the
 * original model order, and every queued call receives a final result even when
 * the turn is aborted before it starts.
 */
export async function runScheduledTools(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  events: ToolSchedulerEvents,
  signal?: AbortSignal,
  options: ToolSchedulerOptions = {},
): Promise<ScheduledToolResult[]> {
  const scheduler = new StreamingToolScheduler(
    registry,
    ctx,
    events,
    signal,
    options,
  );
  return scheduler.waitFor(toolCalls);
}
