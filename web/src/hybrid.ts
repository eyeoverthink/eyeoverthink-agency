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
  if (import.meta.env.DEV && env.VITE_APPCHECK_DEBUG === "true") self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
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
  const src = (response as unknown as { inferenceSource?: string }).inferenceSource;
  return { text: response.text(), source: src === "ON_DEVICE" || src === "IN_CLOUD" ? src : "UNKNOWN" };
}

export function promptApiPresent(): boolean {
  return typeof (globalThis as { LanguageModel?: unknown }).LanguageModel !== "undefined";
}

export function chromeDesktopOk(): boolean {
  const ua = navigator.userAgent;
  const v = Number(ua.match(/Chrome\/(\d+)/)?.[1] || 0);
  return v >= 139 && !/Edg\/|OPR\/|Mobile|Android/i.test(ua);
}
