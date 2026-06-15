import type {
  NeutralMessage,
  Provider,
  StreamHandlers,
  StreamResult,
  ToolSpec,
} from "./types.js";

export const PROVIDER_RETRY_MAX_ATTEMPTS = 10;

export interface ProviderRetryInfo {
  attempt: number;
  maxAttempts: number;
  retryNumber: number;
  delayMs: number;
  error: any;
}

export interface ProviderRetryOptions {
  maxAttempts?: number;
  shouldRetry?: (err: any) => boolean;
  onRetry?: (info: ProviderRetryInfo) => void;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function isAbortError(err: any): boolean {
  return err?.name === "AbortError" || /abort/i.test(err?.message ?? "");
}

export function providerRetryDelayMs(retryNumber: number): number {
  const seconds = retryNumber <= 3 ? retryNumber : (retryNumber - 2) * 3;
  return seconds * 1000;
}

export async function streamWithProviderRetry(
  provider: Provider,
  system: string,
  messages: NeutralMessage[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
  opts: ProviderRetryOptions = {},
): Promise<StreamResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? PROVIDER_RETRY_MAX_ATTEMPTS);
  const delay = opts.delay ?? abortableDelay;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortError();

    let emitted = false;
    const trackingHandlers: StreamHandlers = {
      onText: (delta) => {
        emitted = true;
        handlers.onText(delta);
      },
      onReasoning: handlers.onReasoning
        ? (delta) => {
            emitted = true;
            handlers.onReasoning!(delta);
          }
        : undefined,
      onToolCallReady: handlers.onToolCallReady
        ? (toolCall) => {
            emitted = true;
            handlers.onToolCallReady!(toolCall);
          }
        : undefined,
    };

    try {
      return await provider.stream(system, messages, tools, trackingHandlers, signal);
    } catch (err) {
      if (
        isAbortError(err) ||
        emitted ||
        attempt >= maxAttempts ||
        opts.shouldRetry?.(err) === false
      ) {
        throw err;
      }

      const retryNumber = attempt;
      const delayMs = providerRetryDelayMs(retryNumber);
      opts.onRetry?.({ attempt, maxAttempts, retryNumber, delayMs, error: err });
      await delay(delayMs, signal);
      if (signal?.aborted) throw abortError();
    }
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const onAbort = () => done(abortError());

    function done(err?: Error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
