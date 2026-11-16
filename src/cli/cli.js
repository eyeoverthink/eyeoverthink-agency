// CLI. Commands run the agency in-process; `serve` starts the API + dashboard.
import fs from 'node:fs';
import { Agency } from '../agency.js';
import { createServer } from '../server/server.js';
import { McpServer } from '../protocols/mcp.js';
import { encodeDna, decodeDna, encodeCodon, decodeCodon, gcContent } from '../core/dna.js';
import { truncate } from '../core/util.js';

const HELP = `EyeOverThink Agency — sovereign multi-agent platform

Usage: agency <command> [args] [--flags]

  serve [--port N]                 Start API + dashboard (resumes interrupted missions, runs dream/autonomy schedulers)
  status                           Agency status and counts
  models                           Model router status (Ollama diagnosis, role resolution, edge workers)
  selftest                         Prove every subsystem works (ALL_CLEAR expected)

  mission "<goal>" [--mode standard|logic_chain|consensus] [--private]
                                   Run a full mission and print the deliverable
  ask <agent> "<task>" [--private] Ask one agent
  agents                           List agents (genome traits, fitness)
  agents forge "<description>"     Design and register a new agent
  agents roster "<business>" "<goal>" [--count 4] [--commit]
  agents import <dir> [dir...]     Import FRAYMUS/Chandra *.md manifests
  agents evolve <id> [--population 4]
  agents export <id> <file>        Export an agent as a signed DNA plasmid (organism)
  agents adopt <file>              Import an organism plasmid

  memory search "<query>"          Hybrid recall
  memory add "<text>" [--kind fact|semantic|episodic]
  memory law "<text>"              Add an owner law (governance memory, injected into every agent)
  ledger verify | ledger tail [N]  Verify the signed hash chain / show recent entries
  approvals | approve <id> | deny <id>
  workflow list | workflow run <id> '<json input>'
  goals | goals add "<goal>" [--every 24] | goals remove <id> | autonomy on|off
  dream                            Run a consolidation cycle now
  bench [suite]                    Run the deterministic benchmark suite
  export | snapshot | restore <file>   Brain-dump handoff / organism snapshot / restore
  dna encode "<text>" [--codon] | dna decode <strand> [--codon]
  mcp                              Run as an MCP server on stdio (for Claude Code, IDEs)
  token                            Print the API token for the dashboard
`;

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const out = (x) => process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x, null, 2)) + '\n');

function streamEvents(agency, filter) {
  agency.bus.on('*', (e) => {
    if (filter && !filter(e)) return;
    const t = new Date(e.ts).toLocaleTimeString();
    if (e.type === 'mission.plan') out(`[${t}] plan: ${e.plan.tasks.map((x) => `${x.id}→${x.agent}`).join(', ')}`);
    else if (e.type === 'task.status') out(`[${t}] task ${e.taskId.split(':').pop()} ${e.status}${e.score != null ? ` score=${e.score}` : ''}${e.error ? ` (${e.error})` : ''}`);
    else if (e.type === 'task.critique') out(`[${t}]   critic attempt ${e.attempt}: ${e.score} ${e.pass ? 'PASS' : 'retry'}`);
    else if (e.type === 'tool.result') out(`[${t}]   ${e.agentId} → ${e.tool} ${e.ok ? 'ok' : 'FAILED'}`);
    else if (e.type === 'mission.status') out(`[${t}] mission ${e.status}`);
    else if (e.type === 'router.fallback') out(`[${t}]   fallback from ${e.from}: ${truncate(e.error, 120)}`);
    else if (e.type === 'logic_chain.stage') out(`[${t}] stage ${e.stage} ${e.ok ? 'ok' : 'failed'} (${e.model || '-'})`);
    else if (e.type === 'approval.request') out(`[${t}] APPROVAL NEEDED ${e.id}: ${e.tool} ${JSON.stringify(e.args).slice(0, 200)}  → run: agency approve ${e.id}`);
  });
}

