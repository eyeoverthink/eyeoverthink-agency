import "./style.css";
import { api, getToken, setToken, subscribe, ApiError, type AgencyEvent } from "./api";
import { md, esc } from "./md";
import { isConfigured, missingConfig, prepareOnDevice, generate, nanoAvailability, chromeDesktopOk, edgeIdentity, sha256Hex, explainFirebaseError, type ModeName } from "./hybrid";
import { EdgeWorker } from "./edge";
import { viewMap, mapEvent } from "./map";
// The exact zero-dependency verifier the CLI uses: the dashboard verifies receipts in the browser, never via the server.
// @ts-ignore -- plain ES module shared with Node (src/core/receipt-verify.js)
import { verifyReceipt } from "../../src/core/receipt-verify.js";

type View = "missions" | "map" | "agents" | "memory" | "workflows" | "ledger" | "approvals" | "models" | "edge" | "lab";
const VIEWS: Array<[View, string, string]> = [
  ["missions", "Mission Control", "◎"], ["map", "Sovereignty Map", "◍"], ["agents", "Agents & DNA", "⌬"], ["memory", "Memory & Graph", "◈"], ["workflows", "Workflows", "⇶"],
  ["approvals", "Approvals", "✋"], ["ledger", "Ledger", "⛓"], ["models", "Models", "⚙"], ["edge", "Hybrid Edge", "◐"], ["lab", "Lab", "⚗"],
];

const app = document.querySelector<HTMLDivElement>("#app")!;
const S = {
  view: (location.hash.slice(1) as View) || "missions",
  connected: false,
  status: null as any,
  events: [] as AgencyEvent[],
  missions: [] as any[],
  mission: null as any,
  trace: [] as any[],
  pending: 0,
  toast: "",
  streams: new Map<string, { text: string; done: boolean; missionId?: string; at: number }>(),
  askAgent: "" as string,
  evoJob: "" as string,
  edgeLast: null as null | { text: string; source: string; latencyMs: number; seq: number | null },
};
const edge = new EdgeWorker(() => { if (S.view === "edge") renderView(); });

// ---------------- helpers ----------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const val = (sel: string) => ($<HTMLInputElement>(sel)?.value ?? "").trim();
const ago = (iso: string) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const pill = (status: string) => `<span class="pill s-${esc(status)}">${esc(status)}</span>`;
const score = (x: number | null | undefined) => (x == null ? "–" : `<span class="score" style="--v:${Math.round(x * 100)}">${x.toFixed(2)}</span>`);

function toast(msg: string, bad = false) {
  S.toast = msg;
  const t = $("#toast");
  if (t) { t.textContent = msg; t.className = `toast show ${bad ? "bad" : ""}`; setTimeout(() => t.classList.remove("show"), 3800); }
}

async function guard<T>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) { renderTokenGate(); return undefined; }
    toast(e instanceof Error ? e.message : String(e), true);
    return undefined;
  }
}

function busy(btn: HTMLButtonElement | null, on: boolean, label?: string) {
  if (!btn) return;
  // Keep the ORIGINAL label across chained busy() calls (e.g. "Sealing…" then "Firebase…"), so restore is correct.
  if (on) { if (btn.dataset.label === undefined) btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label || "Working…"}`; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.label ?? btn.innerHTML; delete btn.dataset.label; }
}

// ---------------- shell ----------------
function renderShell() {
  app.innerHTML = `
  <aside class="nav">
    <div class="brand"><div class="logo"><span></span></div><div><b>EyeOverThink</b><small>Agency</small></div></div>
    <nav>${VIEWS.map(([v, label, icon]) => `<a href="#${v}" data-view="${v}" class="${S.view === v ? "on" : ""}"><i>${icon}</i>${label}${v === "approvals" ? `<em id="badge" class="${S.pending ? "" : "hide"}">${S.pending}</em>` : ""}</a>`).join("")}</nav>
    <div class="navfoot">
      <div id="conn" class="conn ${S.connected ? "ok" : ""}"><span></span>${S.connected ? "live" : "offline"}</div>
      <div id="ident" class="mono dim">${esc(S.status?.identity?.fingerprint || "")}</div>
    </div>
  </aside>
  <main><div id="view"></div></main>
  <div id="toast" class="toast"></div>`;
  $$("nav a").forEach((a) => a.addEventListener("click", () => { S.view = a.dataset.view as View; $$("nav a").forEach((x) => x.classList.toggle("on", x === a)); renderView(); }));
}

function renderTokenGate() {
  app.innerHTML = `<div class="gate"><div class="card">
    <div class="brand big"><div class="logo"><span></span></div><div><b>EyeOverThink Agency</b><small>Sovereign mission control</small></div></div>
    <p>Paste the API token from <code>data/api-token</code> (or run <code>node bin/agency.js token</code>).</p>
    <input id="tok" type="password" placeholder="API token" autocomplete="off" />
    <button id="tokgo" class="primary">Connect</button>
  </div></div>`;
  const go = async () => { setToken(val("#tok")); await boot(); };
  $("#tokgo")!.addEventListener("click", go);
  $("#tok")!.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void go(); });
}

// ---------------- live events ----------------
function onEvent(e: AgencyEvent) {
  if (S.view === "map") mapEvent(e);
  if (e.type === "agent.stream") return onStream(e);
  if (e.type === "evolution.progress") return onEvoProgress(e);
  if (e.type === "evolution.done" && e.jobId === S.evoJob) void showEvoResult(e.jobId);
  S.events.push(e);
  if (S.events.length > 400) S.events.splice(0, S.events.length - 400);
  if (e.type === "approval.request" || e.type === "approval.decide") void refreshPending();
  if (S.view === "missions") {
    if (["mission.created", "mission.status", "mission.plan", "task.status", "task.critique"].includes(e.type)) scheduleMissionRefresh(e.missionId);
    appendLog(e);
  }
  if (S.view === "ledger" && e.type === "ledger") void renderView();
}

/** Make a streaming JSON turn readable: show the "thought" (and tool or final) as they arrive. */
function readableStream(raw: string): string {
  const grab = (key: string) => {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`));
    return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
  };
  const thought = grab("thought"), tool = grab("tool"), final = grab("final");
  if (!thought && !tool && !final) return raw.slice(-700);
  return [thought && `💭 ${thought}`, tool && `🔧 ${tool}`, final && `✅ ${final.slice(-500)}`].filter(Boolean).join("\n");
}

let streamPaint: number | undefined;
function onStream(e: AgencyEvent) {
  const key = String(e.agentId);
  const cur = S.streams.get(key) || { text: "", done: false, at: Date.now() };
  if (e.reset) { cur.text = ""; cur.done = false; }
  if (e.delta) cur.text = (cur.text + e.delta).slice(-4000);
  if (e.done) cur.done = true;
  cur.missionId = e.missionId;
  cur.at = Date.now();
  S.streams.set(key, cur);
  // setTimeout, not requestAnimationFrame: rAF is paused in background tabs, which would freeze the panel.
  if (streamPaint === undefined) streamPaint = window.setTimeout(() => { streamPaint = undefined; drawStreams(); }, 100);
}

function drawStreams() {
  const box = $("#streams");
  if (box && S.mission) {
    const live = [...S.streams.entries()].filter(([, s]) => s.missionId === S.mission.id && (!s.done || Date.now() - s.at < 4000));
    box.innerHTML = live.length ? live.map(([id, s]) => `<div class="stream ${s.done ? "fin" : ""}"><b>${esc(id)}</b>${s.done ? "" : '<span class="spin"></span>'}<pre>${esc(readableStream(s.text))}</pre></div>`).join("") : "";
    box.classList.toggle("hide", live.length === 0);
  }
  const dlg = $("#dlgstream");
  if (dlg && S.askAgent) {
    const s = S.streams.get(S.askAgent);
    dlg.textContent = s && !s.missionId ? readableStream(s.text) : "";
  }
}

let refreshTimer: number | undefined;
function scheduleMissionRefresh(id?: string) {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(async () => {
    S.missions = (await guard(() => api<any[]>("/api/missions?limit=40"))) || S.missions;
    if (S.mission && (!id || id === S.mission.id)) await loadMission(S.mission.id, false);
    drawMissionList();
    drawMissionDetail();
  }, 250);
}

function describe(e: AgencyEvent): string | null {
  switch (e.type) {
    case "mission.plan": return `Genesis planned ${e.plan.tasks.length} task(s): ${e.plan.tasks.map((t: any) => `${t.title} → ${t.agent}`).join(" · ")}`;
    case "task.status": return `${e.agentId || ""} ${e.status}${e.score != null ? ` (score ${e.score})` : ""}: ${e.title || e.taskId?.split(":").pop()}`;
    case "task.critique": return `Solon critique attempt ${e.attempt}: ${e.score} ${e.pass ? "PASS" : "→ retry with fixes"}`;
    case "tool.result": return `${e.agentId} used ${e.tool} ${e.ok ? "✓" : "✗"} ${e.ms ? `${e.ms}ms` : ""}${e.error ? ` ${e.error}` : ""}`;
    case "router.fallback": return `router fallback from ${e.from}`;
    case "mission.status": return `mission ${e.status}${e.score != null ? ` · score ${e.score}` : ""}`;
    case "mission.replan": return `replanning: ${e.reason}`;
    case "approval.request": return `approval needed for ${e.tool}`;
    case "logic_chain.stage": return `logic chain ${e.stage} ${e.ok ? "✓" : "✗"} (${e.model || "-"})`;
    case "consensus.answer": return `${e.agent} answered`;
    case "edge.job": return `edge job ${e.status}${e.inferenceSource ? ` · ${e.inferenceSource}` : ""}`;
    default: return null;
  }
}

function appendLog(e: AgencyEvent) {
  const log = $("#log");
  if (!log || (S.mission && e.missionId && e.missionId !== S.mission.id)) return;
  const text = describe(e);
  if (!text) return;
  const row = document.createElement("div");
  row.className = `logrow t-${e.type.replace(".", "-")}`;
  row.innerHTML = `<time>${new Date(e.ts).toLocaleTimeString()}</time><span>${esc(text)}</span>`;
  log.prepend(row);
  while (log.children.length > 200) log.lastChild?.remove();
}

async function refreshPending() {
  const list = await guard(() => api<any[]>("/api/approvals"));
  S.pending = list?.length || 0;
  const b = $("#badge");
  if (b) { b.textContent = String(S.pending); b.classList.toggle("hide", !S.pending); }
}

// ---------------- views ----------------
async function renderView() {
  location.hash = S.view;
  const v = $("#view");
  if (!v) return;
  const map: Record<View, () => Promise<void>> = { missions: viewMissions, map: () => viewMap($("#view")!, header), agents: viewAgents, memory: viewMemory, workflows: viewWorkflows, ledger: viewLedger, approvals: viewApprovals, models: viewModels, edge: viewEdge, lab: viewLab };
  await map[S.view]();
}

