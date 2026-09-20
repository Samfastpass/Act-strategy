// Runs the site's own engine (js/cost-model.js + js/strategy-engine.js) in Node on
// a fixed input and prints results as JSON. Used only by tools/check_js_vs_python.py.
//
//   node tools/js_reference_runner.js <input.json>      (input written by the Python script)
//
// Nothing here re-implements the maths: it loads the real site files, so what is
// compared against strategy_lib.py is exactly what the browser runs.
const fs = require('fs'), vm = require('vm'), path = require('path');
global.window = global;
const root = path.join(__dirname, '..');
['js/cost-model.js', 'js/strategy-engine.js'].forEach(f =>
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }));

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prices = input.prices.map(r => ({ date: r[0], close: r[1] }));
const ref = JSON.parse(fs.readFileSync(path.join(root, 'reference-rates.json'), 'utf8'));
const ca = JSON.parse(fs.readFileSync(path.join(root, 'cost-assumptions.json'), 'utf8')).SP500;

function monthly(name) {
  const ser = ref[name].series, m = {};
  ser.forEach(r => { m[r[0]] = r[1]; });
  return d => { const k = d.slice(0, 7); if (m[k] != null) return m[k]; return k < ser[0][0] ? ser[0][1] : ser[ser.length - 1][1]; };
}
const costs = {
  products: ca.products.map(p => ({ leverage: p.leverage, mgmtFeePct: p.mgmtFeePct, dailySwapRatePct: p.dailySwapRatePct, fundingSpreadPct: p.fundingSpreadPct + p.basisPct })),
  rateForDate: monthly('FEDFUNDS'), dividendYieldForDate: monthly('SPXDIV'), slippageBpsRoundTrip: input.slippageBps
};
const closes = prices.map(p => p.close);
const volCache = {};

const out = input.configs.map(c => {
  let params = { smaLen: c.sma, buffer: c.buffer, annualization: 252, sizing: { mode: 'fixedLeverage' } };
  if (c.gate == null) {
    params = Object.assign(params, { volLen: null, volGate: null, leverage: { base: c.high, gated: null } });
  } else {
    volCache[c.volLen] = volCache[c.volLen] || StrategyEngine.realizedVol(closes, c.volLen, 252);
    params = Object.assign(params, { volLen: c.volLen, volGate: c.gate, leverage: { base: c.high, gated: c.low }, latch: c.latch, volSeries: volCache[c.volLen] });
  }
  const w = StrategyEngine.walk(prices, params);
  // exposure: the walk's leverage while IN, c.out while OUT (0 = cash), from the walk's start onward
  const expo = w.state.map((s, i) => (s > 0 ? s : (i >= w.startIdx ? (c.out || 0) : 0)));
  const curve = StrategyEngine.compoundEquity(prices, expo, w.startIdx, prices.length - 1, c.costs ? costs : null);
  return { final: curve[curve.length - 1].equity };
});
process.stdout.write(JSON.stringify(out));
