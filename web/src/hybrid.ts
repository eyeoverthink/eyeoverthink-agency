/**
 * Firebase AI Logic hybrid inference — the agency's edge tier.
 * Imported and called at runtime: initializeApp, initializeAppCheck, getAI, getGenerativeModel with an
 * official InferenceMode, initializeDeviceModel() after a user gesture, generateContent(), and
 * response.inferenceSource (ON_DEVICE | IN_CLOUD).
 * https://firebase.google.com/docs/ai-logic/hybrid/web/get-started
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type AI, type GenerativeModel } from "firebase/ai";

export type ModeName = "prefer_on_device" | "only_on_device" | "prefer_in_cloud" | "only_in_cloud";
export type Source = "ON_DEVICE" | "IN_CLOUD" | "UNKNOWN";

const PLACEHOLDER = /^YOUR_/;

export function missingConfig(): string[] {
  const env = import.meta.env;
  const required: Array<[string, string | undefined]> = [
    ["VITE_FIREBASE_API_KEY", env.VITE_FIREBASE_API_KEY],
    ["VITE_FIREBASE_PROJECT_ID", env.VITE_FIREBASE_PROJECT_ID],
    ["VITE_FIREBASE_APP_ID", env.VITE_FIREBASE_APP_ID],
    ["VITE_RECAPTCHA_SITE_KEY", env.VITE_RECAPTCHA_SITE_KEY],
  ];
  return required.filter(([, v]) => !v || PLACEHOLDER.test(v)).map(([k]) => k);
}
export const isConfigured = () => missingConfig().length === 0;
export const isLocalhost = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
/** Public identifiers only (no keys): which Firebase project and cloud model this build calls. */
export const edgeIdentity = () => ({ project: import.meta.env.VITE_FIREBASE_PROJECT_ID || null, cloudModel: import.meta.env.VITE_CLOUD_MODEL || "gemini-3.5-flash-lite" });

/** Hex SHA-256 of a string (for ledger attestations: proves which output existed without storing it). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Translate the common first-call failures into the fix. */
export function explainFirebaseError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Checked first: the api-not-enabled message mentions App Check-like words in its URL text.
  if (/api-not-enabled|not been used|SERVICE_DISABLED|requires the Firebase AI API/i.test(msg)) return `${msg} → Open Firebase console > AI Logic > Get started and choose the Gemini Developer API, wait a few minutes, then retry.`;
  if (/serviceUsageConsumer|serviceusage\.services\.use/i.test(msg)) return `${msg} → This usually means Firebase's permissions are still spreading after you turned on AI Logic. Wait a few minutes and retry; if it lasts past about 15 minutes, check the Firebase service agents on the project's IAM page (see docs/FIREBASE_SETUP.md).`;
  if (/app-check|appCheck|AppCheck|403/.test(msg)) return `${msg} → App Check rejected this browser. On localhost, copy the debug token printed in the console into Firebase console > App Check > Manage debug tokens, or add localhost to your reCAPTCHA key's domains.`;
  if (/API key not valid|api-key-not-valid|invalid-api-key/i.test(msg)) return `${msg} → The API key is wrong or restricted. Recopy VITE_FIREBASE_API_KEY and rebuild.`;
  if (/not been used|disabled|SERVICE_DISABLED|Firebase AI Logic/i.test(msg)) return `${msg} → Enable Firebase AI Logic (Gemini Developer API) in the Firebase console > AI Logic > Get started.`;
  if (/on-device|LanguageModel|not available/i.test(msg)) return `${msg} → Gemini Nano is not available in this browser; use prefer_on_device or a cloud mode, or click "Prepare on-device model" in Chrome 139+.`;
  return msg;
}

let app: FirebaseApp | null = null;
let ai: AI | null = null;
const models = new Map<ModeName, GenerativeModel>();