function header(title: string, sub: string, extra = "") {
  return `<header class="vh"><div><h1>${title}</h1><p>${sub}</p></div><div class="vh-x">${extra}</div></header>`;
}

// ===== Mission Control =====
async function viewMissions() {
  const st = S.status;
  $("#view")!.innerHTML = `
    ${header("Mission Control", "Give the agency a goal. Genesis plans, specialists execute in parallel, Solon verifies every result, failures self-heal, and everything is signed into the ledger.")}
    <section class="stats">
      ${[["Agents", st?.counts?.agents], ["Missions", st?.counts?.missions], ["Memories", st?.counts?.memories], ["Ledger entries", st?.counts?.ledger], ["Edge workers", st?.edge?.workers?.length ?? 0]].map(([k, v]) => `<div class="stat"><b>${v ?? "–"}</b><span>${k}</span></div>`).join("")}
    </section>
    <section class="panel launch">
      <textarea id="goal" rows="3" placeholder="e.g. Research the three best free local text-to-speech engines for Windows, compare quality and speed, and recommend one with install steps."></textarea>
      <div class="row">
        <label>Mode <select id="mode"><option value="standard">Standard — plan, execute, verify</option><option value="logic_chain">Logic Chain — 8-role design relay + review vote</option><option value="consensus">Consensus — independent answers, Kuramoto clustering</option></select></label>
        <label class="check">Privacy <select id="privacy"><option value="normal">normal</option><option value="sealed">sealed: cloud allowed, sensitive values withheld by the membrane</option><option value="private">private: local GPU / on-device only</option></select></label>
        <button id="launch" class="primary">Launch mission</button>
      </div>
    </section>
    <div class="split">
      <section class="panel"><h2>Missions</h2><div id="mlist" class="mlist"></div></section>
      <section class="panel detail"><div id="mdetail"><p class="dim">Select a mission to see its task graph, live log, trace and deliverable.</p></div></section>
    </div>`;
  $("#launch")!.addEventListener("click", async (ev) => {
    const goal = val("#goal");
    if (!goal) return toast("Write a goal first", true);
    const btn = ev.currentTarget as HTMLButtonElement;
    busy(btn, true, "Launching…");
    const m = await guard(() => api("/api/missions", { body: { goal, mode: val("#mode"), privacy: val("#privacy") || "normal" } }));
    busy(btn, false);
    if (m) { ($<HTMLTextAreaElement>("#goal")!).value = ""; await loadMission(m.id); scheduleMissionRefresh(); }
  });
  S.missions = (await guard(() => api<any[]>("/api/missions?limit=40"))) || [];
  drawMissionList();
  if (S.mission) await loadMission(S.mission.id); else if (S.missions[0]) await loadMission(S.missions[0].id);
}

function drawMissionList() {
  const el = $("#mlist");
  if (!el) return;
  el.innerHTML = S.missions.length ? S.missions.map((m) => `<button class="mitem ${S.mission?.id === m.id ? "on" : ""}" data-id="${m.id}"><div>${pill(m.status)} ${score(m.score)}</div><p>${esc(m.goal.slice(0, 140))}</p><small>${ago(m.created)}</small></button>`).join("") : `<p class="dim">No missions yet.</p>`;
  $$(".mitem", el).forEach((b) => b.addEventListener("click", () => loadMission(b.dataset.id!)));
}

async function loadMission(id: string, redraw = true) {
  const m = await guard(() => api(`/api/missions/${id}`));
  if (!m) return;
  S.mission = m;
  S.trace = (await guard(() => api<any[]>(`/api/missions/${id}/trace`))) || [];
  if (redraw) { drawMissionList(); drawMissionDetail(); }
}

function dagSvg(tasks: any[]): string {
  if (!tasks.length) return "";
  const live = tasks.filter((t) => t.status !== "abandoned");
  const depth = new Map<string, number>();
  const d = (t: any): number => {
    if (depth.has(t.id)) return depth.get(t.id)!;
    const ds = t.deps.map((x: string) => live.find((y) => y.id === x)).filter(Boolean).map(d);
    const v = ds.length ? Math.max(...ds) + 1 : 0;
    depth.set(t.id, v);
    return v;
  };
  live.forEach(d);
  const cols: any[][] = [];
  for (const t of live) (cols[depth.get(t.id)!] ||= []).push(t);
  const W = 190, H = 64, GX = 60, GY = 18;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => col.forEach((t, ri) => pos.set(t.id, { x: 10 + ci * (W + GX), y: 10 + ri * (H + GY) })));
  const width = 20 + cols.length * (W + GX) - GX, height = 20 + Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const edges = live.flatMap((t) => t.deps.filter((x: string) => pos.has(x)).map((x: string) => {
    const a = pos.get(x)!, b = pos.get(t.id)!;
    return `<path d="M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x},${b.y + H / 2}" class="edge"/>`;
  }));
  const nodes = live.map((t) => {
    const p = pos.get(t.id)!;
    return `<g class="node s-${t.status}" transform="translate(${p.x},${p.y})"><rect width="${W}" height="${H}" rx="10"/><text x="12" y="22" class="agent">${esc(t.agent_id)}</text><text x="12" y="42">${esc(t.title.slice(0, 26))}</text><text x="12" y="57" class="meta">${esc(t.status)}${t.score != null ? ` · ${t.score.toFixed(2)}` : ""}${t.attempts > 1 ? ` · ${t.attempts} tries` : ""}${t.privacy === "private" ? " · 🔒" : t.privacy === "sealed" ? " · 🛡" : ""}</text></g>`;
  });
  return `<div class="dag"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${edges.join("")}${nodes.join("")}</svg></div>`;
}

function waterfall(spans: any[]): string {
  if (!spans.length) return `<p class="dim">No trace yet.</p>`;
  const t0 = Math.min(...spans.map((s) => s.start_ms));
  const t1 = Math.max(...spans.map((s) => s.end_ms || Date.now()));
  const total = Math.max(1, t1 - t0);
  return `<div class="wf">${spans.slice(0, 160).map((s) => {
    const left = ((s.start_ms - t0) / total) * 100, w = Math.max(0.4, (((s.end_ms || Date.now()) - s.start_ms) / total) * 100);
    return `<div class="wfrow k-${s.kind}" title="${esc(s.name)} ${s.status} ${(s.end_ms || Date.now()) - s.start_ms}ms"><span>${esc(s.name.slice(0, 34))}</span><div><i style="left:${left}%;width:${w}%" class="st-${s.status}"></i></div></div>`;
  }).join("")}</div>`;
}

function drawMissionDetail() {
  const el = $("#mdetail");
  const m = S.mission;
  if (!el || !m) return;
  const r = m.result;
  const active = !["completed", "failed", "cancelled"].includes(m.status);
  const deliverable = r?.deliverable ? `<div class="row receiptbar"><button class="ghost small" data-receipt="${esc(m.id)}">Download receipt</button><button class="ghost small" data-deltext="${esc(m.id)}">Download deliverable text</button><span class="dim">A signed, offline-verifiable record of how this was produced.</span></div><div class="deliverable md">${md(r.deliverable)}</div>` : active ? `<p class="dim"><span class="spin"></span> The team is working…</p>` : m.error ? `<div class="warn">${esc(m.error)}</div>` : "";
  const extras = r?.logicChain ? `<details><summary>Logic chain ledger & review</summary><pre>${esc(JSON.stringify({ stages: r.logicChain.stages, open: r.logicChain.review.open.map((o: any) => o.text), dismissed: r.logicChain.review.dismissed.length, voters: r.logicChain.review.voters }, null, 2))}</pre></details>` :
    r?.consensus ? `<details open><summary>Consensus · coherence R = ${r.consensus.r}</summary><p>Clusters: ${r.consensus.clusters.map((c: string[]) => `[${c.join(", ")}]`).join(" ")}</p></details>` : "";
  el.innerHTML = `
    <div class="mhead"><div>${pill(m.status)} ${score(m.score)} <span class="dim">${esc(m.options.mode)} · ${m.options.privacy} · ${m.replans} replan(s)</span></div>
      ${active ? `<button id="cancel" class="ghost small">Cancel</button>` : ""}</div>
    <h3 class="goal">${esc(m.goal)}</h3>
    ${m.plan?.summary ? `<p class="dim">${esc(m.plan.summary)}${m.plan.fallback ? " (fallback plan)" : ""}</p>` : ""}
    ${dagSvg(m.tasks)}
    <div id="streams" class="streams hide"></div>
    <div class="tabs"><button data-t="deliv" class="on">Deliverable</button><button data-t="log">Live log</button><button data-t="trace">Trace (${S.trace.length})</button><button data-t="tasks">Tasks</button></div>
    <div class="tab" data-t="deliv">${deliverable}${r?.security ? `<p class="sec risk-${esc(r.security.risk)}">Sentinel risk: <b>${esc(r.security.risk)}</b>${(r.security.findings || []).length ? ` — ${esc(r.security.findings.join("; "))}` : ""}</p>` : ""}${r?.finalCritique ? `<p class="dim">Final critique ${r.finalCritique.score}${r.finalCritique.defects?.length ? `: ${esc(r.finalCritique.defects.join("; "))}` : ""}</p>` : ""}${extras}</div>
    <div class="tab hide" data-t="log"><div id="log" class="log"></div></div>
    <div class="tab hide" data-t="trace">${waterfall(S.trace)}</div>
    <div class="tab hide" data-t="tasks">${m.tasks.map((t: any) => `<details class="task"><summary>${pill(t.status)} <b>${esc(t.agent_id)}</b> — ${esc(t.title)} ${score(t.score)}</summary><p class="dim">${esc(t.instructions)}</p>${t.critique?.defects?.length ? `<p class="warnline">Critic: ${esc(t.critique.defects.join("; "))}</p>` : ""}<div class="md">${md(t.output || "")}</div></details>`).join("")}</div>`;
  $$(".tabs button", el).forEach((b) => b.addEventListener("click", () => {
    $$(".tabs button", el).forEach((x) => x.classList.toggle("on", x === b));
    $$(".tab", el).forEach((t) => t.classList.toggle("hide", t.dataset.t !== b.dataset.t));
  }));
  $("#cancel")?.addEventListener("click", () => guard(() => api(`/api/missions/${m.id}/cancel`, { body: {} }), "Mission cancelled").then(() => scheduleMissionRefresh(m.id)));
  $("[data-receipt]", el)?.addEventListener("click", async () => {
    const rec = await guard(() => api<any>(`/api/missions/${m.id}/receipt`), "Receipt issued");
    if (rec) download(`receipt-${m.id}.json`, JSON.stringify(rec, null, 1));
  });
  $("[data-deltext]", el)?.addEventListener("click", () => download(`deliverable-${m.id}.txt`, r.deliverable, "text/plain"));
  for (const e of S.events.filter((x) => x.missionId === m.id)) appendLog(e);
  drawStreams();
}

