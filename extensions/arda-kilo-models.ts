/**
 * arda-kilo-models — minimal Kilo Code provider for pi.
 *
 * Only the auth (device-login flow) + model catalog are kept, so `/login` works
 * and all of Kilo's text models become selectable. No disk caching, no extras.
 *
 * Testable internals are exported (fetchKiloModels, login, refreshToken,
 * getApiKey, modifyModels, registerKilocodeProvider) so unit tests can drive
 * them with a mocked global fetch and a fake ExtensionAPI.
 */
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Endpoints (from pi-kilocode's lib/env.ts)
// ---------------------------------------------------------------------------
const KILO_API_BASE = "https://api.kilo.ai";
const KILO_GATEWAY_BASE_URL = `${KILO_API_BASE}/api/openrouter`;
const KILO_MODELS_URL = `${KILO_API_BASE}/api/gateway/models`;
const KILO_DEVICE_AUTH_CODES_URL = `${KILO_API_BASE}/api/device-auth/codes`;
const KILO_PROFILE_URL = `${KILO_API_BASE}/api/profile`;
const KILO_POLL_INTERVAL_MS = 3000;
const KILO_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const KILO_ORGANIZATION_HEADER = "X-KiloCode-OrganizationId";
/** Re-fetch the catalog at most once per hour. */
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

// Precompiled Regexes (avoid repeated runtime compilation)
const STACK_TRACE_REGEX = /\n\s+at\s+.*/g;
const URI_CREDENTIALS_REGEX = /([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^\s:]+:)([^@\s]+)(@)/g;
const KNOWN_TOKENS_REGEX = /\b(?:sk-[a-zA-Z0-9_\-]{20,}|ghp_[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_\-\.\/+=]{8,})\b/gi;
const SECRET_KV_REGEX = /(api[_-]?key|token|secret|password)([=:\s]+)(['"]?)([^\s'",;]{6,})\3/gi;
const INVALID_CONTROL_CHARS_REGEX = /[\r\n\0]/;

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------
interface KiloModel {
  id?: string;
  name?: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[] | null; output_modalities?: string[] | null } | null;
  pricing?: { prompt?: string | number | null; completion?: string | number | null; input_cache_read?: string | number | null; input_cache_write?: string | number | null } | null;
  supported_parameters?: string[] | null;
  top_provider?: { max_completion_tokens?: number | null } | null;
  max_completion_tokens?: number | null;
}

interface KiloProfile {
  user?: { email?: string; name?: string };
  email?: string;
  name?: string;
  organizations?: Array<{ id: string; name: string }>;
}

function isValidHttpUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== "string") return false;
  if (!urlStr.startsWith("https://") && !urlStr.startsWith("http://")) return false;
  try {
    const u = new URL(urlStr);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function sanitizeErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  let message = typeof err === "string" ? err : (err as any)?.message || String(err);
  message = message.replace(STACK_TRACE_REGEX, "");
  message = message.replace(URI_CREDENTIALS_REGEX, "$1***REDACTED***$3");
  message = message.replace(KNOWN_TOKENS_REGEX, "***REDACTED***");
  message = message.replace(SECRET_KV_REGEX, "$1$2$3***REDACTED***$3");
  return message.trim();
}

function parsePrice(v: string | number | undefined | null): number {
  if (v === undefined || v === null || v === 0 || v === "0") return 0;
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed || trimmed === "0") return 0;
    n = Number.parseFloat(trimmed);
  } else {
    return 0;
  }
  if (Number.isNaN(n) || !Number.isFinite(n) || n <= 0) return 0;
  // Prices from Kilo/OpenRouter are per token. Pi expects cost per 1M tokens.
  // Multiply by 1,000,000 and round to eliminate floating-point jitter (e.g. 0.15000000000000002 -> 0.15).
  return Math.round(n * 1_000_000 * 1e8) / 1e8;
}

