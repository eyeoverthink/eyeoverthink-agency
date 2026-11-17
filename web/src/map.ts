// Sovereignty Map: the agency's privacy boundary, drawn live from real events.
// Inside the ring: this machine (local GPU, agents, ledger, on-device Nano). The ring: the Privacy Membrane.
// Outside: Firebase AI Logic (cloud Gemini), the web, mesh peers. Every particle is a real event:
//   router.call (local)          agent -> GPU                     (inside, blue)
//   router.call (remote/overflow) agent -> edge tab -> Firebase    (crosses the ring, gold)
//   membrane.crossing            a "N withheld" badge on the ring where sealed text left
//   membrane.egress_blocked      agent -> ring, bounces back      (red flash on the ring)
//   tool.result (web tools)      agent -> web                     (crosses the ring, green)
import { api, type AgencyEvent } from "./api";
import { esc } from "./md";

const W = 900, H = 560, CX = 330, CY = 285, R_CORE = 150, R_RING = 196, R_AGENTS = 104;
const FIREBASE = { x: 760, y: 170 }, WEB = { x: 760, y: 410 }, EDGE = { x: CX + R_RING * Math.cos(-0.45), y: CY + R_RING * Math.sin(-0.45) }, GPU = { x: CX, y: CY };
const WEB_TOOLS = new Set(["web_search", "http_get", "http_post"]);

type P = { x: number; y: number };
type Particle = { from: P; to: P; via?: P; t: number; speed: number; cls: string; bounce?: boolean; label?: string; done?: () => void };

const M = {
  agents: [] as Array<{ id: string; name: string; modelRole: string; hue: number; x: number; y: number }>,
  parts: [] as Particle[],
  raf: 0,
  feed: [] as string[],
  stats: null as any,
  badges: [] as Array<{ x: number; y: number; text: string; at: number; cls: string }>,
  ringFlash: 0,
  statsTimer: 0,
};

