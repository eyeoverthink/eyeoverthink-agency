#!/usr/bin/env node
// EyeOverThink Agency CLI. The SQLite ExperimentalWarning filter must be installed before node:sqlite loads,
// so everything else is imported dynamically.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const { main } = await import('../src/cli/cli.js');
main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`error: ${e?.message || e}\n`);
  process.exit(1);
});