export function toPiModel(m: KiloModel): ProviderModelConfig {
  if (!m || typeof m !== "object") {
    return {
      id: "unknown",
      name: "Unknown Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 8192,
      compat: { supportsStore: false },
    };
  }

  const params = m.supported_parameters;
  const supportsReasoning = Array.isArray(params) && params.includes("reasoning");
  const inputModalities = m.architecture?.input_modalities;
  const supportsImage = Array.isArray(inputModalities) && inputModalities.includes("image");

  const rawContextLen = m.context_length;
  const contextWindow =
    typeof rawContextLen === "number" && !Number.isNaN(rawContextLen) && rawContextLen > 0
      ? rawContextLen
      : 8192;

  const rawTopMax = m.top_provider?.max_completion_tokens;
  const rawModelMax = m.max_completion_tokens;
  const topMax = typeof rawTopMax === "number" && !Number.isNaN(rawTopMax) && rawTopMax > 0 ? rawTopMax : undefined;
  const modelMax = typeof rawModelMax === "number" && !Number.isNaN(rawModelMax) && rawModelMax > 0 ? rawModelMax : undefined;

  const maxOut = topMax ?? modelMax ?? Math.ceil(contextWindow * 0.2);
  const maxTokens = typeof maxOut === "number" && !Number.isNaN(maxOut) && maxOut > 0 ? maxOut : 8192;

  const pricing = m.pricing;
  return {
    id: m.id || "unknown",
    name: m.name || m.id || "Unknown Model",
    reasoning: supportsReasoning,
    input: supportsImage ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(pricing?.prompt),
      output: parsePrice(pricing?.completion),
      cacheRead: parsePrice(pricing?.input_cache_read),
      cacheWrite: parsePrice(pricing?.input_cache_write),
    },
    contextWindow,
    maxTokens,
    compat: {
      supportsStore: false,
      thinkingFormat: supportsReasoning ? "openrouter" : undefined,
    },
  };
}

/** Fetch Kilo's gateway catalog and map it to pi ProviderModelConfig[]. */
export async function fetchKiloModels(): Promise<ProviderModelConfig[]> {
  const res = await fetch(KILO_MODELS_URL, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Kilo models fetch failed: ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { data?: KiloModel[] };
  if (!data || !Array.isArray(data.data)) return [];
  return data.data
    .filter((m) => {
      if (!m || typeof m !== "object") return false;
      const out = Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : [];
      // Hide image-output-only models (no text generation).
      return !(out.includes("image") && !out.includes("text"));
    })
    .map(toPiModel);
}

// ---------------------------------------------------------------------------
// Device-auth login (from pi-kilocode's provider/oauth.ts)
// ---------------------------------------------------------------------------
interface DeviceAuthInit { code: string; verificationUrl: string; expiresIn: number }
type DeviceAuthPoll =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; token: string; userEmail: string };

async function fetchJson<T>(input: string, init?: RequestInit): Promise<{ response: Response; data: T }> {
  const response = await fetch(input, init);
  let data: T = undefined as T;
  try {
    if (response && typeof response.json === "function") {
      data = (await response.json()) as T;
    }
  } catch {
    data = undefined as T;
  }
  return { response, data };
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      reject(new Error("Login cancelled"));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function initiateDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthInit> {
  if (signal?.aborted) throw new Error("Login cancelled");
  let res: Response;
  let data: DeviceAuthInit;
  try {
    const fetched = await fetchJson<DeviceAuthInit>(KILO_DEVICE_AUTH_CODES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
    });
    res = fetched.response;
    data = fetched.data;
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") throw new Error("Login cancelled");
    throw err;
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error("Too many pending authorization requests. Please try again later.");
    throw new Error(`Failed to initiate device authorization: ${res.status}`);
  }
  if (!data || typeof data !== "object" || !data.code || !data.verificationUrl || !isValidHttpUrl(data.verificationUrl)) {
    throw new Error("Failed to initiate device authorization: malformed response");
  }
  return data;
}

