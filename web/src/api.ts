// Typed-enough client for the agency API. The token lives in localStorage (per-browser convenience).

const TOKEN_KEY = "eot.agency.token";

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t: string): void {
  try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch { /* storage blocked */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: { authorization: `Bearer ${getToken()}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}`);
  return data as T;
}

export type AgencyEvent = { type: string; ts: number; [k: string]: any };

/** Server-sent events with automatic reconnect. */
export function subscribe(onEvent: (e: AgencyEvent) => void, onState: (ok: boolean) => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  const connect = () => {
    if (stopped) return;
    es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
    es.onopen = () => { retry = 1000; onState(true); };
    es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
    es.onerror = () => {
      onState(false);
      es?.close();
      setTimeout(connect, retry);
      retry = Math.min(15000, retry * 2);
    };
  };
  connect();
  return () => { stopped = true; es?.close(); };
}