// ===== Agents & DNA =====
const BASE_COLOR: Record<string, string> = { A: "var(--sage)", C: "var(--cloud)", G: "var(--gold)", T: "var(--coral)" };
function genomeStrip(g: string) {
  return `<div class="genome" title="${esc(g)}">${[...g].map((b, i) => `<i style="background:${BASE_COLOR[b]}" class="${i < 3 || i >= g.length - 3 ? "cap" : ""}"></i>`).join("")}</div>`;
}
const TRAITS = ["temperature", "rigor", "caution", "curiosity", "creativity", "exploration"];

function onEvoProgress(e: AgencyEvent) {
  if (e.jobId !== S.evoJob) return;
  const bar = $("#evobar") as HTMLElement | null, txt = $("#evotxt");
  if (bar) bar.style.width = `${Math.round((100 * e.done) / Math.max(1, e.total))}%`;
  const phase = e.phase === "confirm" ? "confirming on fresh seeds" : e.phase === "holdout" ? "held-out re-test" : e.phase === "calibrate" ? "A/A noise calibration" : e.phase === "exam" ? "trialing exam questions" : "screening";
  const who = e.agentCount > 1 ? `${e.agentId} (${e.agentIndex + 1}/${e.agentCount}) · ` : "";
  if (txt) txt.textContent = `${who}gen ${e.generation} · ${phase} · ${e.done}/${e.total} runs`;
}

async function showEvoResult(jobId: string) {
  const job = await guard(() => api<any>(`/api/evolution/jobs/${jobId}`));
  const out = $("#evoout");
  if (!job || !out) return;
  S.evoJob = "";
  $("#evocancel")?.remove();
  if (job.error) { out.innerHTML = `<p class="err">${esc(job.status)}: ${esc(job.error)}</p>`; return; }
  if (job.result.kind === "exam") {
    out.innerHTML = job.result.agents.map((x: any) => `<h3 class="runhead">${esc(x.agentId)} · exam now ${x.active} active question(s)</h3>
      <p class="dim">Proposed by the examiner model, answered by sandboxed programs: ${x.proposed.accepted.length} verified question(s), ${x.proposed.rejected.length} rejected (${esc([...new Set(x.proposed.rejected)].join(", ") || "none")}).</p>
      <p class="dim">Trial against the current genome: ${x.trial.admitted.length} admitted at the frontier, ${x.trial.rejected.length} rejected (no signal), ${x.trial.retired.length} retired (saturated).</p>
      ${x.proposed.accepted.length ? `<table class="evotbl"><tr><th>question</th><th>program answer</th></tr>${x.proposed.accepted.map((q: any) => `<tr><td>${esc(q.task.slice(0, 110))}</td><td class="mono">${esc(q.answer)}</td></tr>`).join("")}</table>` : ""}`).join("");
    const t = $("#evotxt"); if (t) t.textContent = "done · exam updated";
    const b = $("#evobar") as HTMLElement | null; if (b) b.style.width = "100%";
    return;
  }
  if (job.result.kind === "calibrate") {
    out.innerHTML = job.result.agents.map(renderCalibration).join("");
    const t = $("#evotxt"); if (t) t.textContent = `done · noise floor measured for ${job.result.agents.length} agent(s)`;
    const b = $("#evobar") as HTMLElement | null; if (b) b.style.width = "100%";
    return;
  }
  const runs: any[] = job.result.fleet ? job.result.agents : [job.result];
  out.innerHTML = runs.map(renderRun).join("");
  const txt = $("#evotxt");
  if (txt) txt.textContent = `done · ${job.result.promotions} promotion(s)${job.result.fleet ? ` across ${runs.length} agents` : ` · fitness ${job.result.finalFitness}`}`;
  const bar = $("#evobar") as HTMLElement | null;
  if (bar) bar.style.width = "100%";
  void loadLineages();
}

const ci = (c: any) => (c ? `[${c[0]}, ${c[1]}]` : "");
function renderHoldout(h: any) {
  if (!h) return "";
  if (h.skipped) return `<p class="dim">Held-out check skipped: ${esc(h.skipped)}.</p>`;
  const cls = /improved/.test(h.verdict) ? "ok" : /worse/.test(h.verdict) ? "err" : "";
  return `<div class="holdout"><h4>Held-out check: <span class="${cls}">${esc(h.verdict)}</span></h4>
    <p class="dim">Items selection never saw (${h.items.map(esc).join(", ")}), fresh seeds ${h.seeds.join(", ")}: starting genome ${h.before.passRate} ${ci(h.before.ci95)} → final genome ${h.after.passRate} ${ci(h.after.ci95)} · paired wins ${h.paired.wins}, losses ${h.paired.losses}, ties ${h.paired.ties}</p></div>`;
}