async function pollDeviceAuth(code: string, signal?: AbortSignal): Promise<DeviceAuthPoll> {
  if (!code || typeof code !== "string" || INVALID_CONTROL_CHARS_REGEX.test(code)) {
    throw new Error("Invalid device auth code");
  }
  if (signal?.aborted) throw new Error("Login cancelled");
  let res: Response;
  let data: DeviceAuthPoll;
  try {
    const fetched = await fetchJson<DeviceAuthPoll>(`${KILO_DEVICE_AUTH_CODES_URL}/${encodeURIComponent(code)}`, { signal });
    res = fetched.response;
    data = fetched.data;
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") throw new Error("Login cancelled");
    throw err;
  }
  if (res.status === 202) return { status: "pending" };
  if (res.status === 403) return { status: "denied" };
  if (res.status === 410) return { status: "expired" };
  if (!res.ok) throw new Error(`Failed to poll device authorization: ${res.status}`);
  if (!data || typeof data !== "object" || !("status" in data)) {
    throw new Error("Malformed polling response from device authorization");
  }
  return data;
}

async function fetchProfile(token: string, signal?: AbortSignal): Promise<KiloProfile> {
  if (!token || typeof token !== "string" || INVALID_CONTROL_CHARS_REGEX.test(token)) {
    throw new Error("Invalid token");
  }
  if (signal?.aborted) throw new Error("Login cancelled");
  let res: Response;
  let data: KiloProfile;
  try {
    const fetched = await fetchJson<KiloProfile>(KILO_PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal,
    });
    res = fetched.response;
    data = fetched.data;
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") throw new Error("Login cancelled");
    throw err;
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Invalid token");
    throw new Error(`Failed to fetch profile: ${res.status}`);
  }
  return data ?? {};
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  if (!callbacks || typeof callbacks.onAuth !== "function") {
    throw new Error("OAuth callbacks missing or invalid");
  }
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");

  const authData = await initiateDeviceAuth(callbacks.signal);
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");

  callbacks.onAuth({
    url: authData.verificationUrl,
    instructions: `Open ${authData.verificationUrl} and enter code: ${authData.code}`,
  });

  const expiresIn = typeof authData.expiresIn === "number" && authData.expiresIn > 0 ? authData.expiresIn : 300;
  const deadline = Date.now() + expiresIn * 1000;
  let token = "";
  let userEmail = "";
  while (Date.now() < deadline) {
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");
    const result = await pollDeviceAuth(authData.code, callbacks.signal);
    if (result.status === "approved") {
      if (!result.token) throw new Error("Authorization approved but token missing");
      token = result.token;
      userEmail = result.userEmail || "";
      break;
    }
    if (result.status === "denied") throw new Error("Authorization denied by user");
    if (result.status === "expired") throw new Error("Authorization code expired");
    callbacks.onProgress?.("Waiting for browser authorization...");
    await abortableSleep(KILO_POLL_INTERVAL_MS, callbacks.signal);
  }
  if (!token) throw new Error("Authentication timed out. Please try again.");

  let profile: KiloProfile = {};
  try {
    profile = await fetchProfile(token, callbacks.signal);
  } catch (err: any) {
    if (callbacks.signal?.aborted) throw new Error("Login cancelled");
    // If profile fetch fails, continue with available userEmail
  }
  if (callbacks.signal?.aborted) throw new Error("Login cancelled");

  const email = profile?.user?.email ?? profile?.email ?? (userEmail || undefined);
  const name = profile?.user?.name ?? profile?.name;

  let accountId: string | undefined;
  const orgs = profile?.organizations;
  if (Array.isArray(orgs) && orgs.length > 0 && callbacks.onPrompt) {
    try {
      const validOrgs = orgs.filter((o) => o && typeof o.name === "string" && o.name.trim());
      if (validOrgs.length > 0) {
        const opts = ["0. Personal Account", ...validOrgs.map((o, i) => `${i + 1}. ${o.name}`)].join("\n");
        const promptRes = await callbacks.onPrompt({ message: `Select account:\n${opts}`, placeholder: "0", allowEmpty: true });
        const choice = (typeof promptRes === "string" ? promptRes : "")?.trim();
        if (choice && choice !== "0") {
          const idx = Number.parseInt(choice, 10);
          if (!Number.isNaN(idx) && idx >= 1 && idx <= validOrgs.length) {
            accountId = validOrgs[idx - 1]?.id;
          }
        }
      }
    } catch {
      // onPrompt cancellation or error falls back to personal account
    }
  }

  return {
    refresh: token,
    access: token,
    expires: Date.now() + KILO_TOKEN_TTL_MS,
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
  };
}

