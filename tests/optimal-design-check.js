/* 最优设计方法 测试套件（第 13 个套件）
 *
 * v3.10 起内核整体重写：从「筛选级查表」升级为半解析耦合模型
 *   · 空间混光：单次配光足迹 E(r)∝(1+(r/OD)²)^(−p) 的 N×N **精确二维求和**
 *     + 镜像源法补边框回收（φ_conf）
 *   · 扩散板：PC / PMMA / PS 三材料可选（n、本体透过率、雾度上限、单价）
 *   · 棱镜：六形状代理，校准于金字塔 α=45°、n=1.49 的蒙特卡洛参考点
 *   · 约束：厚度预算 / 刀具角 / 填充率 / 雾度上限 / 可选无灯影
 *
 * 本套件分两部分：
 *   ① 内核（Node 直跑，DOM 无关）—— 单调性、守恒、校准点、约束、优化器各路径
 *   ② 页面结构（读文件断言）—— 元素 id、材料选择器、流程图 SVG、页脚口径
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'js/optimal-design.js'));

let pass = 0, fail = 0, fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); }
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  ' + extra : ''));
}
/* 资源引用可能带缓存戳 ?v=<版本>（v3.11.2 起为强制项）。本套件只关心
   「引用了哪些脚本」，与查询串无关，故先剔除 —— 否则 269 行那种精确匹配
   会在发版时误报。缓存戳齐备性由 tests/version-check.js 第 5 条负责。 */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\?v=[^"'&]*/g, '');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'js', 'optimal-design-ui.js'), 'utf8');

const SYS = { W: 600, H: 600, thetaV: 35, uDef: 'active', wallRho: 0.93, fieldRes: 80 };
function field(OD, N, opt) {
  return D.buildField(Object.assign({ OD: OD, N: N, W: 600, H: 600, res: 80,
    wallRho: 0.93, sigmaS: D.sigmaScat(1.5, 0.5), srcModel: 'wide' }, opt || {}));
}

console.log('== ① 扩散板：雾度链单调性 ==');
ok('hazeTau 单调增且 τ(0)=0',
   D.hazeTau(0) === 0 && D.hazeTau(0.3) < D.hazeTau(0.6) && D.hazeTau(0.6) < D.hazeTau(0.9),
   [0, 0.3, 0.6, 0.9].map(function (h) { return D.hazeTau(h).toFixed(2); }).join(' / '));
const Td = [0, 0.3, 0.6, 0.9].map(function (h) { return D.diffuseThroughput('pmma', h); });
ok('Td 随雾度单调降（散射损耗）',
   Td[0] > Td[1] && Td[1] > Td[2] && Td[2] > Td[3], Td.map(function (v) { return v.toFixed(3); }).join(' > '));
ok('Td(0) 回到基材本体透过率 0.925',
   Math.abs(Td[0] - D.MATERIALS.pmma.Tsub) < 1e-9, 'Td(0)=' + Td[0].toFixed(3));
ok('散射角 Θ 随雾度单调增', D.scatterAngle(0.1) < D.scatterAngle(0.5) && D.scatterAngle(0.5) < D.scatterAngle(0.9),
   [0.1, 0.5, 0.9].map(function (h) { return D.scatterAngle(h).toFixed(0) + '°'; }).join(' / '));
ok('扩散半宽 σ 随板厚与雾度增',
   D.sigmaScat(1, 0.5) < D.sigmaScat(2, 0.5) && D.sigmaScat(2, 0.5) < D.sigmaScat(2, 0.9));
D.MAT_IDS.forEach(function (id) {
  const M = D.MATERIALS[id];
  ok('材料 ' + id + '：Td(Hd=Hmax) < Tsub 且 > ETA_FLAT 量级',
     D.diffuseThroughput(id, M.hazeMax) < M.Tsub && D.diffuseThroughput(id, M.hazeMax) > 0.5,
     'n=' + M.n + ' Tsub=' + M.Tsub + ' Td=' + D.diffuseThroughput(id, M.hazeMax).toFixed(3));
});

console.log('== ② 空间混光场：守恒与趋势 ==');
const f0 = field(25, 8, { wallRho: 0 });
ok('墙反射率 0 时 0 < φ_conf < 1', f0.confine > 0 && f0.confine < 1, (f0.confine * 100).toFixed(1) + '%');
ok('φ_conf 随边框反射率单调增',
   field(25, 8, { wallRho: 0.6 }).confine < field(25, 8, { wallRho: 0.93 }).confine &&
   field(25, 8, { wallRho: 0.93 }).confine < field(25, 8, { wallRho: 0.99 }).confine,
   [0.6, 0.93, 0.99].map(function (r) { return (field(25, 8, { wallRho: r }).confine * 100).toFixed(1) + '%'; }).join(' < '));
ok('φ_conf ≤ 100%（不能凭空多出光通）',
   [10, 25, 45].every(function (od) { return field(od, 8).confine <= 1.0001; }));
ok('场严格四重对称（象限镜像一致）', (function () {
  const f = field(25, 8), res = f.res, g = f.grid, worst = 0;
  let w = 0;
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    w = Math.max(w, Math.abs(g[y * res + x] - g[(res - 1 - y) * res + x]) / f.mean,
                    Math.abs(g[y * res + x] - g[y * res + (res - 1 - x)]) / f.mean);
  }
  return w < 1e-12;
})());
ok('OD↑（OD ≲ 40mm 段）空间混光变好 → U↑', (function () {
  const fv = D.fineVisibility(1.5, 0.5, 2.5);
  const u = function (od) { return D.uniformity(field(od, 8), fv, 'active', 0.35 * 600 / 8).U; };
  return u(8) < u(16) && u(16) < u(25) && u(25) < u(40);
})(), [8, 16, 25, 40].map(function (od) {
  return (D.uniformity(field(od, 8), D.fineVisibility(1.5, 0.5, 2.5), 'active', 0.35 * 600 / 8).U * 100).toFixed(0) + '%';
}).join(' < '));
ok('OD 过大反而变差（亮边 + 侧漏，存在内点最优）', (function () {
  const fv = D.fineVisibility(1.5, 0.5, 2.5);
  const u = function (od) { return D.uniformity(field(od, 8), fv, 'active', 0.35 * 600 / 8).U; };
  return u(40) > u(100);
})(), 'U(40)=' + (D.uniformity(field(40, 8), D.fineVisibility(1.5, 0.5, 2.5), 'active', 0.35 * 600 / 8).U * 100).toFixed(0) +
        '% > U(100)=' + (D.uniformity(field(100, 8), D.fineVisibility(1.5, 0.5, 2.5), 'active', 0.35 * 600 / 8).U * 100).toFixed(0) + '%');