function renderRun(run: any) {
  const head = `<h3 class="runhead">${esc(run.agentId)} · ${run.generations.length} generation(s) · ${run.promotions} promotion(s)${run.stoppedEarly ? " · stopped early (no progress)" : ""}</h3>
    ${run.changes?.length ? `<p class="dim">Net gene changes this run: ${run.changes.map((d: any) => `${esc(d.trait)} ${d.from} → ${d.to}`).join(", ")}</p>` : ""}`;
  return head + renderHoldout(run.holdout) + run.generations.map((g: any) => `
    <h3>Generation ${g.generation}: ${g.promoted ? "<b class=\"ok\">PROMOTED</b>" : "kept incumbent"}</h3>
    <p>${esc(g.reason)}</p>
    <table class="evotbl"><tr><th>candidate</th><th>fitness</th><th>pass rate</th><th>95% CI</th><th>distance</th></tr>
      ${g.candidates.map((c: any, i: number) => `<tr><td>${c.incumbent ? "incumbent" : `mutant ${i}`}</td><td>${c.fitness}</td><td>${c.passRate}</td><td class="mono">${ci(c.ci95)}</td><td>${c.distance}</td></tr>`).join("")}</table>
    ${g.challengerChanges.length ? `<p class="dim">Best challenger's changed genes: ${g.challengerChanges.map((d: any) => `${esc(d.trait)} ${d.from} → ${d.to}`).join(", ")}</p>` : ""}
    ${g.confirmation ? `<p class="dim">Fresh seeds only (screening cells excluded): challenger ${g.confirmation.challenger.fitness} vs incumbent ${g.confirmation.incumbent.fitness} · paired wins ${g.confirmation.paired.wins}, losses ${g.confirmation.paired.losses}, ties ${g.confirmation.paired.ties} · sign test p = ${g.confirmation.signTestP ?? "–"}${g.confirmation.lookAlpha != null ? ` (needs ≤ ${g.confirmation.lookAlpha})` : ""}</p>${g.confirmation.rounds?.length ? `<p class="dim mono">${g.confirmation.rounds.map((r: any) => `round ${r.round}: ${r.paired.wins}–${r.paired.losses} (p ${r.p})`).join(" · ")}</p>` : ""}` : ""}
    <p class="dim mono">mutation rate ${g.mutationRate ?? "–"}</p>`).join("");
}

/** A/A calibration: the same genome twice on identical seeds. Disagreement = noise every A/B difference must clear. */
function renderCalibration(c: any) {
  return `<h3 class="runhead">${esc(c.agentId)} · noise rate ${c.noiseRate} <span class="dim">95% CI ${ci(c.noiseCi95)}</span></h3>
    <p class="dim">${c.discordant} of ${c.cells} identical-genome cells disagreed (arm A ${c.armA}, arm B ${c.armB}, seeds ${c.seeds.join(", ")}). Item difficulty below shows which items can separate genomes: items near 0 or 1 carry little signal.</p>
    <table class="evotbl"><tr><th>item</th><th>split</th><th>passed</th><th>rate</th></tr>${c.perItem.map((i: any) => `<tr><td>${esc(i.id)}</td><td>${esc(i.split)}</td><td>${i.passed}/${i.runs}</td><td>${i.rate}</td></tr>`).join("")}</table>`;
}

/** Fitness by generation: line = fitness carried out of each generation; gold dot = promotion; faint dot = best challenger. */
function lineageSvg(lin: any[]) {
  if (!lin.length) return "";
  const W = 260, H = 56, P = 6;
  const xs = (i: number) => P + (lin.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (lin.length - 1));
  const vals = lin.flatMap((g) => [g.carried, g.best].filter((v) => v != null)) as number[];
  const lo = Math.min(0.5, ...vals), hi = 1;
  const ys = (v: number) => H - P - ((v - lo) / Math.max(0.01, hi - lo)) * (H - 2 * P);
  const line = lin.map((g, i) => `${xs(i).toFixed(1)},${ys(g.carried ?? lo).toFixed(1)}`).join(" ");
  const chal = lin.map((g, i) => (g.best != null ? `<circle cx="${xs(i)}" cy="${ys(g.best)}" r="2" class="chal"><title>gen ${g.generation}: best challenger ${g.best}</title></circle>` : "")).join("");
  const dots = lin.map((g, i) => `<circle cx="${xs(i)}" cy="${ys(g.carried ?? lo)}" r="${g.promoted ? 4 : 2.5}" class="${g.promoted ? "promo" : "kept"}"><title>gen ${g.generation}: ${g.promoted ? "promoted" : "kept"} · fitness ${g.carried}${g.mutationRate != null ? ` · rate ${g.mutationRate}` : ""}</title></circle>`).join("");
  return `<svg class="lineage" viewBox="0 0 ${W} ${H}" role="img" aria-label="fitness by generation"><line x1="${P}" x2="${W - P}" y1="${ys(1)}" y2="${ys(1)}" class="ref"/>${chal}<polyline points="${line}" class="carried"/>${dots}</svg>`;
}

async function loadLineages() {
  await Promise.all($$("[data-lineage]").map(async (el) => {
    const lin = await api<any[]>(`/api/agents/${el.dataset.lineage}/lineage`).catch(() => [] as any[]);
    el.innerHTML = lin.length ? `${lineageSvg(lin)}<small class="dim">${lin.length} generation(s) · ${lin.filter((g) => g.promoted).length} promoted</small>` : "";
  }));
}

/** Crystallized skills: model reasoning kept as verified, owned code that needs no model. */
/** Cumulative tasks answered by owned skills over time: the curve that shows the agency, not the model, improving. */
/** What a binder learned to refuse: question words, and role words after a number of a role-marked kind. */
function refusals(spec: any): string {
  const KIND: Record<string, string> = { percent: "%", currency: "$", plain: "number" };
  const q = spec?.blockWords || [], cb = spec?.contextBlock;
  const parts = [q.length ? `question: ${q.join(", ")}` : "", cb?.words?.length ? `after ${cb.kinds.map((x: string) => KIND[x] || x).join("/")}: ${cb.words.join(", ")}` : ""].filter(Boolean);
  return parts.join(" · ") || "–";
}

function skillCurve(curve: any[]): string {
  if (!curve.length) return '<p class="dim">No task has been answered skill-first yet.</p>';
  const W = 560, H = 120, P = 24, n = curve.length, max = curve[n - 1].routes;
  const x = (i: number) => P + (n === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (n - 1));
  const y = (v: number) => H - P - (v / Math.max(1, max)) * (H - 2 * P);
  const pts = curve.map((c, i) => `${x(i).toFixed(1)},${y(c.routes).toFixed(1)}`).join(" ");
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative tasks answered skill-first">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="currentColor" opacity=".25"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent, #7cf)" stroke-width="2"/>
    ${curve.map((c, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(c.routes).toFixed(1)}" r="3" fill="var(--accent, #7cf)"><title>${esc(c.at)} · skill_${esc(c.skill)} · ${c.routes} total</title></circle>`).join("")}
    <text x="${P}" y="14" font-size="11" fill="currentColor" opacity=".7">${max} task(s) answered by owned code</text>
  </svg>`;
}

async function loadSkills() {
  const box = $("#skillsp");
  if (!box) return;
  const d = await api<any>("/api/skills").catch(() => null);
  if (!d) { box.innerHTML = '<h2>Crystallized skills</h2><p class="dim">Unavailable.</p>'; return; }
  const st = d.stats;
  box.innerHTML = `<h2>Crystallized skills: what the agency has learned</h2>
    <p class="dim">Most AI products rent intelligence per call and keep nothing. Here, a well-scored mission is distilled into a pure function, verified against an <b>independent</b> implementation written by a different model from the description alone (2 of 3 on disagreement), signed into the ledger, and registered as a tool that answers <b>with no model call</b>. Skills can call earlier skills, so capability compounds and survives a model swap.</p>
    <section class="stats"><div class="stat"><b>${st.active}</b><span>active skills</span></div><div class="stat"><b>${st.uses}</b><span>uses (code, not a model)</span></div><div class="stat"><b>${st.routed ?? 0}</b><span>tasks answered skill-first</span></div><div class="stat"><b>${st.zeroCall ?? 0}</b><span>of them with zero model calls</span></div><div class="stat"><b>${st.binders ?? 0}</b><span>learned binders</span></div><div class="stat"><b>${st.routeMisses ?? 0}</b><span>bind attempts declined</span></div><div class="stat"><b>${st.routeRejected ?? 0}</b><span>skill answers the critic rejected</span></div><div class="stat"><b>${st.failures}</b><span>failures in use</span></div></section>
    <h3>Skill-first routing</h3>
    <p class="dim">Before an agent spends model turns, the agency checks whether a skill it owns already answers the task. A free word-and-number prefilter discards unrelated tasks. A plausible match costs one short local <b>bind</b> call, and every bound value must appear literally in the task. No value may be invented, and a conversion (12% → 0.12) is allowed only when the skill's verified contract declares it. Then verified code produces the exact answer. Any doubt falls back to the normal agent loop.</p>
    ${skillCurve(st.curve || [])}
    <h3>Learned binders: the routing step, crystallized</h3>
    <p class="dim">Every grounded model binding is kept as an example, and every refusal as a counter-example. From 3 examples, the agency <b>induces</b> a binder with no model: for each parameter, one rule (number kind, position, scale and unit) that fits every example. It also learns the task's number shape, and question words that only ever appeared in refused tasks. Each example must be predicted from the others; an example the rest contradict is marked disputed and excluded. The binder must also refuse every near-miss. Admitted binders answer matching tasks with <b>no model at all</b>, and their learned block words gate the model binder too. If the critic rejects a binder's answer, that binder is retired.</p>
    <p class="dim"><b>Verified wording.</b> A binding is trusted only once its wording has been verified. When a task uses wording no verified example used (for example "8% <b>tax</b>" after a discount), it is not routed: the agent loop answers, and the skill's output is compared with that answer. Agreement verifies the wording. A refutation counts only when a second, different agent corroborates it, and then the wording is learned as a refusal. When the two agents disagree with each other, nothing is learned.</p>
    ${(d.binders || []).length ? `<table class="evotbl"><tr><th>skill</th><th>status</th><th>examples</th><th>negatives refused</th><th>blind coverage</th><th>zero-call uses</th><th>learned refusals</th></tr>${d.binders.map((b: any) => `<tr><td class="mono">skill_${esc(b.skill)}</td><td>${esc(b.status)}</td><td>${b.examples}</td><td>${esc(b.verification?.negatives ?? "–")}</td><td>${b.verification?.coverage == null ? "–" : Math.round(b.verification.coverage * 100) + "%"}</td><td>${b.uses}</td><td class="mono">${esc(refusals(b.verification?.spec))}</td></tr>`).join("")}</table>` : '<p class="dim">No learned binder yet. Each skill needs 3 grounded routings first.</p>'}
    <h3>Capability gaps: refusals become skills</h3>
    <p class="dim">When a skill refuses a task and two different agents agree on its answer, the agency has a solved example of something it does not own yet. Gaps whose new wording overlaps (for example "tax") form a family. Three of them are crystallized into a <b>new skill</b>, which must pass differential testing <b>and</b> reproduce the agents' corroborated answers from inputs grounded in each task.</p>
    ${(d.gaps || []).length ? `<table class="evotbl"><tr><th>refused by</th><th>new wording</th><th>corroborated answer</th><th>status</th><th>task</th></tr>${d.gaps.slice(-12).reverse().map((g: any) => `<tr><td class="mono">skill_${esc(g.skill)}</td><td class="mono">${esc((g.markers || []).join(", "))}</td><td>${g.answer}</td><td>${g.resolved_by ? `learned → <span class="mono">skill_${esc(g.resolved_by)}</span>` : esc(g.status)}</td><td>${esc(String(g.task).slice(0, 90))}</td></tr>`).join("")}</table>` : '<p class="dim">No gaps yet. A gap appears when a refused task is answered the same way by two agents.</p>'}
    ${d.skills.length ? `<table class="evotbl"><tr><th>skill</th><th>what it computes</th><th>verified on</th><th>uses</th><th>learned from</th></tr>${d.skills.map((k: any) => `<tr><td class="mono">skill_${esc(k.name)}${k.status !== "active" ? ` <span class="dim">(${esc(k.status)})</span>` : ""}</td><td>${esc(k.description)}</td><td>${k.verification?.inputs ?? "–"} inputs${k.verification?.tiebreak ? " (2-of-3)" : ""}</td><td>${k.uses}</td><td class="mono">${esc(k.source)}</td></tr>`).join("")}</table>` : '<p class="dim">No skills yet. They appear automatically after well-scored missions, or crystallize one below.</p>'}
    <div class="row"><input id="crtext" placeholder="Describe a solved task to crystallize, e.g. 'convert a recipe between servings: scale each ingredient quantity by new/old servings'" /><button id="crgo" class="ghost">Crystallize</button></div>
    <div id="crout"></div>`;
  $("#crgo")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busy(btn, true, "Extracting and verifying…");
    const r = await guard(() => api<any>("/api/skills/crystallize", { body: { text: val("#crtext") } }));
    busy(btn, false);
    if (!r) return;
    $("#crout")!.innerHTML = r.admitted ? `<p class="ok"><b>Admitted</b> <code>skill_${esc(r.skill.name)}</code>: ${esc(r.skill.description)} (${esc(r.reason)})</p>` : `<p class="err"><b>Not admitted:</b> ${esc(r.reason)}</p>`;
    if (r.admitted) setTimeout(() => void loadSkills(), 400);
  });
}

function evoOpts() {
  const n = (sel: string, d: number) => Number(val(sel) || d);
  return { generations: n("#egens", 3), repeats: n("#ereps", 2), population: n("#epop", 4), patience: n("#epat", 2) };
}

function openEvoBox(job: any, title: string) {
  S.evoJob = job.id;
  const box = $("#evo")!;
  box.hidden = false;
  box.innerHTML = `<h2>${esc(title)}</h2><p class="dim">Every candidate genome runs the same training items with the same seeds. A screening winner must hold up on fresh seeds before it is promoted. At the end, the starting and final genomes are re-tested on held-out items that selection never saw.</p>
    <div class="row"><div class="progress"><span id="evobar" style="width:0%"></span></div><span id="evotxt" class="mono dim">starting…</span><button class="ghost small" id="evocancel">Cancel</button></div><div id="evoout"></div>`;
  $("#evocancel")!.addEventListener("click", () => void guard(() => api(`/api/evolution/jobs/${job.id}/cancel`, { body: {} })));
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function viewAgents() {
  const agents = (await guard(() => api<any[]>("/api/agents"))) || [];
  $("#view")!.innerHTML = `
    ${header("Agents & DNA", "Each agent's behavior is encoded as a DNA genome (2-bit nucleotides, codon genes). Evolution mutates and crosses genomes and promotes winners only when measured fitness improves.")}
    <section class="panel forge">
      <h2>Forge</h2>
      <div class="row"><input id="fdesc" placeholder="Describe a new agent, e.g. 'a patent researcher who summarizes prior art with citations'" /><button id="fgo" class="primary">Forge agent</button></div>
      <details><summary>Team roster generator (Agent Factory)</summary>
        <div class="grid3"><input id="rbiz" placeholder="Business name" /><input id="rgoal" placeholder="Goal" /><input id="rcount" type="number" min="2" max="8" value="4" /></div>
        <div class="row"><button id="rprev" class="ghost">Preview roster</button><button id="rcommit" class="ghost">Create roster</button></div>
        <div id="rout"></div>
      </details>
    </section>
    <section class="panel evolab">
      <h2>Evolution lab</h2>
      <p class="dim">Run several generations per agent, or a whole fleet in one background job. A run stops early after <i>patience</i> generations without a promotion, and the mutation rate widens while no challenger wins.</p>
      <div class="grid4">
        <label>generations <input id="egens" type="number" min="1" max="20" value="3" /></label>
        <label>repeats <input id="ereps" type="number" min="1" max="5" value="2" /></label>
        <label>population <input id="epop" type="number" min="2" max="8" value="4" /></label>
        <label>patience <input id="epat" type="number" min="0" max="10" value="2" /></label>
      </div>
      <div class="row fleetpick">${agents.map((a) => `<label><input type="checkbox" data-fleet="${a.id}"${["tycho", "lumen", "helix"].includes(a.id) ? " checked" : ""} /> ${esc(a.id)}</label>`).join("")}</div>
      <div class="row"><button id="efleet" class="primary">Evolve selected agents</button><button id="ecal" class="ghost">Measure noise floor (A/A)</button><button id="eexam" class="ghost">Red Queen: grow the exam</button></div>
    </section>
    <section class="panel skillsp" id="skillsp"><h2>Crystallized skills: what the agency has learned</h2><p class="dim">Loading…</p></section>
    <section class="panel evo" id="evo"${S.evoJob ? "" : " hidden"}></section>
    <section class="cards">${agents.map((a) => `
      <article class="agent">
        <header><div><b>${esc(a.name)}</b><small>${esc(a.role)}</small></div><span class="mono dim">${esc(a.id)}</span></header>
        <p>${esc(a.description)}</p>
        ${genomeStrip(a.genome)}
        <div class="traits">${TRAITS.map((t) => `<div><span>${t}</span><b style="--w:${Math.round((t === "temperature" ? a.traits[t] / 1.3 : a.traits[t]) * 100)}%"></b></div>`).join("")}</div>
        <div class="lineslot" data-lineage="${a.id}"></div>
        <div class="meta"><span>model: ${esc(a.modelRole)}</span><span>gen ${a.generation}</span><span>fitness ${a.fitness ?? "–"}</span><span>${a.runs} runs</span><span>${esc(a.source)}</span></div>
        <div class="tools">${a.tools.map((t: string) => `<code>${esc(t)}</code>`).join("")}</div>
        <div class="row">
          <button class="ghost small" data-ask="${a.id}">Ask</button>
          <button class="ghost small" data-evolve="${a.id}">Evolve</button>
          <button class="ghost small" data-export="${a.id}">Export organism</button>
        </div>
      </article>`).join("")}</section>
    <dialog id="dlg"><form method="dialog"><h3 id="dlgt"></h3><textarea id="dlgin" rows="4"></textarea><pre id="dlgstream" class="streamtext"></pre><div id="dlgout" class="md"></div><div class="row"><button id="dlgrun" class="primary" value="none">Run</button><button value="close" class="ghost">Close</button></div></form></dialog>`;

  $("#fgo")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busy(btn, true, "Forging…");
    const a = await guard(() => api("/api/forge", { body: { description: val("#fdesc") } }), "Agent forged");
    busy(btn, false);
    if (a) void viewAgents();
  });
  const roster = async (commit: boolean, btn: HTMLButtonElement) => {
    busy(btn, true, commit ? "Creating…" : "Designing…");
    const r = await guard(() => api<any[]>("/api/forge/roster", { body: { business: val("#rbiz"), goal: val("#rgoal"), count: Number(val("#rcount") || 4), commit } }));
    busy(btn, false);
    if (r) { $("#rout")!.innerHTML = `<div class="cards mini">${r.map((x) => `<article class="agent"><b>${esc(x.name)}</b><small>${esc(x.role)}</small><p>${esc(x.description)}</p><div class="tools">${x.tools.map((t: string) => `<code>${esc(t)}</code>`).join("")}</div></article>`).join("")}</div>`; if (commit) void viewAgents(); }
  };
  $("#rprev")!.addEventListener("click", (e) => roster(false, e.currentTarget as HTMLButtonElement));
  $("#rcommit")!.addEventListener("click", (e) => roster(true, e.currentTarget as HTMLButtonElement));

  const dlg = $<HTMLDialogElement>("#dlg")!;
  $$("[data-ask]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.ask!;
    S.askAgent = id;
    S.streams.delete(id);
    $("#dlgt")!.textContent = `Ask ${id}`;
    ($<HTMLTextAreaElement>("#dlgin")!).value = "";
    $("#dlgout")!.innerHTML = "";
    dlg.showModal();
    $("#dlgrun")!.onclick = async (ev) => {
      ev.preventDefault();
      const btn = ev.currentTarget as HTMLButtonElement;
      busy(btn, true, "Thinking…");
      const r = await guard(() => api(`/api/agents/${id}/ask`, { body: { task: val("#dlgin") } }));
      busy(btn, false);
      if (r) $("#dlgout")!.innerHTML = `${md(r.final)}<p class="dim">${esc(r.model)} · confidence ${r.confidence} · ${r.toolCalls} tool call(s)</p>`;
    };
  }));
  $$("[data-evolve]").forEach((b) => b.addEventListener("click", async () => {
    const job = await guard(() => api<any>(`/api/agents/${b.dataset.evolve}/evolve`, { body: evoOpts() }));
    if (job) openEvoBox(job, `Evolving ${job.agentId}`);
  }));
  $("#eexam")!.addEventListener("click", async () => {
    const picked = $$<HTMLInputElement>("[data-fleet]").filter((x) => x.checked).map((x) => x.dataset.fleet!);
    if (!picked.length) return toast("Pick at least one agent", true);
    const job = await guard(() => api<any>("/api/exams", { body: { agents: picked, count: 6, repeats: 3 } }));
    if (job) openEvoBox(job, `Red Queen exam: ${picked.join(", ")}`);
  });
  $("#ecal")!.addEventListener("click", async () => {
    const picked = $$<HTMLInputElement>("[data-fleet]").filter((x) => x.checked).map((x) => x.dataset.fleet!);
    if (!picked.length) return toast("Pick at least one agent", true);
    const job = await guard(() => api<any>("/api/evolution/calibrate", { body: { agents: picked, repeats: Number(val("#ereps") || 2) } }));
    if (job) openEvoBox(job, `Noise floor: ${picked.join(", ")}`);
  });
  $("#efleet")!.addEventListener("click", async () => {
    const picked = $$<HTMLInputElement>("[data-fleet]").filter((x) => x.checked).map((x) => x.dataset.fleet!);
    if (!picked.length) return toast("Pick at least one agent", true);
    const job = await guard(() => api<any>("/api/evolution/fleet", { body: { agents: picked, ...evoOpts() } }));
    if (job) openEvoBox(job, `Evolving fleet: ${picked.join(", ")}`);
  });
  void loadLineages();
  void loadSkills();
  // Re-attach to a job that is still running (page reload, or started from another tab or the API).
  if (!S.evoJob) {
    const active = await api<any>("/api/evolution/active").catch(() => null);
    if (active?.status === "running") openEvoBox(active, `Evolving ${String(active.agentId).replace(/,/g, ", ")}`);
  }
  $$("[data-export]").forEach((b) => b.addEventListener("click", async () => {
    const r = await guard(() => api(`/api/agents/${b.dataset.export}/organism`));
    if (!r) return;
    const blob = new Blob([JSON.stringify(r.plasmid, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${b.dataset.export}.organism.plasmid.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }));
}

// ===== Memory & Graph =====
async function viewMemory() {
  const [stats, list, graph] = await Promise.all([guard(() => api("/api/memory/stats")), guard(() => api<any[]>("/api/memory?limit=60")), guard(() => api("/api/memory/graph?limit=160"))]);
  $("#view")!.innerHTML = `
    ${header("Memory & Graph", "Signed, tiered memory with hybrid recall (vectors + BM25 + entity graph). Owner laws are injected into every agent; proven patterns become each agent's playbook.")}
    <section class="stats">${(stats?.byKind || []).map((k: any) => `<div class="stat"><b>${k.n}</b><span>${esc(k.kind)}</span></div>`).join("")}<div class="stat"><b>${stats?.entities ?? 0}</b><span>entities</span></div><div class="stat"><b>${stats?.edges ?? 0}</b><span>relations</span></div></section>
    <div class="split">
      <section class="panel">
        <div class="row"><input id="mq" placeholder="Search memory…" /><button id="mqgo" class="primary">Recall</button></div>
        <div class="row"><input id="madd" placeholder="Add a fact, or an owner law…" /><select id="mkind"><option value="fact">fact</option><option value="governance">owner law</option><option value="semantic">semantic</option></select><button id="maddgo" class="ghost">Save</button></div>
        <div id="mres" class="memlist">${(list || []).map(memRow).join("")}</div>
      </section>
      <section class="panel"><h2>Knowledge graph</h2><svg id="graph" viewBox="0 0 600 520"></svg></section>
    </div>`;
  $("#mqgo")!.addEventListener("click", async () => {
    const r = await guard(() => api<any[]>(`/api/memory/search?q=${encodeURIComponent(val("#mq"))}&k=12`));
    if (r) $("#mres")!.innerHTML = r.map((m) => memRow({ ...m, score: m.score })).join("") || `<p class="dim">Nothing relevant.</p>`;
    bindVerify();
  });
  $("#maddgo")!.addEventListener("click", async () => {
    const r = await guard(() => api("/api/memory", { body: { content: val("#madd"), kind: val("#mkind") } }), "Saved and signed");
    if (r) void viewMemory();
  });
  bindVerify();
  drawGraph(graph || { nodes: [], edges: [] });
}

function memRow(m: any) {
  return `<div class="mem"><div>${pill(m.kind)}${m.score != null ? ` <span class="dim">${m.score}</span>` : ""} <span class="dim">${m.created ? ago(m.created) : ""}</span><button class="link" data-verify="${m.id}">verify</button></div><p>${esc(m.content.slice(0, 600))}</p></div>`;
}
function bindVerify() {
  $$("[data-verify]").forEach((b) => b.addEventListener("click", async () => {
    const r = await guard(() => api(`/api/memory/${b.dataset.verify}/verify`));
    if (r) { b.textContent = r.ok ? `✓ signed by ${r.signer}` : `✗ ${r.reason || "invalid"}`; b.classList.add(r.ok ? "okc" : "badc"); }
  }));
}

function drawGraph(g: { nodes: { id: string; weight: number }[]; edges: { src: string; dst: string; rel: string; weight: number }[] }) {
  const svg = $("#graph");
  if (!svg) return;
  const nodes = g.nodes.slice(0, 80).map((n, i) => ({ ...n, x: 300 + Math.cos(i * 2.399) * (40 + i * 3), y: 260 + Math.sin(i * 2.399) * (40 + i * 3), vx: 0, vy: 0 }));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = g.edges.filter((e) => idx.has(e.src) && idx.has(e.dst));
  for (let it = 0; it < 260; it++) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = a.x - b.x, dy = a.y - b.y, d2 = Math.max(30, dx * dx + dy * dy), f = 900 / d2;
      a.vx += dx * f / 30; a.vy += dy * f / 30; b.vx -= dx * f / 30; b.vy -= dy * f / 30;
    }
    for (const e of edges) {
      const a = nodes[idx.get(e.src)!], b = nodes[idx.get(e.dst)!];
      const dx = b.x - a.x, dy = b.y - a.y;
      a.vx += dx * 0.01; a.vy += dy * 0.01; b.vx -= dx * 0.01; b.vy -= dy * 0.01;
    }
    for (const n of nodes) { n.vx += (300 - n.x) * 0.004; n.vy += (260 - n.y) * 0.004; n.x += n.vx * 0.5; n.y += n.vy * 0.5; n.vx *= 0.6; n.vy *= 0.6; n.x = Math.min(585, Math.max(15, n.x)); n.y = Math.min(505, Math.max(15, n.y)); }
  }
  svg.innerHTML = nodes.length ? edges.map((e) => { const a = nodes[idx.get(e.src)!], b = nodes[idx.get(e.dst)!]; return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="gedge"><title>${esc(e.rel)}</title></line>`; }).join("") +
    nodes.map((n) => `<g class="gnode" transform="translate(${n.x},${n.y})"><circle r="${Math.min(12, 3 + Math.sqrt(n.weight) * 1.6)}"/><text y="-9">${esc(n.id.slice(0, 18))}</text></g>`).join("")
    : `<text x="300" y="260" text-anchor="middle" class="dim">The graph grows as agents learn.</text>`;
}