function init(): AI {
  if (ai) return ai;
  if (!isConfigured()) throw new Error(`Firebase AI Logic is not configured (missing ${missingConfig().join(", ")}). Copy web/.env.example to web/.env.local.`);
  const env = import.meta.env;
  app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET, messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID, appId: env.VITE_FIREBASE_APP_ID,
  });
  // Debug App Check on localhost only: the Vite dev server AND the built dashboard served by the agency on localhost.
  // The SDK prints a debug token in the console; it works only after you safelist it in the Firebase console.
  if (env.VITE_APPCHECK_DEBUG === "true" && (import.meta.env.DEV || isLocalhost())) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const provider = (env.VITE_APPCHECK_PROVIDER || "recaptcha-enterprise").toLowerCase() === "recaptcha-v3"
    ? new ReCaptchaV3Provider(env.VITE_RECAPTCHA_SITE_KEY)
    : new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_SITE_KEY);
  initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
  ai = getAI(app, { backend: new GoogleAIBackend() });
  return ai;
}

function modeOf(name: ModeName): InferenceMode {
  switch (name) {
    case "only_on_device": return InferenceMode.ONLY_ON_DEVICE;
    case "prefer_in_cloud": return InferenceMode.PREFER_IN_CLOUD;
    case "only_in_cloud": return InferenceMode.ONLY_IN_CLOUD;
    default: return InferenceMode.PREFER_ON_DEVICE;
  }
}

export function model(mode: ModeName): GenerativeModel {
  const cached = models.get(mode);
  if (cached) return cached;
  const m = getGenerativeModel(init(), {
    mode: modeOf(mode),
    inCloudParams: { model: import.meta.env.VITE_CLOUD_MODEL || "gemini-3.5-flash-lite", generationConfig: { temperature: 0.4, maxOutputTokens: 2048 } },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
    },
  });
  models.set(mode, m);
  return m;
}

/** Must be called from a user gesture (Chrome requirement) before on-device generation. */
export async function prepareOnDevice(onProgress: (pct: number) => void): Promise<void> {
  const m = model("prefer_on_device");
  await m.initializeDeviceModel((v: number) => onProgress(Math.round(v * 1000) / 10));
}

export type ChatMessage = { role: string; content: string };

/**
 * On-device inference is single-turn, so a conversation is flattened into one prompt.
 * Returns the text and which path actually ran.
 */
export async function generate(messages: ChatMessage[], mode: ModeName, json = false): Promise<{ text: string; source: Source }> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system").map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n\n");
  const prompt = `${system ? `${system}\n\n` : ""}${turns}${json ? "\n\nReply with a single JSON object only." : ""}\n\nAssistant:`;
  const result = await model(mode).generateContent(prompt);
  const response = result.response;
  return { text: response.text(), source: normalizeSource((response as unknown as { inferenceSource?: string }).inferenceSource) };
}

/** The SDK's InferenceSource values are lowercase ('on_device' | 'in_cloud'); the agency and ledger use upper case. */
export function normalizeSource(src: unknown): Source {
  const s = String(src ?? "").toUpperCase();
  return s === "ON_DEVICE" || s === "IN_CLOUD" ? s : "UNKNOWN";
}

export function promptApiPresent(): boolean {
  return typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== "undefined";
}

/**
 * Whether Gemini Nano can actually run here. The LanguageModel object can exist while the model is
 * "unavailable" (hardware, flags, or policy), so presence alone overstates on-device capability.
 * Returns "available" | "downloadable" | "downloading" | "unavailable".
 */
export async function nanoAvailability(): Promise<string> {
  const LM = (globalThis as { LanguageModel?: { availability: (o?: unknown) => Promise<string> } }).LanguageModel;
  if (!LM) return "unavailable";
  try { return await LM.availability({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] }); } catch { return "unavailable"; }
}

export function chromeDesktopOk(): boolean {
  const ua = navigator.userAgent;
  const v = Number(ua.match(/Chrome\/(\d+)/)?.[1] || 0);
  return v >= 139 && !/Edg\/|OPR\/|Mobile|Android/i.test(ua);
}