export async function refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!credentials || (!credentials.access && !credentials.refresh)) {
    throw new Error("Invalid credentials: missing access or refresh token");
  }
  if (signal?.aborted) throw new Error("Token refresh cancelled");
  const token = String(credentials.access || credentials.refresh);
  await fetchProfile(token, signal); // throws on invalid token
  return { ...credentials, refresh: String(credentials.refresh || token), access: token, expires: Date.now() + KILO_TOKEN_TTL_MS };
}

export function getApiKey(credentials: OAuthCredentials): string {
  if (!credentials) return "";
  return String(credentials.access || credentials.refresh || "");
}

export function modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
  if (!Array.isArray(models) || models.length === 0) return [];
  if (!credentials || typeof credentials !== "object") return models;
  const accountId = credentials["accountId"];
  const orgId = typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
  if (!orgId || INVALID_CONTROL_CHARS_REGEX.test(orgId)) return models;

  let hasKiloModel = false;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    if (m && typeof m === "object" && m.provider === "kilocode") {
      hasKiloModel = true;
      break;
    }
  }
  if (!hasKiloModel) return models;

  return models.map((m) => {
    if (!m || typeof m !== "object") return m;
    return m.provider !== "kilocode" ? m : { ...m, headers: { ...(m.headers || {}), [KILO_ORGANIZATION_HEADER]: orgId } };
  });
}

// ---------------------------------------------------------------------------
// Registration (with a small in-memory catalog cache + de-duplicated refresh)
// ---------------------------------------------------------------------------
function buildConfig(models: ProviderModelConfig[]) {
  return {
    baseUrl: KILO_GATEWAY_BASE_URL,
    apiKey: "KILO_API_KEY",
    api: "openai-completions" as Api,
    authHeader: false,
    headers: { "X-KILOCODE-EDITORNAME": "pi" },
    models,
    oauth: { name: "Kilo Code", login, refreshToken, getApiKey, modifyModels },
  };
}

let cachedModels: ProviderModelConfig[] = [];
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

function refresh(pi: ExtensionAPI, notify?: (msg: string) => void): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    // Fresh cache: just make sure the provider is registered with it.
    if (cachedModels.length && Date.now() - cachedAt < MODELS_CACHE_TTL_MS) {
      pi.registerProvider("kilocode", buildConfig(cachedModels));
      return;
    }
    try {
      const models = await fetchKiloModels();
      cachedModels = models;
      cachedAt = Date.now();
      pi.registerProvider("kilocode", buildConfig(models));
    } catch (err) {
      if (cachedModels.length) {
        pi.registerProvider("kilocode", buildConfig(cachedModels));
      } else if (notify) {
        notify(`Kilo models unavailable: ${sanitizeErrorMessage(err)}`);
      }
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function registerKilocodeProvider(pi: ExtensionAPI): void {
  // Register immediately (no models yet) so /login is available even offline.
  pi.registerProvider("kilocode", buildConfig([]));
  void refresh(pi);
  pi.on("session_start", (_event, ctx) => refresh(pi, (m) => ctx.ui.notify(m, "warning")));
}

export default registerKilocodeProvider;