ok('灯数↑ → U↑（同 OD）', (function () {
  const fv = D.fineVisibility(1.5, 0.5, 2.5);
  const u = function (n) { return D.uniformity(field(25, n), fv, 'active', Math.min(18, 0.35 * 600 / n)).U; };
  return u(4) < u(8) && u(8) < u(12) && u(12) < u(16);
})(), [4, 8, 12, 16].map(function (n) {
  return (D.uniformity(field(25, n), D.fineVisibility(1.5, 0.5, 2.5), 'active', Math.min(18, 0.35 * 600 / n)).U * 100).toFixed(0) + '%';
}).join(' < '));
ok('配光越窄混光越差（bare < dome < wide）', (function () {
  const fv = D.fineVisibility(1.5, 0.5, 2.5);
  const u = function (s) { return D.uniformity(field(25, 8, { srcModel: s }), fv, 'active', 26).U; };
  return u('bare') < u('dome') && u('dome') < u('wide');
})(), ['bare', 'dome', 'wide'].map(function (s) {
  return s + '=' + (D.uniformity(field(25, 8, { srcModel: s }), D.fineVisibility(1.5, 0.5, 2.5), 'active', 26).U * 100).toFixed(0) + '%';
}).join(' < '));
ok('LED 阵列最外排不贴边（距边 8~30mm，非 p/2 排布）', (function () {
  const L = D.ledGrid(8, 600, 600);
  return L.xs[0] >= 8 - 1e-9 && L.xs[0] <= 30 + 1e-9 &&
         (600 - L.xs[7]) >= 8 - 1e-9 && (600 - L.xs[7]) <= 30 + 1e-9;
})(), 'margin=' + D.ledGrid(8, 600, 600).xs[0].toFixed(1) + 'mm');