// ===== Workflows =====
async function viewWorkflows() {
  const [list, types] = await Promise.all([guard(() => api<any[]>("/api/workflows")), guard(() => api<Record<string, string>>("/api/workflow-node-types"))]);
  $("#view")!.innerHTML = `
    ${header("Workflows", "DAG workflows: parallel nodes, conditional branches, human gates, private on-device nodes. Deploy any workflow as an authenticated webhook API.")}
    <div class="split">
      <section class="panel"><h2>Saved</h2>${(list || []).map((w) => `<button class="mitem" data-wf="${w.id}"><div><b>${esc(w.name)}</b> ${w.deployed ? pill("deployed") : ""}</div><p>${esc(w.description || "")}</p><small class="mono">${w.id} · v${w.version}</small></button>`).join("")}
        <details><summary>Node types</summary><ul>${Object.entries(types || {}).map(([k, v]) => `<li><code>${k}</code> — ${esc(v)}</li>`).join("")}</ul></details>
      </section>
      <section class="panel" id="wfd"><p class="dim">Select a workflow.</p></section>
    </div>`;
  $$("[data-wf]").forEach((b) => b.addEventListener("click", () => openWorkflow(b.dataset.wf!)));
  if (list?.[0]) void openWorkflow(list[0].id);
}

async function openWorkflow(id: string) {
  const w = await guard(() => api(`/api/workflows/${id}`));
  if (!w) return;
  const inputKeys = w.def.nodes.filter((n: any) => n.type === "input").map((n: any) => n.data?.field).filter(Boolean);
  $("#wfd")!.innerHTML = `
    <h2>${esc(w.name)}</h2><p class="dim">${esc(w.description)}</p>
    <div class="flow">${w.def.nodes.map((n: any) => `<span class="fnode t-${n.type}">${esc(n.id)}<small>${n.type}</small></span>`).join('<span class="arrow">→</span>')}</div>
    <label>Input JSON</label><textarea id="wfin" rows="3">${esc(JSON.stringify(Object.fromEntries(inputKeys.map((k: string) => [k, ""])), null, 1))}</textarea>
    <div class="row"><button id="wfrun" class="primary">Run</button><button id="wfdeploy" class="ghost">${w.deployed ? "Rotate API key" : "Deploy as API"}</button></div>
    <div id="wfout"></div>
    <details><summary>Definition (edit and save)</summary><textarea id="wfdef" rows="14" class="mono">${esc(JSON.stringify(w.def, null, 2))}</textarea><button id="wfsave" class="ghost">Save new version</button></details>`;
  $("#wfrun")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    let input: unknown;
    try { input = JSON.parse(val("#wfin") || "{}"); } catch { return toast("Input is not valid JSON", true); }
    busy(btn, true, "Running…");
    const r = await guard(() => api(`/api/workflows/${id}/run`, { body: { input } }));
    busy(btn, false);
    if (r) $("#wfout")!.innerHTML = `<p>${pill(r.status)} ${r.error ? esc(r.error) : ""}</p><div class="flow">${Object.entries(r.nodes).map(([k, s]: any) => `<span class="fnode st-${s.status}">${esc(k)}<small>${s.status}${s.ms ? ` ${s.ms}ms` : ""}</small></span>`).join("")}</div>${r.output != null ? `<div class="md deliverable">${md(typeof r.output === "string" ? r.output : "```\n" + JSON.stringify(r.output, null, 2) + "\n```")}</div>` : ""}`;
  });
  $("#wfdeploy")!.addEventListener("click", async () => {
    const r = await guard(() => api(`/api/workflows/${id}/deploy`, { body: {} }));
    if (r) $("#wfout")!.innerHTML = `<div class="keybox"><p>Deployed. This key is shown <b>once</b>:</p><code>${esc(r.key)}</code><pre>curl -X POST ${location.origin}${r.endpoint} -H "x-agency-key: ${esc(r.key)}" -H "content-type: application/json" -d '{"topic":"..."}'</pre></div>`;
  });
  $("#wfsave")!.addEventListener("click", async () => {
    let def: unknown;
    try { def = JSON.parse(($<HTMLTextAreaElement>("#wfdef")!).value); } catch { return toast("Definition is not valid JSON", true); }
    const r = await guard(() => api("/api/workflows", { body: { id, name: w.name, description: w.description, def } }), "Saved");
    if (r) void openWorkflow(id);
  });
}

