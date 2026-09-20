/* 校验 optics.js 的数值正确性（Node 环境） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'optics.js'), 'utf8');
const sandbox = { window: {}, Math, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const O = sandbox.window.Optics;

let fail = 0;
function ok(name, got, want, tol) {
  tol = tol === undefined ? 1e-6 : tol;
  const pass = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} got=${got.toPrecision(10)}  want=${want.toPrecision(10)}`);
}

console.log('=== 1. 立体角 ===');
ok('Ω(90°) = 2π', O.solidAngle(Math.PI / 2), 2 * Math.PI);
ok('Ω(180°) = 4π', O.solidAngle(Math.PI), 4 * Math.PI);
// 参考图算例：θ = 19° → 0.342 sr
ok('Ω(19°) [参考图 0.342 sr]', O.solidAngle(19 * Math.PI / 180), 0.34232, 3e-4);
ok('Ω(19°)/4π [参考图 2.72%]', O.solidAngle(19 * Math.PI / 180) / (4 * Math.PI), 0.027242, 1e-4);

console.log('\n=== 2. 配光指数 ===');
const n = O.exponentFromHalfAngle(19 * Math.PI / 180);
ok('n(γ½=19°) = ln0.5/ln(cos19°)', n, Math.log(0.5) / Math.log(Math.cos(19 * Math.PI / 180)), 1e-12);
ok('n(γ½=19°) 数值', n, 12.37282387, 1e-7);
// 定义校验：cos^n(γ½) 必须 = 0.5（这是 n 的唯一判据）
ok('cos^n(19°) 应 = 0.5', Math.pow(Math.cos(19 * Math.PI / 180), n), 0.5, 1e-12);
ok('n(γ½=45°)', O.exponentFromHalfAngle(45 * Math.PI / 180), 2.0, 1e-12);
ok('cos^n(45°) 应 = 0.5', Math.pow(Math.cos(Math.PI / 4), O.exponentFromHalfAngle(Math.PI / 4)), 0.5, 1e-12);
ok('n(γ½=60°)', O.exponentFromHalfAngle(60 * Math.PI / 180), 1.0, 1e-12);

console.log('\n=== 3. 模型：Φ=9000lm, 光束角38° ===');
const m = O.buildModel({
  model: 'cosN', flux: 9000,
  gammaHalfRad: 19 * Math.PI / 180, centerIntensity: null
});
ok('n', m.n, 12.37282387, 1e-7);
ok('I₀ = Φ(n+1)/2π', m.Imax, 9000 * (n + 1) / (2 * Math.PI), 1e-9);
ok('I₀ 数值', m.Imax, 19155.1592, 1e-8);
console.log('      I₀ =', m.Imax.toFixed(2), 'cd    （参考图用的 Φ/Ω =',
            (9000 / m.omegaHalf).toFixed(2), 'cd）');

// 数值积分总光通量必须回到 9000 lm —— 这是最强的一致性校验
const N = 400000, dg = (Math.PI / 2) / N;
let flux = 0;
for (let i = 0; i < N; i++) {
  const g = (i + 0.5) * dg;
  flux += O.intensity(m, g) * Math.sin(g) * dg * 2 * Math.PI;
}
ok('∫I dΩ 回算总光通量 = Φ', flux, 9000, 1e-5);

console.log('\n=== 4. 照度 ===');
ok('E_max = I₀/h²  (h=3)', O.illuminance(m, 3, 0), m.Imax / 9, 1e-12);
const R50 = O.spotRadius(3, 19 * Math.PI / 180);
ok('R½ = h·tan19°', R50, 3 * Math.tan(19 * Math.PI / 180), 1e-12);
console.log('      R½ =', R50.toFixed(4), 'm');
const Emin = O.illuminance(m, 3, R50);
console.log('      E_min =', Emin.toFixed(2), 'lx');

// 与严格定义核对：E = I(γ)cosγ/d²
const d = Math.sqrt(9 + R50 * R50), cg = 3 / d;
const g = Math.acos(cg);
ok('E_min 与逐项定义一致', Emin, O.intensity(m, g) * cg / (d * d), 1e-12);
ok('边缘 γ 应 = 19°', g * 180 / Math.PI, 19, 1e-9);
ok('边缘 I 应 = I₀/2', O.intensity(m, g), m.Imax / 2, 1e-9);

console.log('\n=== 5. 面域平均照度 ===');
const res = O.analyze(m, 3, { type: 'circle', R: R50 });
ok('圆形闭合解 Φ_A', res.fluxOnArea, 2 * Math.PI * m.Imax * (1 - Math.pow(Math.cos(19 * Math.PI / 180), n + 1)) / (n + 1), 1e-9);
// 与二维数值积分对照（独立路径）
const NN = 3000, Rr = R50;
let fsum = 0;
for (let i = 0; i < NN; i++) {
  const rr = (i + 0.5) * Rr / NN;
  fsum += 2 * Math.PI * rr * O.illuminance(m, 3, rr) * (Rr / NN);
}
ok('圆盘光通量：闭合解 vs 数值积分', res.fluxOnArea, fsum, 1e-4);
ok('E_avg = Φ_A/(πR²)', res.Eavg, res.fluxOnArea / (Math.PI * Rr * Rr), 1e-12);
console.log('      E_max =', res.Emax.toFixed(1), ' E_min =', res.Emin.toFixed(1),
            ' E_avg =', res.Eavg.toFixed(1), ' lx');
console.log('      U(Emin/Emax) =', (res.Umax * 100).toFixed(1) + '%',
            ' U(Emin/Eavg) =', (res.Uavg * 100).toFixed(1) + '%',
            ' 利用率 =', (res.utilization * 100).toFixed(1) + '%');

console.log('\n=== 6. 矩形数值积分 ===');
const rect = O.analyze(m, 3, { type: 'rect', L: 1.2, W: 0.6 });
ok('矩形面积', rect.area, 0.72, 1e-12);
ok('矩形 E_min 取角点', rect.rFar, Math.hypot(0.6, 0.3), 1e-12);
ok('矩形 E_min', rect.Emin, O.illuminance(m, 3, Math.hypot(0.6, 0.3)), 1e-12);
console.log('      矩形: E_max =', rect.Emax.toFixed(1), ' E_min =', rect.Emin.toFixed(1),
            ' E_avg =', rect.Eavg.toFixed(1), ' 利用率 =', (rect.utilization * 100).toFixed(1) + '%');
// 矩形积分收敛性：不同 N 应给出接近结果
const r2 = O.analyze(m, 3, { type: 'rect', L: 1.2, W: 0.6 });
ok('矩形积分单调合理（Emin<Eavg<Emax）',
   (rect.Emin < rect.Eavg && rect.Eavg < rect.Emax) ? 1 : 0, 1, 0);

console.log('\n=== 7. 均匀锥配光（参考图算法） ===');
const mu = O.buildModel({ model: 'uniform', flux: 9000, gammaHalfRad: 19 * Math.PI / 180 });
ok('均匀模型 I₀ = Φ/Ω', mu.Imax, 9000 / mu.omegaHalf, 1e-12);
console.log('      I₀ =', mu.Imax.toFixed(2), 'cd  （参考图 26 291 cd）');
ok('该值与参考图一致', mu.Imax, 26291, 3e-4);
// 锥内光通量应恰好等于总光通量
ok('锥内 Φ = 总 Φ', O.fluxInCone(mu, 19 * Math.PI / 180), 9000, 1e-9);

console.log('\n=== 8. 简化式 vs 严格式 ===');
const rTest = 2.0;
const cg2 = O.cosineFactor(3, rTest);
// 简化式 E=I/d² 相对严格式的倍数 = 1/cosγ（恒 ≥ 1，即简化式偏大）
ok('简化/严格 = 1/cosγ', O.illuminanceNoCos(m, 3, rTest) / O.illuminance(m, 3, rTest), 1 / cg2, 1e-12);
ok('1/cosγ > 1（简化式必然高估）',
   O.illuminanceNoCos(m, 3, rTest) / O.illuminance(m, 3, rTest) > 1 ? 1 : 0, 1, 0);

console.log('\n=== 9. 半光强锥内的光通量占比 ===');
ok('Φ_cone/Φ', m.fluxInHalfCone / m.flux, 4745.166410 / 9000, 1e-6);
console.log('      锥内占比 =', (m.fluxInHalfCone / m.flux * 100).toFixed(2) + '%',
            ' 锥外 =', ((1 - m.fluxInHalfCone / m.flux) * 100).toFixed(2) + '%');
console.log('      Φ/Ω =', m.ImaxConeAverage.toFixed(2), 'cd（假设全落锥内容易高估）');
console.log('      锥内真实平均光强 =', m.coneAverageIntensity.toFixed(2), 'cd');

console.log('\n=== 10. 球面微元的精确闭式 vs 微分近似 ===');
// 精确：Ω = ∫∫ sinθ dθ dφ = Δφ·(cosθ₁ − cosθ₂)
function patchExact(t1, t2, p1, p2) { return (p2 - p1) * (Math.cos(t1) - Math.cos(t2)); }
function patchNum(t1, t2, p1, p2, N) {
  N = N || 600;
  var s = 0, dt = (t2 - t1) / N, dp = (p2 - p1) / N, i, j;
  for (i = 0; i < N; i++) for (j = 0; j < N; j++) s += Math.sin(t1 + (i + 0.5) * dt) * dt * dp;
  return s;
}
{
  var a = 10.5 * Math.PI / 180, dt2 = 3 * Math.PI / 180, dp2 = 20 * Math.PI / 180;
  var t1 = a - dt2 / 2, t2 = a + dt2 / 2;
  ok('微元精确闭式 = 数值二重积分', patchExact(t1, t2, 0, dp2), patchNum(t1, t2, 0, dp2), 1e-6);
}

// 中点法 vs 起点法：页面上的偏差数字必须成立
var midCases = [
  { t0: 10.5, dth: 3, dps: 20, midTol: 0.01 },
  { t0: 30, dth: 8, dps: 30, midTol: 0.01, startDev: -0.1051 },
  { t0: 30, dth: 25, dps: 30, midTol: 0.01, startDev: -0.2540 },
  { t0: 10.5, dth: 20, dps: 20, midTol: 0.01 }
];
midCases.forEach(function (c) {
  var D2 = Math.PI / 180;
  var t1 = c.t0 * D2, t2 = (c.t0 + c.dth) * D2, dp3 = c.dps * D2;
  var ex = patchExact(t1, t2, 0, dp3);
  var midDev = Math.sin((t1 + t2) / 2) * (t2 - t1) * dp3 / ex - 1;
  ok('中点法偏差 ' + c.t0 + '°/' + c.dth + '° 应 < ' + (c.midTol * 100) + '%',
     Math.abs(midDev) < c.midTol ? 1 : 0, 1, 0);
  if (c.startDev !== undefined) {
    var startDev = Math.sin(t1) * (t2 - t1) * dp3 / ex - 1;
    ok('起点法偏差 ' + c.t0 + '°/' + c.dth + '° ≈ ' + (c.startDev * 100).toFixed(1) + '%',
       startDev, c.startDev, 5e-3);
  }
});

// 极点裁剪：α 小、dθ 大时区间被裁到 0，必须用真实中点
{
  var D3 = Math.PI / 180;
  var t1c = Math.max(0, (1 - 20 / 2) * D3), t2c = Math.min(Math.PI, (1 + 20 / 2) * D3);
  var exc = patchExact(t1c, t2c, 0, 20 * D3);
  var midc = Math.sin((t1c + t2c) / 2) * (t2c - t1c) * 20 * D3;
  var bad = Math.sin(1 * D3) * (t2c - t1c) * 20 * D3;
  ok('极点裁剪后用真实中点，偏差 < 1%', Math.abs(midc / exc - 1) < 0.01 ? 1 : 0, 1, 0);
  ok('极点裁剪后若仍用未裁剪中心角，偏差 > 50%（反例）', Math.abs(bad / exc - 1) > 0.5 ? 1 : 0, 1, 0);
  console.log('      α=1°, dθ=20°：真实中点法偏差',
              ((midc / exc - 1) * 100).toFixed(2) + '%',
              ' | 误用中心角偏差', ((bad / exc - 1) * 100).toFixed(1) + '%');
}

console.log('\n' + (fail === 0 ? '全部通过 ✔' : `${fail} 项失败 ✘`));
process.exit(fail === 0 ? 0 : 1);