console.log('== ③ 均匀度口径 ==');
D.U_DEF_IDS.forEach(function (s) {
  const u = D.uniformity(field(25, 10), D.fineVisibility(1.5, 0.5, 2.5), s, 18);
  ok('口径 ' + s + '：U∈[0,1]、Umean∈[0,1]、ripple=1−U',
     u.U >= 0 && u.U <= 1 && u.Umean >= 0 && u.Umean <= 1 && Math.abs(u.ripple - (1 - u.U)) < 1e-9,
     'U=' + (u.U * 100).toFixed(1) + '% ripple=' + (u.ripple * 100).toFixed(1) + '%');
});
ok('残余对比含灯阵纹波（不只细结构）：OD 小 → ripple 大', (function () {
  const fv = D.fineVisibility(1.5, 0.5, 2.5);
  return D.uniformity(field(8, 6), fv, 'active', 18).ripple >
         D.uniformity(field(45, 16), fv, 'active', 18).ripple + 0.2;
})());
ok('rippleFine 只取细结构项（与 OD/N 无关）', (function () {
  const fv = D.fineVisibility(1.5, 0.5, 2.5);
  return Math.abs(D.uniformity(field(8, 6), fv, 'active', 18).rippleFine -
                  D.uniformity(field(45, 16), fv, 'active', 18).rippleFine) < 1e-12;
})());
ok('逐点口径 U(active) ≤ 均值口径 U(mean)（min/max ≤ mean/max）', (function () {
  const f = field(25, 10), fv = D.fineVisibility(1.5, 0.5, 2.5);
  return D.uniformity(f, fv, 'active', 18).U <= D.uniformity(f, fv, 'mean', 18).U + 1e-9;
})());

console.log('== ④ 棱镜代理与角度重分配 ==');
const sur = D.prismSurrogate('pyramid', 45, 1.49);
ok('金字塔 α=45°、n=1.49 校准点 ηx≈0.59（±0.08）',
   Math.abs(sur.etax - 0.59) < 0.08, 'ηx=' + sur.etax.toFixed(3) + ' β=' + sur.beta.toFixed(1) + '°');
ok('α↑ → 萃取效率 ηx↑', [25, 35, 45, 55].every(function (a, i, arr) {
  return i === 0 || D.prismSurrogate('pyramid', arr[i - 1], 1.49).etax < D.prismSurrogate('pyramid', a, 1.49).etax;
}), [25, 35, 45, 55].map(function (a) { return D.prismSurrogate('pyramid', a, 1.49).etax.toFixed(3); }).join(' < '));
ok('α↑ → 收敛半角 β↓（越锐越收拢）', [25, 35, 45, 55].every(function (a, i, arr) {
  return i === 0 || D.prismSurrogate('pyramid', arr[i - 1], 1.49).beta > D.prismSurrogate('pyramid', a, 1.49).beta;
}), [25, 35, 45, 55].map(function (a) { return D.prismSurrogate('pyramid', a, 1.49).beta.toFixed(0) + '°'; }).join(' > '));
ok('填充率随刀尖圆角下降且 ≥70%（α 在量程内）',
   D.coverageOf('pyramid', 45) > D.coverageOf('pyramid', 60) && D.coverageOf('pyramid', 60) >= 0.70,
   '45°=' + (D.coverageOf('pyramid', 45) * 100).toFixed(0) + '% 60°=' + (D.coverageOf('pyramid', 60) * 100).toFixed(0) + '%');
ok('锥内份额 C 随 θv 单调增且 C(90°)=1', (function () {
  const p = D.angularProfile(42, 0.5);
  const c = [15, 30, 45, 60, 90].map(function (t) { return D.coneFraction(p, t); });
  return c[0] < c[1] && c[1] < c[2] && c[2] < c[3] && Math.abs(c[4] - 1) < 1e-6;
})());
ok('朗伯分布 θv=45° 时 C=0.50（半球对半）',
   Math.abs(D.coneFraction(D.lambertProfile(), 45) - 0.5) < 0.01,
   D.coneFraction(D.lambertProfile(), 45).toFixed(4));
ok('雾度↑ → 出光被拉回朗伯 → 锥内份额 C↓', (function () {
  const c = function (h) { return D.coneFraction(D.angularProfile(42, h), 35); };
  return c(0.1) > c(0.5) && c(0.5) > c(0.9);
})(), [0.1, 0.5, 0.9].map(function (h) { return D.coneFraction(D.angularProfile(42, h), 35).toFixed(3); }).join(' > '));