// ===== Approvals =====
async function viewApprovals() {
  const list = (await guard(() => api<any[]>("/api/approvals"))) || [];
  const recent = (await guard(() => api<any[]>("/api/approvals?status=consumed"))) || [];
  $("#view")!.innerHTML = `
    ${header("Approvals", "Risky tools never run on their own. Approving mints a signed, single-use writ bound to the exact arguments, valid for 10 minutes.")}
    <section class="panel">${list.length ? list.map((p) => `
      <div class="approval"><div><b>${esc(p.tool)}</b> requested by <b>${esc(p.agent_id || "workflow")}</b> <span class="dim">${ago(p.created)}</span></div>
        ${p.reason ? `<p class="dim">${esc(p.reason)}</p>` : ""}<pre>${esc(JSON.stringify(p.args, null, 2))}</pre>
        <div class="row"><button class="primary" data-ap="${p.id}" data-ok="1">Approve</button><button class="ghost" data-ap="${p.id}" data-ok="0">Deny</button></div></div>`).join("") : `<p class="dim">Nothing is waiting on you.</p>`}</section>
    ${recent.length ? `<section class="panel"><h2>Recently executed with writs</h2>${recent.slice(0, 10).map((p) => `<div class="mem"><b>${esc(p.tool)}</b> <span class="dim">${esc(p.decided || "")}</span></div>`).join("")}</section>` : ""}`;
  $$("[data-ap]").forEach((b) => b.addEventListener("click", async () => {
    await guard(() => api(`/api/approvals/${b.dataset.ap}`, { body: { approve: b.dataset.ok === "1" } }), b.dataset.ok === "1" ? "Approved — writ issued" : "Denied");
    void refreshPending();
    void viewApprovals();
  }));
}

