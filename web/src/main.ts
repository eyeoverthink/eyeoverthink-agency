import "./style.css";
import { api, getToken, setToken, subscribe, ApiError, type AgencyEvent } from "./api";
import { md, esc } from "./md";
import { isConfigured, missingConfig, prepareOnDevice, generate, promptApiPresent, chromeDesktopOk, type ModeName } from "./hybrid";
import { EdgeWorker } from "./edge";

type View = "missions" | "agents" | "memory" | "workflows" | "ledger" | "approvals" | "models" | "edge" | "lab";
const VIEWS: Array<[View, string, string]> = [
  ["missions", "Mission Control", "◎"], ["agents", "Agents & DNA", "⌬"], ["memory", "Memory & Graph", "◈"], ["workflows", "Workflows", "⇶"],
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
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label || "Working…"}`; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.label || btn.innerHTML; }
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
  S.events.push(e);
  if (S.events.length > 400) S.events.splice(0, S.events.length - 400);
  if (e.type === "approval.request" || e.type === "approval.decide") void refreshPending();
  if (S.view === "missions") {
    if (["mission.created", "mission.status", "mission.plan", "task.status", "task.critique"].includes(e.type)) scheduleMissionRefresh(e.missionId);
    appendLog(e);
  }
  if (S.view === "ledger" && e.type === "ledger") void renderView();
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
  const map: Record<View, () => Promise<void>> = { missions: viewMissions, agents: viewAgents, memory: viewMemory, workflows: viewWorkflows, ledger: viewLedger, approvals: viewApprovals, models: viewModels, edge: viewEdge, lab: viewLab };
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
        <label class="check"><input type="checkbox" id="private" /> Private (local GPU / on-device only, never cloud)</label>
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
    const m = await guard(() => api("/api/missions", { body: { goal, mode: val("#mode"), privacy: $<HTMLInputElement>("#private")!.checked ? "private" : "normal" } }));
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
    return `<g class="node s-${t.status}" transform="translate(${p.x},${p.y})"><rect width="${W}" height="${H}" rx="10"/><text x="12" y="22" class="agent">${esc(t.agent_id)}</text><text x="12" y="42">${esc(t.title.slice(0, 26))}</text><text x="12" y="57" class="meta">${esc(t.status)}${t.score != null ? ` · ${t.score.toFixed(2)}` : ""}${t.attempts > 1 ? ` · ${t.attempts} tries` : ""}${t.privacy === "private" ? " · 🔒" : ""}</text></g>`;
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
  const deliverable = r?.deliverable ? `<div class="deliverable md">${md(r.deliverable)}</div>` : active ? `<p class="dim"><span class="spin"></span> The team is working…</p>` : m.error ? `<div class="warn">${esc(m.error)}</div>` : "";
  const extras = r?.logicChain ? `<details><summary>Logic chain ledger & review</summary><pre>${esc(JSON.stringify({ stages: r.logicChain.stages, open: r.logicChain.review.open.map((o: any) => o.text), dismissed: r.logicChain.review.dismissed.length, voters: r.logicChain.review.voters }, null, 2))}</pre></details>` :
    r?.consensus ? `<details open><summary>Consensus · coherence R = ${r.consensus.r}</summary><p>Clusters: ${r.consensus.clusters.map((c: string[]) => `[${c.join(", ")}]`).join(" ")}</p></details>` : "";
  el.innerHTML = `
    <div class="mhead"><div>${pill(m.status)} ${score(m.score)} <span class="dim">${esc(m.options.mode)} · ${m.options.privacy} · ${m.replans} replan(s)</span></div>
      ${active ? `<button id="cancel" class="ghost small">Cancel</button>` : ""}</div>
    <h3 class="goal">${esc(m.goal)}</h3>
    ${m.plan?.summary ? `<p class="dim">${esc(m.plan.summary)}${m.plan.fallback ? " (fallback plan)" : ""}</p>` : ""}
    ${dagSvg(m.tasks)}
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
  for (const e of S.events.filter((x) => x.missionId === m.id)) appendLog(e);
}