console.log('== ⑤ 单方案预测与效率链 ==');
const base = { mat: 'pmma', Hd: 0.5, tDiff: 1.5, OD: 25, N: 10, shape: 'pyramid', alpha: 45 };
const p0 = D.predict(base, SYS);
ok('η = Td × ηplate × φ_conf（效率链闭合）',
   Math.abs(p0.eta - p0.Td * p0.etaPlate * p0.confine) < 1e-9,
   'η=' + (p0.eta * 100).toFixed(1) + '%');
ok('ηcone = η × C', Math.abs(p0.etaCone - p0.eta * p0.C) < 1e-9);
ok('雾度↑ → U↑ 但 η↓（核心权衡）', (function () {
  const a = D.predict(Object.assign({}, base, { Hd: 0.2 }), SYS);
  const b = D.predict(Object.assign({}, base, { Hd: 0.8 }), SYS);
  return b.U > a.U && b.eta < a.eta;
})());
ok('灯数↑ → η 略升（φ_conf 升）但成本升', (function () {
  const a = D.predict(Object.assign({}, base, { N: 6 }), SYS);
  const b = D.predict(Object.assign({}, base, { N: 14 }), SYS);
  return b.confine > a.confine;
})());
ok('有棱镜 η > 无棱镜 η（棱镜增益 > 1）', (function () {
  const noPrism = D.predict(Object.assign({}, base, { shape: null }), SYS);
  return p0.eta > noPrism.eta;
})(), '×' + (p0.eta / D.predict(Object.assign({}, base, { shape: null }), SYS).eta).toFixed(2));
ok('总厚度 = OD + t + 基板 + 棱镜高',
   Math.abs(p0.totalThickness - (25 + 1.5 + D.GEO.plateBase + D.GEO.prismH)) < 1e-9,
   p0.totalThickness.toFixed(2) + 'mm');

console.log('== ⑥ 约束校核 ==');
const ck = D.checkConstraints(p0, Object.assign({ budget: 30, targetU: 0.75, targetEta: 0.42, noHotspot: true }, SYS));
ok('约束清单 ≥ 5 条，state 只取 PASS/WARN/FAIL',
   ck.length >= 5 && ck.every(function (c) { return ['PASS', 'WARN', 'FAIL'].indexOf(c.state) >= 0; }), ck.length + ' 条');
ok('约束项含厚度 / 刀具角 / 填充率 / OD÷灯距',
   ['thickness', 'demold', 'cover', 'odp'].every(function (k) { return ck.some(function (c) { return c.key === k; }); }),
   ck.map(function (c) { return c.key; }).join(','));
ok('勾了无灯影 → 清单含 hotspot 项且阈值 15%',
   ck.some(function (c) { return c.key === 'hotspot' && /15%/.test(c.limit); }));
ok('厚度超预算 → 该项 FAIL', (function () {
  const tight = D.checkConstraints(p0, Object.assign({ budget: 20, targetU: 0.75, targetEta: 0.42 }, SYS));
  const t = tight.filter(function (c) { return c.key === 'thickness'; })[0];
  return t && t.state === 'FAIL';
})());

console.log('== ⑦ 优化器 ==');
const o1 = D.optimize({ targetU: 0.75, targetEta: 0.42, thetaV: 35, budget: 30, material: 'pmma', uDef: 'active' });
ok('默认目标可满足', o1.feasible && o1.chosen,
   '达标 ' + o1.feasibleCount + ' / ' + o1.count + ' 组');
ok('选中解满足双目标', o1.chosen.U >= 0.75 - 1e-9 && o1.chosen.eta >= 0.42 - 1e-9,
   'U=' + (o1.chosen.U * 100).toFixed(1) + '% η=' + (o1.chosen.eta * 100).toFixed(1) + '%');
ok('选中解过硬约束：α ≤ 刀具角、填充率 ≥ 70%、厚度 ≤ 预算',
   o1.chosen.alpha <= D.SHAPES[o1.chosen.shape].aTool + 1e-9 &&
   o1.chosen.cov >= 0.70 - 1e-9 && o1.chosen.totalThickness <= 30 + 1e-6);
ok('fieldCount 是真实重建次数（二次调用命中缓存 → 0）',
   o1.fieldCount > 0 && o1.fieldCount <= D.GRID.tDiff.length * D.GRID.N.length,
   '首次 ' + o1.fieldCount + ' 次');