// ===== Ledger =====
async function viewLedger() {
  const [verify, rows] = await Promise.all([guard(() => api("/api/ledger/verify")), guard(() => api<any[]>("/api/ledger?limit=150"))]);
  $("#view")!.innerHTML = `
    ${header("Ledger", "Every consequential act is appended to a SHA-256 hash chain and signed with the agency's Ed25519 key. Re-verified end to end on demand.")}
    <section class="panel verify ${verify?.ok ? "ok" : "bad"}">
      <div><b>${verify?.ok ? "VERIFIED" : "BROKEN"}</b> ${verify?.ok ? `${verify.count} entries · every hash and signature checked` : `at #${verify?.brokenAt}: ${esc(verify?.reason)}`}</div>
      ${verify?.merkleRoot ? `<div class="mono">Merkle root ${esc(verify.merkleRoot)}</div>` : ""}
      <div class="row"><input id="pseq" type="number" min="1" placeholder="entry #" /><button id="pgo" class="ghost small">Inclusion proof</button><span id="pout" class="mono dim"></span></div>
    </section>
    <section class="panel receipts">
      <h2>Verify a receipt</h2>
      <p class="dim">A mission receipt proves which agents, tools, local or Firebase models and membrane crossings produced a deliverable, and that the text is unchanged. This check runs <b>entirely in your browser</b> with WebCrypto (Ed25519, SHA-256), with no call to the agency, so it works on any receipt from any EyeOverThink agency. The same check runs offline with <code>node bin/verify-receipt.js receipt.json deliverable.txt</code>.</p>
      <div class="row"><label class="ghost small filepick">Receipt JSON <input id="rfile" type="file" accept=".json,application/json" /></label><label class="ghost small filepick">Deliverable text (optional) <input id="dfile" type="file" accept=".txt,.md,text/plain" /></label><button id="rverify" class="primary">Verify</button></div>
      <div id="rout"></div>
    </section>
    <section class="panel"><div class="tablewrap"><table class="ledger"><thead><tr><th>#</th><th>time</th><th>kind</th><th>actor</th><th>data</th><th>hash</th></tr></thead><tbody>
      ${(rows || []).map((e) => `<tr><td>${e.seq}</td><td>${new Date(e.ts).toLocaleString()}</td><td><code>${esc(e.kind)}</code></td><td>${esc(e.actor)}</td><td class="mono">${esc(JSON.stringify(e.data).slice(0, 120))}</td><td class="mono dim">${e.hash.slice(0, 12)}…</td></tr>`).join("")}
    </tbody></table></div></section>`;
  $("#pgo")!.addEventListener("click", async () => {
    const p = await guard(() => api(`/api/ledger/proof/${val("#pseq")}`));
    if (p) $("#pout")!.textContent = `leaf ${p.leaf.slice(0, 12)}… · ${p.path.length} sibling hashes → root ${p.root.slice(0, 12)}…`;
  });
  $("#rverify")!.addEventListener("click", async () => {
    const rf = $<HTMLInputElement>("#rfile")!.files?.[0];
    if (!rf) return toast("Choose a receipt JSON file", true);
    let receipt: any;
    try { receipt = JSON.parse(await rf.text()); } catch { return toast("That file is not valid JSON", true); }
    const df = $<HTMLInputElement>("#dfile")!.files?.[0];
    const res = await verifyReceipt(receipt, { deliverable: df ? await df.text() : null });
    const s = res.summary;
    $("#rout")!.innerHTML = `<p class="${res.ok ? "ok" : "err"}"><b>${res.ok ? "VERIFIED" : "NOT VERIFIED"}</b> · mission <code>${esc(receipt.statement?.missionId ?? "?")}</code> · agency key <code>${esc(String(receipt.agency?.publicKey ?? "").slice(0, 16))}…</code></p>
      <ul class="checks">${res.checks.map((c: any) => `<li class="${c.ok ? "ok" : "error"}"><b>${c.ok ? "✓" : "✗"}</b><div>${esc(c.name)}${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</div></li>`).join("")}</ul>
      ${s ? `<p class="dim">Verified contents: ${s.toolCalls} tool call(s) · ${s.firebaseCalls} Firebase AI Logic call(s) (${s.firebaseInCloud} IN_CLOUD, ${s.firebaseOnDevice} ON_DEVICE) · ${s.sealedCrossings} sealed crossing(s) withholding ${s.valuesWithheld} value(s) · ${s.egressBlocked} egress attempt(s) blocked</p>` : ""}`;
  });
}

function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===== Models =====
async function viewModels() {
  const s = await guard(() => api("/api/models"));
  if (!s) return;
  $("#view")!.innerHTML = `
    ${header("Models", "Role-based routing across local GPU (Ollama), the browser edge tier (Firebase AI Logic), and optional free cloud fallbacks. Private work never leaves local or on-device models.", `<button id="mref" class="ghost">Refresh</button>`)}
    ${s.ollama.notes.length ? `<div class="warn">${s.ollama.notes.map(esc).join("<br/>")}</div>` : ""}
    <section class="panel"><h2>Role resolution</h2><div class="tablewrap"><table><thead><tr><th>role</th><th>candidates (in order)</th></tr></thead><tbody>${Object.entries(s.roles).map(([r, c]: any) => `<tr><td><b>${r}</b></td><td class="mono">${c.length ? c.map(esc).join(" → ") : '<span class="badc">none available</span>'}</td></tr>`).join("")}</tbody></table></div></section>
    <div class="split">
      <section class="panel"><h2>Ollama · ${esc(s.ollama.url)}</h2><p>${s.ollama.served.length} served${s.ollama.notServed.length ? ` · ${s.ollama.notServed.length} on disk but not served` : ""}</p><div class="tools">${s.ollama.served.map((m: string) => `<code>${esc(m)}</code>`).join("")}</div></section>
      <section class="panel"><h2>Circuit breakers & usage</h2>
        ${Object.keys(s.breakers).length ? `<div class="tablewrap"><table><tbody>${Object.entries(s.breakers).map(([k, b]: any) => `<tr><td class="mono">${esc(k)}</td><td>${pill(b.state)}</td><td class="dim">${esc(b.lastError || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="dim">No model calls yet.</p>`}
        <p>${s.usage.calls} calls · ${s.usage.promptTokens} prompt / ${s.usage.completionTokens} completion tokens</p>
        <p class="dim">Cloud: OpenAI-compatible ${s.openaiCompat.enabled ? "on" : "off"} · Gemini API ${s.gemini.enabled ? "on" : "off"} · Edge workers ${s.edge?.workers?.length ?? 0}</p>
      </section>
    </div>`;
  $("#mref")!.addEventListener("click", async () => { await guard(() => api("/api/models/refresh", { body: {} })); void viewModels(); });
}

// ===== Hybrid Edge (Firebase AI Logic) =====
const DOCTOR_MARK: Record<string, string> = { ok: "✓", warn: "!", error: "✗", info: "i" };
function renderDoctor(d: any) {
  if (!d) return "";
  return `<section class="panel doctor"><h2>0 · Setup check ${d.ok ? (d.configured ? '<span class="ok">ready</span>' : '<span class="dim">not configured</span>') : '<span class="err">needs fixes</span>'}</h2>
    <p class="dim">Offline checks of <code>web/.env.local</code> and the dashboard build, run by the agency server (<code>agency edge doctor</code>). Secrets are masked. Full guide: <code>docs/FIREBASE_SETUP.md</code>.</p>
    <ul class="checks">${d.checks.map((c: any) => `<li class="${c.level}"><b>${DOCTOR_MARK[c.level]}</b><div>${esc(c.message)}${c.fix ? `<small>${esc(c.fix)}</small>` : ""}</div></li>`).join("")}</ul></section>`;
}

function renderProof(p: any) {
  if (!p) return "";
  const rows = p.entries.slice(0, 12).map((e: any) => `<tr><td class="mono">#${e.seq}</td><td>${new Date(e.ts).toLocaleTimeString()}</td><td><span class="source-chip ${e.data.inferenceSource === "ON_DEVICE" ? "on-device" : "in-cloud"}">${esc(e.data.inferenceSource)}</span></td><td>${esc(e.data.origin)}</td><td class="mono">${esc(e.data.mode)}</td><td>${e.data.latencyMs} ms</td><td class="mono">${esc(e.data.project ?? "–")}</td><td class="mono" title="${esc(e.data.sha256 ?? "")}">${esc(String(e.data.sha256 ?? "–").slice(0, 12))}</td></tr>`).join("");
  return `<section class="panel"><h2>4 · Proof: Firebase AI Logic calls in the signed ledger</h2>
    <p class="dim">Every completed call (routed agency jobs and direct calls from this page) is appended to the Ed25519-signed hash chain with its inference path, latency and a SHA-256 of the output, never the prompt or the text. Ledger ${p.ledger?.ok ? `<b class="ok">verified</b> (${p.ledger.count} entries)` : '<b class="err">BROKEN</b>'}. CLI: <code>agency edge proof</code>.</p>
    <section class="stats"><div class="stat"><b>${p.total}</b><span>ledgered calls</span></div><div class="stat"><b>${p.onDevice}</b><span>ON_DEVICE</span></div><div class="stat"><b>${p.inCloud}</b><span>IN_CLOUD</span></div></section>
    ${p.total ? `<div class="tablewrap"><table class="ledger"><thead><tr><th>#</th><th>time</th><th>path</th><th>origin</th><th>mode</th><th>latency</th><th>project</th><th>output sha256</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="dim">No Firebase calls recorded yet. Make one in step 3, or start serving in step 2 while a mission runs.</p>'}</section>`;
}

async function viewEdge() {
  const [snap, doctor, proof, models] = await Promise.all([
    guard(() => api("/api/edge")), api<any>("/api/edge/doctor").catch(() => null), api<any>("/api/edge/proof?limit=50").catch(() => null), api<any>("/api/models").catch(() => null),
  ]);
  const cfgOk = isConfigured();
  const nano = await nanoAvailability();
  const st = edge.state;
  $("#view")!.innerHTML = `
    ${header("Hybrid Edge", "This browser becomes an inference node. Firebase AI Logic runs Gemini Nano on-device when Chrome can, and falls back to cloud Gemini when it can't. Private agency work is sent here as ONLY_ON_DEVICE.")}
    ${cfgOk ? "" : `<div class="warn">Firebase AI Logic is not configured for this build (missing ${missingConfig().join(", ")}). Copy <code>web/.env.example</code> to <code>web/.env.local</code>, fill it from your Firebase project (Spark plan, Gemini Developer API), then rebuild. The agency keeps working on local models meanwhile.</div>`}
    <section class="stats">
      <div class="stat"><b>${chromeDesktopOk() ? "yes" : "no"}</b><span>Chrome desktop 139+</span></div>
      <div class="stat"><b>${esc(nano)}</b><span>Gemini Nano on-device</span></div>
      <div class="stat"><b>${st.onDevice}</b><span>ON_DEVICE runs</span></div>
      <div class="stat"><b>${st.inCloud}</b><span>IN_CLOUD runs</span></div>
      <div class="stat"><b>${snap?.workers?.length ?? 0}</b><span>workers online</span></div>
      <div class="stat"><b>${models?.usage?.edgeOverflow ?? 0}</b><span>GPU overflow calls</span></div>
    </section>
    ${renderDoctor(doctor)}
    <section class="panel">
      <h2>1 · Prepare the on-device model</h2>
      <p class="dim">Chrome requires this to start from a click. The first run downloads Gemini Nano.</p>
      <div class="row"><button id="prep" class="ghost" ${cfgOk ? "" : "disabled"}>Prepare on-device model</button><div class="progress"><span id="prog" style="width:0%"></span></div><span id="proglabel" class="dim"></span></div>
    </section>
    <section class="panel">
      <h2>2 · Serve the agency as an edge worker</h2>
      <p class="dim">The local GPU runs one model call at a time. While it is busy, the agency sends waiting fast, plan, critic and reasoning calls to this tab instead of queueing them (private work only to Gemini Nano on-device). Benchmarks and evolution stay on the local model.</p>
      <p>${st.running ? `Serving as <code>${esc(st.workerId)}</code> · ${st.done} jobs done · ${st.failed} failed · last source <b>${esc(st.last || "–")}</b>` : "Not serving."}${st.lastError ? ` <span class="badc">${esc(st.lastError)}</span>` : ""}</p>
      <button id="serve" class="${st.running ? "ghost" : "primary"}" ${cfgOk ? "" : "disabled"}>${st.running ? "Stop serving" : "Start serving"}</button>
    </section>
    <section class="panel">
      <h2>3 · Try a private prompt in this browser</h2>
      <textarea id="eprompt" rows="3" placeholder="Draft a polite reply declining a meeting, from these private notes: …"></textarea>
      <div class="row"><select id="emode"><option value="prefer_on_device">prefer_on_device</option><option value="only_on_device">only_on_device</option><option value="prefer_in_cloud">prefer_in_cloud</option><option value="only_in_cloud">only_in_cloud</option></select><button id="ego" class="primary" ${cfgOk ? "" : "disabled"}>Generate</button>${S.edgeLast ? `<span id="esrc" class="source-chip ${S.edgeLast.source === "ON_DEVICE" ? "on-device" : "in-cloud"}">${esc(S.edgeLast.source)}</span><span class="dim mono">${S.edgeLast.latencyMs} ms${S.edgeLast.seq != null ? ` · ledger #${S.edgeLast.seq}` : ""}</span>` : '<span id="esrc" class="source-chip">Not run yet</span>'}</div>
      <div id="eout" class="md">${S.edgeLast ? md(S.edgeLast.text) : ""}</div>
    </section>
    ${renderProof(proof)}
    <section class="panel membrane">
      <h2>5 · Privacy Membrane: private work, cloud capacity</h2>
      <p class="dim">Private doesn't have to mean "never use the cloud". The membrane finds sensitive values (emails, phones, cards, IDs, keys, names via a <b>local</b> model, and your own terms), replaces them with placeholders, sends only the sealed text to Firebase AI Logic, blocks the call if any original would still leave, and restores the answer here. The value map never leaves the agency server. Each crossing is signed into the ledger with keyed tags, never values. Missions can run with privacy <code>sealed</code>.</p>
      <textarea id="mtext" rows="4" placeholder="Draft a reply to maria.lopez@clinic.org confirming Dr. Amara Okafor's appointment; her callback number is +1 (415) 555-0132.">Draft a short, warm reply to maria.lopez@clinic.org confirming that Dr. Amara Okafor will see her on Friday at 10am. Mention we will call her back at +1 (415) 555-0132 if anything changes.</textarea>
      <div class="row"><input id="mterms" placeholder="Always-withhold terms, comma separated (e.g. Project Bluefin, Acme Holdings)" /><button id="msaveterms" class="ghost small">Save terms</button></div>
      <div class="row"><button id="mprev" class="ghost">Preview what leaves the machine</button><button id="mrun" class="primary" ${cfgOk ? "" : "disabled"}>Run sealed through Firebase</button></div>
      <div id="mout"></div>
    </section>`;
  const mview = (r: any) => `${r.ner === "unavailable" ? '<div class="warn">Name detection is unavailable: no local model is serving. Emails, phones, cards, IDs, keys and your terms are still withheld, but <b>names are not</b>, so the membrane will refuse a real crossing until a local model is available.</div>' : r.ner === "ok" ? '<p class="dim">Names checked by the local model.</p>' : ""}<div class="sealed"><h4>What leaves the machine</h4><pre>${esc(r.sealed ?? r.messages?.at(-1)?.content ?? "")}</pre></div>
    ${r.total ? `<table class="evotbl"><tr><th>withheld</th><th>placeholder</th><th>preview</th><th>keyed tag</th></tr>${r.items.map((i: any) => `<tr><td>${esc(i.type)}</td><td class="mono">${esc(i.placeholder)}</td><td class="mono">${esc(i.preview)}</td><td class="mono">${esc(i.tag)}</td></tr>`).join("")}</table>` : '<p class="dim">Nothing sensitive detected: the text would cross unchanged.</p>'}`;
  void api<string[]>("/api/membrane/terms").then((t) => { const el = $<HTMLInputElement>("#mterms"); if (el) el.value = t.join(", "); }).catch(() => {});
  $("#msaveterms")?.addEventListener("click", () => void guard(() => api("/api/membrane/terms", { body: { terms: val("#mterms").split(",").map((x) => x.trim()).filter(Boolean) } }), "Terms saved"));
  $("#mprev")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busy(btn, true, "Sealing (local model)…");
    const r = await guard(() => api<any>("/api/membrane/preview", { body: { text: val("#mtext") } }));
    busy(btn, false);
    if (r) $("#mout")!.innerHTML = mview(r);
  });
  $("#mrun")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busy(btn, true, "Sealing…");
    const sealed = await guard(() => api<any>("/api/membrane/seal", { body: { text: val("#mtext") } }));
    if (!sealed) { busy(btn, false); return; }
    $("#mout")!.innerHTML = mview(sealed) + '<p class="dim">Calling Firebase AI Logic with the sealed text…</p>';
    busy(btn, true, "Firebase…");
    const t0 = performance.now();
    let r: Awaited<ReturnType<typeof generate>> | null = null;
    try { r = await generate(sealed.messages, "only_in_cloud"); } catch (err) { toast(explainFirebaseError(err), true); }
    if (!r) { busy(btn, false); return; }
    const latencyMs = Math.round(performance.now() - t0);
    await api("/api/edge/attest", { body: { mode: "only_in_cloud", inferenceSource: r.source, latencyMs, chars: r.text.length, sha256: await sha256Hex(r.text), ...edgeIdentity() } }).catch(() => null);
    const restored = await guard(() => api<any>("/api/membrane/unseal", { body: { sessionId: sealed.sessionId, text: r!.text, provider: "firebase-ai-logic", model: edgeIdentity().cloudModel } }));
    busy(btn, false);
    $("#mout")!.innerHTML = mview(sealed) + `<div class="sealed"><h4>What Firebase answered (${esc(r.source)}, ${latencyMs} ms)</h4><pre>${esc(r.text)}</pre></div>
      <div class="restored"><h4>Restored here, on your machine</h4><div class="md">${md(restored?.text ?? "")}</div></div>`;
  });
  $("#prep")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busy(btn, true, "Preparing…");
    await guard(() => prepareOnDevice((p) => { $("#prog")!.style.width = `${p}%`; $("#proglabel")!.textContent = `${p}%`; }), "On-device model ready");
    busy(btn, false);
  });
  $("#serve")?.addEventListener("click", async () => {
    if (edge.state.running) edge.stop(); else await guard(() => edge.start(), "Serving as an edge worker");
    void viewEdge();
  });
  $("#ego")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    busy(btn, true, "Generating…");
    const mode = val("#emode") as ModeName;
    const t0 = performance.now();
    let r: Awaited<ReturnType<typeof generate>> | null = null;
    try { r = await generate([{ role: "user", content: val("#eprompt") }], mode); } catch (err) { toast(explainFirebaseError(err), true); }
    busy(btn, false);
    if (r) {
      const latencyMs = Math.round(performance.now() - t0);
      // Sign the call into the ledger: path, latency, size and an output hash. The prompt and text stay in this browser.
      const att = await api<any>("/api/edge/attest", { body: { mode, inferenceSource: r.source, latencyMs, chars: r.text.length, sha256: await sha256Hex(r.text), ...edgeIdentity() } }).catch(() => null);
      S.edgeLast = { text: r.text, source: r.source, latencyMs, seq: att?.entry?.seq ?? null };
      await viewEdge(); // refresh the proof table; the answer is re-shown from S.edgeLast
    }
  });
}