export async function main(argv) {
  const { pos, flags } = parse(argv);
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || flags.help) return out(HELP);

  if (cmd === 'mcp') {
    const agency = new Agency();
    await agency.boot({ schedulers: false, resume: false });
    new McpServer(agency).start();
    return;
  }

  if (cmd === 'serve') {
    const overrides = {};
    if (flags.port) overrides.port = Number(flags.port);
    if (flags.home) overrides.home = String(flags.home);
    if (flags.ollama) overrides.ollama = { url: String(flags.ollama) };
    const agency = new Agency(overrides);
    await agency.boot();
    const server = createServer(agency);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(agency.cfg.port, agency.cfg.host, resolve); });
    const st = await agency.router.status();
    out(`EyeOverThink Agency listening on http://${agency.cfg.host}:${agency.cfg.port}`);
    out(`  identity ${agency.keyring.get('agency').fingerprint} · ${agency.agents.list().length} agents · data ${agency.cfg.home}`);
    out(`  API token: ${agency.cfg.home}/api-token`);
    out(`  reason → ${st.roles.reason.join(', ') || 'NO MODEL'} | code → ${st.roles.code.join(', ') || '-'}`);
    for (const n of st.ollama.notes) out(`  ! ${n}`);
    if (agency.resumed?.length) out(`  resumed missions: ${agency.resumed.join(', ')}`);
    const stop = async () => { out('shutting down…'); server.close(); await agency.shutdown(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  const agency = new Agency();
  await agency.boot({ schedulers: false, resume: false });
  try {
    switch (cmd) {
      case 'token': out(agency.cfg.apiToken); break;
      case 'status': out(await agency.status()); break;
      case 'models': out(await agency.router.status()); break;
      case 'selftest': {
        const r = await agency.continuity.selftest();
        for (const c of r.checks) out(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — ${c.error}`}`);
        out(r.verdict);
        if (r.verdict !== 'ALL_CLEAR') process.exitCode = 2;
        break;
      }
      case 'mission': {
        const goal = pos.slice(1).join(' ');
        if (!goal) throw new Error('usage: agency mission "<goal>"');
        const m = agency.missions.create(goal, { mode: flags.mode, privacy: flags.private ? 'private' : 'normal' });
        out(`mission ${m.id} (${m.options.mode})`);
        streamEvents(agency, (e) => !e.missionId || e.missionId === m.id);
        const done = await agency.missions.waitFor(m.id, 4 * 3600000);
        out('\n' + '='.repeat(72));
        if (done.status === 'completed') {
          out(done.result.deliverable);
          out('='.repeat(72));
          out(`score ${done.score} · replans ${done.replans} · security ${done.result.security?.risk ?? 'n/a'}`);
        } else out(`mission ${done.status}: ${done.error || ''}`);
        break;
      }
      case 'ask': {
        const [, agentId, ...rest] = pos;
        streamEvents(agency, (e) => e.type === 'tool.result' || e.type === 'router.fallback' || e.type === 'approval.request');
        const r = await agency.runtime.run(agentId, rest.join(' '), { privacy: flags.private ? 'private' : 'normal' });
        out(r.final);
        out(`\n(${r.model}, confidence ${r.confidence}, ${r.toolCalls} tool calls)`);
        break;
      }
      case 'agents': {
        const sub = pos[1];
        const known = new Set(agency.tools.catalog().map((t) => t.name));
        if (!sub) {
          for (const a of agency.agents.list()) out(`${a.id.padEnd(16)} ${a.role.padEnd(30)} ${a.modelRole.padEnd(10)} fit=${a.fitness ?? '-'} gen=${a.generation} T=${a.traits.temperature} tools=${a.tools.join(',')}`);
        } else if (sub === 'forge') out(await agency.forge.create(pos.slice(2).join(' ')));
        else if (sub === 'roster') out(await agency.forge.roster({ business: pos[2], goal: pos[3], count: Number(flags.count || 4), commit: Boolean(flags.commit) }));
        else if (sub === 'import') out(agency.agents.importManifests(pos.slice(2), known));
        else if (sub === 'evolve') out(await agency.evolution.evolve(pos[2], { population: Number(flags.population || 4) }));
        else if (sub === 'export') { const o = agency.agents.exportOrganism(pos[2], agency.memory.playbook(pos[2], 10).map((p) => p.content)); fs.writeFileSync(pos[3], JSON.stringify(o.plasmid)); out(`wrote ${pos[3]} (strand ${o.plasmid.strand.length} nt, gc ${o.plasmid.gc})`); }
        else if (sub === 'adopt') out(agency.agents.importOrganism(JSON.parse(fs.readFileSync(pos[2], 'utf8'))).agent);
        else throw new Error(`unknown agents subcommand ${sub}`);
        break;
      }
      case 'memory': {
        const sub = pos[1], text = pos.slice(2).join(' ');
        if (sub === 'search') for (const m of await agency.memory.recall(text, { k: 10 })) out(`${m.score.toFixed(3)} [${m.kind}] ${truncate(m.content, 200)}`);
        else if (sub === 'add') out(await agency.memory.write({ content: text, kind: flags.kind || 'fact', source: 'cli' }));
        else if (sub === 'law') out(await agency.memory.write({ content: text, kind: 'governance', importance: 1, source: 'owner' }));
        else throw new Error('usage: agency memory search|add|law "<text>"');
        break;
      }
      case 'ledger': {
        if (pos[1] === 'tail') for (const e of agency.ledger.list({ limit: Number(pos[2] || 20) }).reverse()) out(`#${e.seq} ${e.ts} ${e.kind.padEnd(22)} ${e.actor.padEnd(10)} ${truncate(JSON.stringify(e.data), 110)}`);
        else { const v = agency.ledger.verify(); out(v.ok ? `VERIFIED ${v.count} entries · merkle ${v.merkleRoot}` : `BROKEN at #${v.brokenAt}: ${v.reason}`); if (!v.ok) process.exitCode = 3; }
        break;
      }
      case 'approvals': for (const p of agency.approvals.list('pending')) out(`${p.id} ${p.tool} by ${p.agent_id || '-'}: ${JSON.stringify(p.args).slice(0, 200)}`); break;
      case 'approve': case 'deny': out(agency.approvals.decide(pos[1], cmd === 'approve', 'cli')); break;
      case 'workflow': {
        if (pos[1] === 'run') out(await agency.workflows.run(pos[2], pos[3] ? JSON.parse(pos[3]) : {}));
        else for (const w of agency.workflows.list()) out(`${w.id.padEnd(22)} ${w.name}${w.deployed ? ' [deployed]' : ''}`);
        break;
      }
      case 'goals': {
        if (pos[1] === 'add') out(agency.addGoal(pos.slice(2).join(' '), Number(flags.every || 24)));
        else if (pos[1] === 'remove') { agency.removeGoal(pos[2]); out('removed'); }
        else out(agency.goals());
        break;
      }
      case 'autonomy': agency.store.kvSet('autonomy:enabled', pos[1] === 'on'); out(`autonomy ${pos[1] === 'on' ? 'enabled' : 'disabled'} (takes effect in the running server on its next tick)`); break;
      case 'dream': out(await agency.dreamer.cycle({ force: true })); break;
      case 'bench': {
        streamEvents(agency, (e) => e.type === 'bench.item');
        agency.bus.on('bench.item', (r) => out(`${r.pass ? 'PASS' : 'FAIL'} ${r.id.padEnd(18)} ${r.agent.padEnd(12)} ${r.ms}ms ${r.error || ''}`));
        const r = await agency.bench.run(pos[1] || 'core');
        out(`score ${r.score} (${r.passed}/${r.total}) models: ${r.models.join(', ')}`);
        break;
      }
      case 'export': out(agency.continuity.brainDump()); break;
      case 'snapshot': out(agency.continuity.snapshot()); break;
      case 'restore': out(agency.continuity.restore(pos[1])); break;
      case 'dna': {
        const codon = Boolean(flags.codon);
        if (pos[1] === 'encode') { const s = codon ? encodeCodon(pos.slice(2).join(' ')) : encodeDna(pos.slice(2).join(' ')); out(s); out(`(${s.length} nt, GC ${(gcContent(s) * 100).toFixed(1)}%)`); }
        else out((codon ? decodeCodon(pos[2]) : decodeDna(pos[2])).toString('utf8'));
        break;
      }
      default: out(HELP); process.exitCode = 1;
    }
  } finally {
    await agency.shutdown();
  }
}