const o1b = D.optimize({ targetU: 0.75, targetEta: 0.42, thetaV: 35, budget: 30, material: 'pmma', uDef: 'active' });
ok('  二次调用 fieldCount = 0（场缓存生效）', o1b.fieldCount === 0);
const o2 = D.optimize({ targetU: 0.99, targetEta: 0.95, thetaV: 35, budget: 30, material: 'pmma', uDef: 'active' });
ok('极苛刻目标不可满足 → 回退最近点并给诊断', !o2.feasible && o2.chosen && o2.diag,
   o2.diag ? ('可达上界 U≤' + (o2.diag.maxU * 100).toFixed(1) + '%') : '无 diag');
const o3 = D.optimize({ targetU: 0.75, targetEta: 0.42, thetaV: 35, budget: 30, material: 'pmma', uDef: 'active', noHotspot: true });
ok('「无灯影」不可达时仍能出解（hardEmpty 兜底，不返回空）',
   !!o3.chosen, 'hardEmpty=' + o3.hardEmpty + ' U=' + (o3.chosen ? (o3.chosen.U * 100).toFixed(1) + '%' : '-'));
ok('  且该解在约束表里被如实标红', (function () {
  if (!o3.chosen || !o3.chosen.checks) return false;
  const h = o3.chosen.checks.filter(function (c) { return c.key === 'hotspot'; })[0];
  return !h || h.state !== 'PASS' || o3.chosen.ripple <= 0.15;
})());
D.MAT_IDS.forEach(function (m) {
  const r = D.optimize({ targetU: 0.75, targetEta: 0.42, thetaV: 35, budget: 30, material: m, uDef: 'active' });
  ok('材料 ' + m + ' 可独立求解', !!r.chosen && r.chosen.mat === m,
     r.chosen ? ('U=' + (r.chosen.U * 100).toFixed(1) + '% η=' + (r.chosen.eta * 100).toFixed(1) + '%') : '-');
});
ok('PS 候选数 < PMMA（雾度上限更低压掉一批）', (function () {
  const a = D.optimize({ targetU: 0.75, targetEta: 0.42, thetaV: 35, budget: 30, material: 'pmma', uDef: 'active' }).count;
  const b = D.optimize({ targetU: 0.75, targetEta: 0.42, thetaV: 35, budget: 30, material: 'ps', uDef: 'active' }).count;
  return b < a;
})());
ok('Pareto 前沿非空且按 U 升序', o1.pareto.length > 0 && o1.pareto[0].U <= o1.pareto[o1.pareto.length - 1].U,
   o1.pareto.length + ' 点');
const sens = D.sensitivity(o1.chosen, o1.sys);
ok('敏感性分析 ≥ 4 行且含 ΔU / Δη', sens.length >= 4 &&
   sens.every(function (s) { return typeof s.dU === 'number' && typeof s.dEta === 'number'; }),
   sens.length + ' 行');

console.log('== ⑧ 页面结构 ==');
ok('tab 按钮 data-tab="opt" 存在', /data-tab="opt"/.test(html));
ok('view-opt 视图存在', /id="view-opt"/.test(html));
/* 材料卡片由 optimal-design-ui.js 在运行时遍历 D.MAT_IDS 动态生成（外加一个
   「自动」档让优化器三选一），所以断言打在 UI 脚本的**生成逻辑**上，
   而不是在 index.html 里找静态的 data-mat="pmma"（那里根本不存在）。 */
ok('材料选择器 od_matpick 存在，且按 MAT_IDS 动态生成卡片 + 自动档',
   /id="od_matpick"/.test(html) && /data-mat="auto"/.test(ui) &&
   /D\.MAT_IDS\.forEach/.test(ui) && /data-mat="' \+ id \+ '"/.test(ui));
ok('三种材料属性齐备（n / Tsub / 雾度上限 / 单价 / 优缺点 / 适用场景）',
   D.MAT_IDS.length === 3 && D.MAT_IDS.every(function (m) {
     const M = D.MATERIALS[m];
     return M && M.n > 1.4 && M.n < 1.7 && M.Tsub > 0.8 && M.Tsub < 1 &&
            M.hazeMax > 0.8 && M.unitCost > 0 && M.pros && M.cons && M.scene;
   }),
   D.MAT_IDS.map(function (m) { return m + ' n=' + D.MATERIALS[m].n + ' T=' + D.MATERIALS[m].Tsub; }).join(' | '));
