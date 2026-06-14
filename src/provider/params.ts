import type { ProviderRequestParams } from "./types.js";

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeParams(value: unknown): ProviderRequestParams {
  return isPlainRecord(value) ? { ...value } : {};
}

export function sanitizeModelParams(
  value: unknown,
): Record<string, ProviderRequestParams> {
  const out: Record<string, ProviderRequestParams> = {};
  if (!isPlainRecord(value)) return out;
  for (const [model, params] of Object.entries(value)) {
    const id = model.trim();
    if (!id) continue;
    out[id] = sanitizeParams(params);
  }
  return out;
}

export function paramsForModel(
  defaults: ProviderRequestParams,
  byModel: Record<string, ProviderRequestParams>,
  model: string,
): ProviderRequestParams {
  return { ...sanitizeParams(defaults), ...sanitizeParams(byModel[model]) };
}

export function applyRequestParams<T extends Record<string, any>>(
  base: T,
  params: ProviderRequestParams,
  protectedKeys: string[],
): T & ProviderRequestParams {
  const payload: Record<string, any> = { ...base };
  const protectedSet = new Set(protectedKeys);
  for (const [key, value] of Object.entries(sanitizeParams(params))) {
    if (protectedSet.has(key)) continue;
    payload[key] = value;
  }
  return payload as T & ProviderRequestParams;
}