// ===== Lab =====
async function viewLab() {
  const [dreams, bench, auto] = await Promise.all([guard(() => api<any[]>("/api/dreams")), guard(() => api<any[]>("/api/bench")), guard(() => api("/api/autonomy"))]);
  $("#view")!.innerHTML = `
    ${header("Lab", "Self-test, benchmarks, dreaming, autonomy, continuity exports and the DNA codec.")}
    <div class="split">
      <section class="panel"><h2>Self-test</h2><p class="dim">Exercises DNA/codon codecs, plasmid forgery rejection, Ed25519 negative control, ledger + Merkle proof, DB integrity, Sentinel, Kuramoto and the model router.</p><button id="st" class="primary">Run self-test</button><div id="stout"></div></section>
      <section class="panel"><h2>Benchmark</h2><p class="dim">Deterministic checks (no LLM judge): exact math, verified code, tool use, DNA, injection resistance, JSON shape, honesty.</p><button id="bn" class="primary">Run core suite</button><div id="bnout">${(bench || []).slice(0, 5).map((b) => `<div class="mem">${score(b.score)} <span class="dim">${ago(b.created)} · ${esc(b.models.join(", "))}</span></div>`).join("")}</div></section>
    </div>
    <div class="split">
      <section class="panel"><h2>Dreaming</h2><button id="dr" class="ghost">Dream now</button><div id="drout">${(dreams || []).slice(0, 6).map((d) => `<details class="mem"><summary>${pill(d.kind)} <span class="dim">${ago(d.created)} · ${d.stats.lessons} lessons · ${d.stats.archived} archived</span></summary><div class="md">${md(d.summary)}</div></details>`).join("")}</div></section>
      <section class="panel"><h2>Autonomy</h2><label class="check"><input type="checkbox" id="aon" ${auto?.enabled ? "checked" : ""}/> Pursue standing goals on a schedule (one mission at a time)</label>
        <div class="row"><input id="agoal" placeholder="Standing goal, e.g. 'Each morning, brief me on new local-AI releases'" /><input id="aev" type="number" value="24" min="1" style="max-width:90px" title="every N hours"/><button id="aadd" class="ghost">Add</button></div>
        ${(auto?.goals || []).map((g: any) => `<div class="mem"><b>every ${g.everyHours}h</b> ${esc(g.goal)} <span class="dim">${g.lastRun ? `last ${ago(g.lastRun)}` : "never run"}</span> <button class="link" data-gdel="${g.id}">remove</button></div>`).join("")}
      </section>
    </div>
    <div class="split">
      <section class="panel"><h2>Continuity</h2><p class="dim">Brain-dump handoff (signed Markdown + JSON) and a Carbon X organism snapshot (codon-encoded FASTA chromosomes in a signed plasmid).</p><div class="row"><button id="cx" class="ghost">Export brain dump</button><button id="cs" class="ghost">Organism snapshot</button></div><div id="cout" class="mono"></div></section>
      <section class="panel"><h2>DNA codec</h2><div class="row"><input id="dnin" placeholder="Text to encode" /><select id="dnf"><option value="dna">2-bit DNA</option><option value="codon">Carbon X codon</option></select><button id="dngo" class="ghost">Encode</button></div><div id="dnout"></div></section>
    </div>`;
  $("#st")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; busy(btn, true, "Testing…");
    const r = await guard(() => api("/api/selftest", { body: {} })); busy(btn, false);
    if (r) $("#stout")!.innerHTML = `<h3 class="${r.verdict === "ALL_CLEAR" ? "okc" : "badc"}">${esc(r.verdict)}</h3>${r.checks.map((c: any) => `<div class="mem"><span class="${c.ok ? "okc" : "badc"}">${c.ok ? "PASS" : "FAIL"}</span> ${esc(c.name)} <span class="dim">${c.ms}ms ${esc(c.error || "")}</span></div>`).join("")}`;
  });
  $("#bn")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; busy(btn, true, "Benchmarking (minutes)…");
    const r = await guard(() => api("/api/bench", { body: { suite: "core" } })); busy(btn, false);
    if (r) $("#bnout")!.innerHTML = `<h3>${score(r.score)} ${r.passed}/${r.total}</h3>${r.results.map((x: any) => `<div class="mem"><span class="${x.pass ? "okc" : "badc"}">${x.pass ? "PASS" : "FAIL"}</span> ${esc(x.id)} <span class="dim">${esc(x.agent)} · ${x.ms}ms ${esc(x.error || "")}</span></div>`).join("")}`;
  });
  $("#dr")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; busy(btn, true, "Dreaming…");
    await guard(() => api("/api/dreams/run", { body: { force: true } }), "Dream cycle complete"); busy(btn, false); void viewLab();
  });
  $("#aon")!.addEventListener("change", (e) => guard(() => api("/api/autonomy", { body: { enabled: (e.target as HTMLInputElement).checked } }), "Autonomy updated"));
  $("#aadd")!.addEventListener("click", async () => { await guard(() => api("/api/autonomy/goals", { body: { goal: val("#agoal"), everyHours: Number(val("#aev") || 24) } }), "Goal added"); void viewLab(); });
  $$("[data-gdel]").forEach((b) => b.addEventListener("click", async () => { await guard(() => api(`/api/autonomy/goals/${b.dataset.gdel}`, { method: "DELETE" })); void viewLab(); }));
  $("#cx")!.addEventListener("click", async () => { const r = await guard(() => api("/api/continuity/export", { body: {} }), "Brain dump exported"); if (r) $("#cout")!.textContent = `${r.file} (${r.bytes} bytes, ledger ${r.ledger.ok ? "verified" : "BROKEN"})`; });
  $("#cs")!.addEventListener("click", async () => { const r = await guard(() => api("/api/continuity/snapshot", { body: {} }), "Snapshot written"); if (r) $("#cout")!.textContent = `${r.file} · strand ${r.strandSha.slice(0, 16)}… · ${JSON.stringify(r.sizes)}`; });
  $("#dngo")!.addEventListener("click", async () => {
    const r = await guard(() => api("/api/dna/encode", { body: { text: val("#dnin"), format: val("#dnf") } }));
    if (r) $("#dnout")!.innerHTML = `${genomeStrip(r.strand.slice(0, 240))}<p class="mono wrap">${esc(r.strand.slice(0, 600))}${r.strand.length > 600 ? "…" : ""}</p><p class="dim">${r.length} nt · GC ${(r.gc * 100).toFixed(1)}%</p>`;
  });
}

// ---------------- boot ----------------
async function boot() {
  if (!getToken()) return renderTokenGate();
  const st = await guard(() => api("/api/status"));
  if (!st) return;
  S.status = st;
  renderShell();
  subscribe(onEvent, (ok) => { S.connected = ok; const c = $("#conn"); if (c) { c.classList.toggle("ok", ok); c.lastChild!.textContent = ok ? "live" : "offline"; } });
  await refreshPending();
  await renderView();
  window.setInterval(async () => { const s = await api("/api/status").catch(() => null); if (s) S.status = s; }, 15000);
}

window.addEventListener("hashchange", () => {
  const v = location.hash.slice(1) as View;
  if (VIEWS.some(([x]) => x === v) && v !== S.view) { S.view = v; $$("nav a").forEach((x) => x.classList.toggle("on", x.dataset.view === v)); void renderView(); }
});

void boot();