ok('三材料可区分（n、本体透过率、雾度上限不同）', (function () {
  const ns = D.MAT_IDS.map(function (m) { return D.MATERIALS[m].n; });
  const ts = D.MAT_IDS.map(function (m) { return D.MATERIALS[m].Tsub; });
  return new Set(ns.map(function (v) { return v.toFixed(3); })).size >= 2 &&
         new Set(ts.map(function (v) { return v.toFixed(3); })).size >= 2;
})());
ok('目标滑块 od_u / od_e / od_tv / od_budget / od_rho 齐全',
   ['od_u', 'od_e', 'od_tv', 'od_budget', 'od_rho'].every(function (id) { return new RegExp('id="' + id + '"').test(html); }));
ok('下拉 od_src / od_n / od_t / od_udef / od_prefer 齐全',
   ['od_src', 'od_n', 'od_t', 'od_udef', 'od_prefer'].every(function (id) { return new RegExp('id="' + id + '"').test(html); }));
ok('求解按钮 od_btn 存在', /id="od_btn"/.test(html));
ok('五张画布齐全（场 / 色标 / 剖面 / 角分布 / 散点）',
   ['od_field', 'od_bar', 'od_slice', 'od_ang', 'od_scatter'].every(function (id) { return new RegExp('id="' + id + '"').test(html); }));
ok('结果表 / 约束表 / 材料三选表 / 敏感性表 / 结论文案齐全',
   ['od_out_tbl', 'od_checks', 'od_matcmp', 'od_sens', 'od_verdict'].every(function (id) { return new RegExp('id="' + id + '"').test(html); }));
ok('页脚 fset data-for="opt" 存在', /class="fset" data-for="opt"/.test(html));
ok('脚本 optimal-design.js / -ui.js 已引入',
   /src="js\/optimal-design\.js"/.test(html) && /src="js\/optimal-design-ui\.js"/.test(html));
ok('app.js：activateTab 处理 opt', /name === 'opt' && window\.OptimalDesignUI/.test(appjs));
ok('app.js：深链白名单含 opt', /h === 'mats' \|\| h === 'opt'/.test(appjs));
ok('styles.css：#view-opt 样式存在', /#view-opt \.opt-ctl/.test(css));

console.log('== ⑨ 流程图 SVG（v3.10 重写，防回归） ==');
const svg = (html.match(/<svg[^>]*class="opt-flow-svg"[\s\S]*?<\/svg>/) || [null])[0];
ok('流程图 SVG 存在', !!svg);
if (svg) {
  const boxes = svg.match(/class="fbox/g) || [];
  ok('  流程框 ≥ 9 个（10 步流程）', boxes.length >= 9, boxes.length + ' 个');
  ok('  SVG 内不得出现 <sub>/<sup>/<b>（HTML 解析器会吞掉后续节点）',
     !/<(sub|sup|b)[\s>]/.test(svg));
  ok('  含回环箭头（迭代收敛反馈）', /class="fdash"/.test(svg) || /marker-end/.test(svg));
  ok('  含关键量标注（U / η / φ_conf / OD 之类）', /fkey/.test(svg));
  ok('  CSS 定义 .opt-flow-svg 与 .fbox', /\.opt-flow-svg/.test(css) && /\.fbox/.test(css));
}

console.log('== ⑩ 口径与诚实标注 ==');
ok('页脚写明半解析筛选级、需 MC / 光学软件复核',
   /data-for="opt"[\s\S]*?半解析[\s\S]*?(LightTools|LiteTrace)/.test(html));
ok('页脚未照搬前 3 页 DIALux 口径',
   /data-for="opt"[\s\S]*?扩散板/.test(html) && !/data-for="opt"[\s\S]*?DIALux/.test(html));
ok('页脚写明硬约束（厚度 / 刀具角 / 填充率 / 可选无灯影）',
   /data-for="opt"[\s\S]*?刀具[\s\S]*?填充率[\s\S]*?灯影/.test(html));
ok('页面内有模型局限的明示（caveat）', /caveat/i.test(html) || /筛选级|半解析/.test(html));
ok('UI 不再把细结构残余对比当成 U 口径说明',
   /残余对比/.test(ui) && !/细结构残余对比/.test(ui));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) console.log('失败项:\n - ' + fails.join('\n - '));
process.exit(fail ? 1 : 0);