/** A stable hue per genome, so each agent keeps its color everywhere. */
function hueOf(genome: string) {
  let h = 0;
  for (const c of genome) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function along(p: Particle): P {
  if (!p.via) return lerp(p.from, p.to, p.t);
  return p.t < 0.5 ? lerp(p.from, p.via, p.t * 2) : lerp(p.via, p.to, (p.t - 0.5) * 2);
}
/** Point where the straight line from a (inside) toward b first meets the membrane ring. */
function ringPoint(a: P, b: P): P {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, ox = a.x - CX, oy = a.y - CY;
  const bq = ox * ux + oy * uy, cq = ox * ox + oy * oy - R_RING * R_RING;
  const t = -bq + Math.sqrt(Math.max(0, bq * bq - cq));
  return { x: a.x + ux * t, y: a.y + uy * t };
}

function agentFor(role?: string) {
  const pool = M.agents.filter((a) => a.modelRole === role);
  const list = pool.length ? pool : M.agents;
  return list[Math.floor(Math.random() * list.length)] || { x: CX, y: CY - R_AGENTS, name: "agent" } as any;
}

function feed(line: string) {
  M.feed.unshift(`<li><span class="t">${new Date().toLocaleTimeString()}</span> ${line}</li>`);
  M.feed.length = Math.min(M.feed.length, 12);
  const el = document.querySelector("#mapfeed");
  if (el) el.innerHTML = M.feed.join("");
}

/** Feed a live agency event into the map. Safe to call when the map is not visible. */
export function mapEvent(e: AgencyEvent) {
  if (!M.agents.length) return;
  if (e.type === "router.call") {
    const a = agentFor(e.role);
    if (!e.remote) {
      M.parts.push({ from: a, to: GPU, t: 0, speed: 0.018, cls: "p-local" });
      feed(`<b class="c-local">local</b> ${esc(e.role)} call on <code>${esc(e.model)}</code> (${e.ms ?? "?"} ms)`);
    } else {
      M.parts.push({ from: a, via: EDGE, to: FIREBASE, t: 0, speed: 0.012, cls: e.sealed ? "p-sealed" : "p-remote", done: () => M.parts.push({ from: FIREBASE, to: EDGE, t: 0, speed: 0.02, cls: "p-return" }) });
      feed(`<b class="c-remote">${e.overflow ? "GPU overflow → " : ""}Firebase</b> ${esc(e.role)} call${e.sealed ? ' <b class="c-sealed">sealed</b>' : ""} (${esc(e.inferenceSource || "?")}, ${e.ms ?? "?"} ms)`);
    }
  } else if (e.type === "membrane.crossing") {
    M.badges.push({ x: EDGE.x + 10, y: EDGE.y - 18, text: `${e.total} withheld`, at: performance.now(), cls: "b-sealed" });
    feed(`<b class="c-sealed">membrane</b> sealed crossing to ${esc(e.provider)}: ${e.total} value(s) withheld (${esc(Object.entries(e.withheld || {}).map(([k, v]) => `${k}×${v}`).join(", ") || "none found")})`);
  } else if (e.type === "membrane.egress_blocked") {
    const a = agentFor();
    M.parts.push({ from: a, to: ringPoint(a, WEB), t: 0, speed: 0.03, cls: "p-blocked", bounce: true });
    M.ringFlash = performance.now();
    feed(`<b class="c-blocked">blocked</b> ${esc(e.tool)} tried to leave with ${e.mode === "private" ? "private work" : `${e.withheld} sensitive value(s)`}`);
  } else if (e.type === "tool.result" && WEB_TOOLS.has(e.tool) && e.ok) {
    const a = agentFor();
    M.parts.push({ from: a, to: WEB, t: 0, speed: 0.014, cls: "p-web" });
    feed(`<b class="c-web">web</b> ${esc(e.tool)} (no sensitive values)`);
  } else return;
  scheduleStats();
}

function scheduleStats() {
  if (M.statsTimer) return;
  M.statsTimer = window.setTimeout(async () => { M.statsTimer = 0; await loadStats(); }, 1500);
}

async function loadStats() {
  const s = await api<any>("/api/sovereignty").catch(() => null);
  if (!s) return;
  M.stats = s;
  const el = document.querySelector("#mapstats");
  if (!el) return;
  const wh = Object.entries(s.membrane.withheld || {}).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join("") || '<span class="dim">none yet</span>';
  el.innerHTML = `
    <div class="stat"><b>${s.session.localCalls}</b><span>model calls on this machine (this session)</span></div>
    <div class="stat"><b>${s.firebase.total}</b><span>Firebase AI Logic calls · ${s.firebase.inCloud} IN_CLOUD · ${s.firebase.onDevice} ON_DEVICE · ${s.firebase.overflow} by GPU overflow</span></div>
    <div class="stat"><b>${s.membrane.valuesWithheld}</b><span>sensitive values withheld across ${s.membrane.crossings} sealed crossing(s)</span><div class="chips">${wh}</div></div>
    <div class="stat"><b>${s.membrane.egressBlocked}</b><span>egress attempts blocked at the membrane</span></div>
    <div class="stat"><b>${s.ledger}</b><span>signed ledger entries · ${s.receipts} receipt(s) issued</span></div>
    <div class="stat"><b>${s.gpu.active}${s.gpu.queued ? ` +${s.gpu.queued}` : ""}</b><span>GPU busy / queued · ${s.edgeWorkers} edge worker(s) online</span></div>`;
  const lg = document.querySelector("#mapledger");
  if (lg) lg.textContent = `#${s.ledger}`;
  const q = document.querySelector("#mapgpu");
  if (q) q.textContent = s.gpu.queued ? `queue ${s.gpu.queued}` : s.gpu.active ? "busy" : "idle";
  const ew = document.querySelector("#mapedge");
  if (ew) ew.setAttribute("class", s.edgeWorkers ? "node edge on" : "node edge");
}

function frame() {
  const layer = document.querySelector("#mapparts");
  if (!layer) { M.raf = 0; return; }
  const now = performance.now();
  for (const p of M.parts) {
    p.t += p.speed;
    if (p.t >= 1) {
      if (p.bounce) { p.bounce = false; const f = p.from; p.from = p.to; p.to = f; p.t = 0; p.cls = "p-blocked back"; continue; }
      p.done?.();
      p.done = undefined;
    }
  }
  M.parts = M.parts.filter((p) => p.t < 1);
  M.badges = M.badges.filter((b) => now - b.at < 4000);
  layer.innerHTML = M.parts.map((p) => { const q = along(p); return `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="5" class="${p.cls}"/>`; }).join("")
    + M.badges.map((b) => `<text x="${b.x}" y="${b.y - (now - b.at) / 120}" class="badge ${b.cls}" opacity="${(1 - (now - b.at) / 4000).toFixed(2)}">${esc(b.text)}</text>`).join("");
  const ring = document.querySelector("#mapring");
  if (ring) ring.setAttribute("class", now - M.ringFlash < 700 ? "ring flash" : "ring");
  M.raf = requestAnimationFrame(frame);
}

export async function viewMap(view: HTMLElement, header: (t: string, s: string, x?: string) => string) {
  const s = await api<any>("/api/sovereignty").catch(() => null);
  M.agents = (s?.agents || []).map((a: any, i: number, all: any[]) => {
    const ang = -Math.PI / 2 + (i / all.length) * Math.PI * 2;
    return { id: a.id, name: a.name, modelRole: a.modelRole, hue: hueOf(a.genome || a.id), x: CX + R_AGENTS * Math.cos(ang), y: CY + R_AGENTS * Math.sin(ang) };
  });
  view.innerHTML = `
    ${header("Sovereignty Map", "Where every model call ran, live. Inside the ring is this machine; the ring is the Privacy Membrane; outside is the cloud. Particles are real events: local calls, GPU overflow to Firebase AI Logic, sealed crossings, and egress the membrane blocked. Totals come from the signed ledger.")}
    <section class="mapwrap">
      <div class="panel mapcanvas">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sovereignty map of the agency's privacy boundary">
          <defs><radialGradient id="coreg"><stop offset="0%" stop-color="var(--bg-soft)"/><stop offset="100%" stop-color="var(--bg-elev)"/></radialGradient></defs>
          <circle cx="${CX}" cy="${CY}" r="${R_RING + 14}" class="halo"/>
          <circle cx="${CX}" cy="${CY}" r="${R_RING}" class="ring" id="mapring"/>
          <text x="${CX}" y="${CY + R_RING + 30}" class="ringlabel">PRIVACY MEMBRANE · sealed text only</text>
          <circle cx="${CX}" cy="${CY}" r="${R_CORE}" fill="url(#coreg)" class="core"/>
          <text x="${CX}" y="${CY - R_CORE + 22}" class="corelabel">THIS MACHINE</text>
          ${M.agents.map((a) => `<line x1="${a.x}" y1="${a.y}" x2="${GPU.x}" y2="${GPU.y}" class="spoke"/>`).join("")}
          <g class="node gpu"><circle cx="${GPU.x}" cy="${GPU.y}" r="36"/><text x="${GPU.x}" y="${GPU.y - 2}">LOCAL GPU</text><text x="${GPU.x}" y="${GPU.y + 13}" class="sub" id="mapgpu">idle</text></g>
          ${M.agents.map((a) => `<g class="node agent"><circle cx="${a.x}" cy="${a.y}" r="13" style="fill:hsl(${a.hue} 45% 32%);stroke:hsl(${a.hue} 60% 62%)"><title>${esc(a.name)} · ${esc(a.modelRole)}</title></circle><text x="${a.x}" y="${a.y + 26}" class="sub">${esc(a.name)}</text></g>`).join("")}
          <g class="node ledger"><rect x="${CX - 48}" y="${CY + 58}" width="96" height="34" rx="8"/><text x="${CX}" y="${CY + 73}">LEDGER</text><text x="${CX}" y="${CY + 86}" class="sub" id="mapledger">#${s?.ledger ?? "–"}</text></g>
          <g class="node edge" id="mapedge"><circle cx="${EDGE.x}" cy="${EDGE.y}" r="15"/><text x="${EDGE.x + 22}" y="${EDGE.y + 32}" class="sub left">edge worker (this browser)</text></g>
          <path d="M ${FIREBASE.x - 58} ${FIREBASE.y + 14} a 26 26 0 0 1 22 -40 a 34 34 0 0 1 62 -6 a 24 24 0 0 1 32 30 a 20 20 0 0 1 -6 16 z" class="cloud"/>
          <text x="${FIREBASE.x}" y="${FIREBASE.y + 34}" class="extlabel">Firebase AI Logic</text><text x="${FIREBASE.x}" y="${FIREBASE.y + 49}" class="sub">cloud Gemini (IN_CLOUD)</text>
          <g class="node web"><rect x="${WEB.x - 46}" y="${WEB.y - 20}" width="92" height="40" rx="20"/><text x="${WEB.x}" y="${WEB.y + 4}">THE WEB</text></g>
          <text x="${WEB.x}" y="${WEB.y + 38}" class="sub">search · http tools</text>
          <g id="mapparts"></g>
        </svg>
        <div class="legend"><span><i class="p-local"></i>local call</span><span><i class="p-remote"></i>Firebase call</span><span><i class="p-sealed"></i>sealed crossing</span><span><i class="p-web"></i>web tool</span><span><i class="p-blocked"></i>blocked egress</span></div>
      </div>
      <div class="mapside">
        <section class="stats" id="mapstats"></section>
        <section class="panel"><h2>Live boundary feed</h2><ul class="mapfeed" id="mapfeed">${M.feed.join("") || '<li class="dim">Waiting for activity. Launch a mission (try privacy "sealed") or use the Privacy Membrane on Hybrid Edge.</li>'}</ul></section>
      </div>
    </section>`;
  await loadStats();
  if (!M.raf) M.raf = requestAnimationFrame(frame);
}