// ===== Agents & DNA =====
const BASE_COLOR: Record<string, string> = { A: "var(--sage)", C: "var(--cloud)", G: "var(--gold)", T: "var(--coral)" };
function genomeStrip(g: string) {
  return `<div class="genome" title="${esc(g)}">${[...g].map((b, i) => `<i style="background:${BASE_COLOR[b]}" class="${i < 3 || i >= g.length - 3 ? "cap" : ""}"></i>`).join("")}</div>`;
}
const TRAITS = ["temperature", "rigor", "caution", "curiosity", "creativity", "exploration"];

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
    <section class="cards">${agents.map((a) => `
      <article class="agent">
        <header><div><b>${esc(a.name)}</b><small>${esc(a.role)}</small></div><span class="mono dim">${esc(a.id)}</span></header>
        <p>${esc(a.description)}</p>
        ${genomeStrip(a.genome)}
        <div class="traits">${TRAITS.map((t) => `<div><span>${t}</span><b style="--w:${Math.round((t === "temperature" ? a.traits[t] / 1.3 : a.traits[t]) * 100)}%"></b></div>`).join("")}</div>
        <div class="meta"><span>model: ${esc(a.modelRole)}</span><span>gen ${a.generation}</span><span>fitness ${a.fitness ?? "–"}</span><span>${a.runs} runs</span><span>${esc(a.source)}</span></div>
        <div class="tools">${a.tools.map((t: string) => `<code>${esc(t)}</code>`).join("")}</div>
        <div class="row">
          <button class="ghost small" data-ask="${a.id}">Ask</button>
          <button class="ghost small" data-evolve="${a.id}">Evolve</button>
          <button class="ghost small" data-export="${a.id}">Export organism</button>
        </div>
      </article>`).join("")}</section>
    <dialog id="dlg"><form method="dialog"><h3 id="dlgt"></h3><textarea id="dlgin" rows="4"></textarea><div id="dlgout" class="md"></div><div class="row"><button id="dlgrun" class="primary" value="none">Run</button><button value="close" class="ghost">Close</button></div></form></dialog>`;

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
    busy(b as HTMLButtonElement, true, "Evolving…");
    const r = await guard(() => api(`/api/agents/${b.dataset.evolve}/evolve`, { body: { population: 4 } }));
    busy(b as HTMLButtonElement, false);
    if (r) { toast(`gen ${r.generation}: best ${r.best} vs incumbent ${r.incumbent} — ${r.promoted ? "PROMOTED" : "kept incumbent"}`); void viewAgents(); }
  }));
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
    <section class="panel"><div class="tablewrap"><table class="ledger"><thead><tr><th>#</th><th>time</th><th>kind</th><th>actor</th><th>data</th><th>hash</th></tr></thead><tbody>
      ${(rows || []).map((e) => `<tr><td>${e.seq}</td><td>${new Date(e.ts).toLocaleString()}</td><td><code>${esc(e.kind)}</code></td><td>${esc(e.actor)}</td><td class="mono">${esc(JSON.stringify(e.data).slice(0, 120))}</td><td class="mono dim">${e.hash.slice(0, 12)}…</td></tr>`).join("")}
    </tbody></table></div></section>`;
  $("#pgo")!.addEventListener("click", async () => {
    const p = await guard(() => api(`/api/ledger/proof/${val("#pseq")}`));
    if (p) $("#pout")!.textContent = `leaf ${p.leaf.slice(0, 12)}… · ${p.path.length} sibling hashes → root ${p.root.slice(0, 12)}…`;
  });
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
async function viewEdge() {
  const snap = await guard(() => api("/api/edge"));
  const cfgOk = isConfigured();
  const st = edge.state;
  $("#view")!.innerHTML = `
    ${header("Hybrid Edge", "This browser becomes an inference node. Firebase AI Logic runs Gemini Nano on-device when Chrome can, and falls back to cloud Gemini when it can't. Private agency work is sent here as ONLY_ON_DEVICE.")}
    ${cfgOk ? "" : `<div class="warn">Firebase AI Logic is not configured for this build (missing ${missingConfig().join(", ")}). Copy <code>web/.env.example</code> to <code>web/.env.local</code>, fill it from your Firebase project (Spark plan, Gemini Developer API), then rebuild. The agency keeps working on local models meanwhile.</div>`}
    <section class="stats">
      <div class="stat"><b>${chromeDesktopOk() ? "yes" : "no"}</b><span>Chrome desktop 139+</span></div>
      <div class="stat"><b>${promptApiPresent() ? "present" : "absent"}</b><span>Prompt API (Nano)</span></div>
      <div class="stat"><b>${st.onDevice}</b><span>ON_DEVICE runs</span></div>
      <div class="stat"><b>${st.inCloud}</b><span>IN_CLOUD runs</span></div>
      <div class="stat"><b>${snap?.workers?.length ?? 0}</b><span>workers online</span></div>
    </section>
    <section class="panel">
      <h2>1 · Prepare the on-device model</h2>
      <p class="dim">Chrome requires this to start from a click. The first run downloads Gemini Nano.</p>
      <div class="row"><button id="prep" class="ghost" ${cfgOk ? "" : "disabled"}>Prepare on-device model</button><div class="progress"><span id="prog" style="width:0%"></span></div><span id="proglabel" class="dim"></span></div>
    </section>
    <section class="panel">
      <h2>2 · Serve the agency as an edge worker</h2>
      <p>${st.running ? `Serving as <code>${esc(st.workerId)}</code> · ${st.done} jobs done · ${st.failed} failed · last source <b>${esc(st.last || "–")}</b>` : "Not serving."}${st.lastError ? ` <span class="badc">${esc(st.lastError)}</span>` : ""}</p>
      <button id="serve" class="${st.running ? "ghost" : "primary"}" ${cfgOk ? "" : "disabled"}>${st.running ? "Stop serving" : "Start serving"}</button>
    </section>
    <section class="panel">
      <h2>3 · Try a private prompt in this browser</h2>
      <textarea id="eprompt" rows="3" placeholder="Draft a polite reply declining a meeting, from these private notes: …"></textarea>
      <div class="row"><select id="emode"><option value="prefer_on_device">prefer_on_device</option><option value="only_on_device">only_on_device</option><option value="prefer_in_cloud">prefer_in_cloud</option><option value="only_in_cloud">only_in_cloud</option></select><button id="ego" class="primary" ${cfgOk ? "" : "disabled"}>Generate</button><span id="esrc" class="source-chip">Not run yet</span></div>
      <div id="eout" class="md"></div>
    </section>`;
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
    const r = await guard(() => generate([{ role: "user", content: val("#eprompt") }], val("#emode") as ModeName));
    busy(btn, false);
    if (r) { $("#eout")!.innerHTML = md(r.text); const chip = $("#esrc")!; chip.textContent = r.source; chip.className = `source-chip ${r.source === "ON_DEVICE" ? "on-device" : "in-cloud"}`; }
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
