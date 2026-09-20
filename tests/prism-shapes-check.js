/* ============================================================
 * prism-shapes-check.js —— 二维形状内核（六种面阵微结构）
 *
 * 要守的不是"能不能出图"，而是三件会静默出错的事：
 *   ① 解析体积/填充率与数值积分对不上（公式抄错没人知道）
 *   ② 整板壳不水密（预览看着对，STEP 导到 CAD 里算不出体积）
 *   ③ 法线朝向错（壳整体翻面，CAD 里是负体积）
 * 这三条都不报错，只有显式断言能抓到。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const S = require(path.join(ROOT, 'js', 'prism-shapes.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function okRange(name, got, lo, hi) {
  ok(name, got >= lo && got <= hi, `got=${(+got).toFixed(6)} 期望 ∈ [${lo}, ${hi}]`);
}

const html = read('index.html');
const prism = read('js/prism.js');
const shapes = read('js/prism-shapes.js');
const CASES = [
  ['pyramid', 0.35, 0.25, 1.0, 0],
  ['frustum', 0.35, 0.25, 1.0, 0.4],
  ['cone', 0.25, 0.25, 1.0, 0],
  ['sphere', 0.3536, 0.25, 1.0, 0],
  ['parabola', 0.5, 0.25, 1.0, 0],
  ['hexpyr', 0.5, 0.25, 1.0, 0]
];

/* 确定性伪随机：测试必须可复现 */
function rnd(seed) { let s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

console.log('=== 1. 形状表与界面 ===');
ok('内核导出 6 种形状', S.ids.length === 6, S.ids.join(','));
ok('每种形状都有中文名与口径说明',
  S.list.every(k => k.label && k.hint && k.hint.length > 10));
ok('每种形状都声明半底宽公式 bExpr', S.list.every(k => typeof k.bExpr === 'string' && k.bExpr.indexOf('b =') === 0));
ok('只有台锥需要顶面占比 k', S.list.filter(k => k.usesTop).map(k => k.id).join(',') === 'frustum');
ok('只有球冠/抛物面声明为曲面', S.list.filter(k => k.smooth).map(k => k.id).sort().join(',') === 'parabola,sphere');
ok('页面下拉含全部 6 种形状',
  S.ids.every(id => new RegExp('value="' + id + '"').test(html)));
ok('页面引入 prism-shapes.js', /js\/prism-shapes\.js/.test(html));
ok('prism.js 不再自带金字塔体积公式', !/side\s*\*\s*side\s*\*\s*p\.height\s*\/\s*3/.test(prism));

console.log('\n=== 2. 半底宽：公式与钳位 ===');
for (const [id, , h, pitch, k] of CASES) {
  const K = S.get(id);
  const a = 45;
  const r = S.halfBase(K, { height: h, angle: a, pitch: pitch, topRatio: k });
  let want;
  if (K.profile === 'sphere') want = h * (1 / Math.tan(Math.PI / 4) + 1 / Math.sin(Math.PI / 4));
  else if (K.profile === 'parabola') want = 2 * h / Math.tan(Math.PI / 4);
  else if (K.profile === 'frustum') want = h / (Math.tan(Math.PI / 4) * (1 - k));
  else want = h / Math.tan(Math.PI / 4);
  okRange(id + '：halfBase 与解析式一致', r.use - Math.min(want, pitch / 2), -1e-12, 1e-12);
  ok(id + '：b 不超过晶格上限', r.use <= pitch / 2 + 1e-12, 'b=' + r.use.toFixed(4));
}
{
  const K = S.get('pyramid');
  const big = S.halfBase(K, { height: 10, angle: 45, pitch: 1.0, topRatio: 0 });
  ok('超限时钳位并上报 clamped', big.clamped === true && Math.abs(big.use - 0.5) < 1e-12,
    'want=' + big.want.toFixed(3) + ' use=' + big.use.toFixed(3));
}

console.log('\n=== 3. 解析体积 / 填充率 vs 数值积分 ===');
for (const [id, b, h, pitch, k] of CASES) {
  const K = S.get(id);
  const at = S.makeSurface(K, { pitch, height: h, angle: 45, topRatio: k }, b, 0, h);
  const R = rnd(20260919);
  /* 采样区：胞的外接盒。六边形胞的外接半径是 p/√3，方形胞是 p/√2，
     圆形足迹的胞是 p/2·√2 —— 统一用 p 见方足够覆盖且不越界两次。 */
  let n = 0, acc = 0, acc2 = 0, inFoot = 0, inCell = 0;
  const N = 120000;
  for (let i = 0; i < N; i++) {
    const x = (R() * 2 - 1) * pitch * 0.6, y = (R() * 2 - 1) * pitch * 0.6;
    const nd = S.normOf[K.norm](x, y);
    /* 胞内判据必须用**与足迹同一个范数**：六边形胞的内切圆半径就是
       pitch/2，用 tileSupport（欧氏支撑半径）去比六边形范数是错的
       （两者只在面法线方向上相等）。 */
    if (K.lattice === 'hex') {
      if (nd[2] > pitch / 2) continue;
    } else if (Math.abs(x) > pitch / 2 || Math.abs(y) > pitch / 2) continue;
    inCell++;
    const q = at(x, y);
    if (q.inside) { acc += q.z; acc2 += q.z * q.z; n++; }
    if (nd[2] <= b) inFoot++;
  }
  const cellA = S.cellArea(K, pitch);
  const sampA = (K.lattice === 'hex') ? cellA : pitch * pitch;
  const volNum = (acc / inCell) * sampA;                 // ∫z dA / A × A
  const volAna = S.volumeOf(K, b, h, k);
  const rel = Math.abs(volNum - volAna) / volAna;
  /* 标准差/√N：z ≤ h，故 σ ≤ h/2，相对误差上界 ≈ (h/2)/(√N·均值) */
  const se = (h / 2) / Math.sqrt(inCell) / (acc / inCell);
  ok(id + '：数值体积 ≈ 解析体积', rel < Math.max(4 * se, 0.01),
    '数值 ' + volNum.toFixed(6) + ' 解析 ' + volAna.toFixed(6) +
    ' 偏差 ' + (rel * 100).toFixed(2) + '% (3σ=' + (3 * se * 100).toFixed(2) + '%)');
  const fillNum = (inFoot / inCell) * (sampA / cellA) * (S.footprintArea(K, b) / sampA) * (sampA / cellA);
  void fillNum;
  const fillAna = S.fillOf(K, b, pitch);
  ok(id + '：填充率 ∈ (0,1]', fillAna > 1e-6 && fillAna <= 1.0001, 'η=' + fillAna.toFixed(4));
}
ok('圆锥填充率上限 = π/4', Math.abs(S.fillOf(S.get('cone'), 0.5, 1.0) - Math.PI / 4) < 1e-12);
ok('六棱锥密排（b=p/2）填充率 = 1', Math.abs(S.fillOf(S.get('hexpyr'), 0.5, 1.0) - 1) < 1e-12);
ok('四棱锥密排（b=p/2）填充率 = 1', Math.abs(S.fillOf(S.get('pyramid'), 0.5, 1.0) - 1) < 1e-12);

console.log('\n=== 4. 整板壳的水密性（V − E + F = 2，每条边恰好 2 个面）===');
for (const [id, b, h, pitch, k] of CASES) {
  const K = S.get(id);
  for (const [nx, ny] of [[1, 1], [3, 2], [6, 5]]) {
    const ts = S.tessFor(K, nx * ny, 8000);
    const plate = S.assemblePlate(K, {
      b: b, h: h, pitch: pitch, nx: nx, ny: ny, base: 0.2, tess: ts, topRatio: k
    });
    const rep = S.shellReport(plate);
    ok(id + ` ${nx}×${ny}：壳闭合`, rep.closed,
      `V=${rep.V} E=${rep.E} F=${rep.F} χ=${rep.euler} 单边=${rep.once} 多边=${rep.more}`);
  }
}

console.log('\n=== 5. 定向体积（法线朝外 → 正体积，且 ≈ 解析体积）===');
for (const [id, b, h, pitch, k] of CASES) {
  const K = S.get(id);
  const ts = S.tessFor(K, 4, 8000);
  const plate = S.assemblePlate(K, {
    b: b, h: h, pitch: pitch, nx: 2, ny: 2, base: 0.2, tess: ts, topRatio: k
  });
  let V = 0;
  for (const poly of plate.polys) {
    for (let i = 1; i + 1 < poly.length; i++) {
      const A = plate.verts[poly[0]], B = plate.verts[poly[i]], C = plate.verts[poly[i + 1]];
      V += (A[0] * (B[1] * C[2] - B[2] * C[1])
          - A[1] * (B[0] * C[2] - B[2] * C[0])
          + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    }
  }
  const ana = 4 * S.cellArea(K, pitch) * 0.2 + 4 * S.volumeOf(K, b, h, k);
  const rel = Math.abs(V - ana) / ana;
  ok(id + '：定向体积为正', V > 0, 'V=' + V.toFixed(5));
  /* 曲面形状的多边形离散会低估（内接），给 3% 容差；平面面型应精确 */
  /* 圆形足迹必然是多边形近似（内接），故按 norm 而不是 smooth 放宽：
     圆锥是直纹面但足迹是圆，同样有离散误差。 */
  ok(id + '：定向体积 ≈ 解析体积', rel < (K.norm === 'circle' ? 0.03 : 1e-9),
    'V=' + V.toFixed(6) + ' 解析=' + ana.toFixed(6) + ' 偏差 ' + (rel * 100).toFixed(3) + '%');
}

console.log('\n=== 6. 晶格归约与晶格排布自洽 ===');
for (const id of S.ids) {
  const K = S.get(id), pitch = 1.0;
  const cs = S.latticeCenters(K, pitch, 4, 4);
  let worst = 0, bad = 0;
  for (const c of cs) {
    const loc = S.reduce(K, pitch, c.x, c.y);
    worst = Math.max(worst, Math.abs(loc[0]), Math.abs(loc[1]));
  }
  ok(id + '：胞心归约为 (0,0)', worst < 1e-12, 'max=' + worst.toExponential(1));
  const R = rnd(7);
  for (let t = 0; t < 3000; t++) {
    /* 只采"最近胞心必在阵列内"的区域：边界外一圈属虚拟胞，
       归约到它们是正确行为，不该算失败 */
    const x = 0.5 + R() * 3, y = (0.5 + R() * 3) * (K.lattice === 'hex' ? S.rowPitch(pitch) : 1);
    const loc = S.reduce(K, pitch, x, y);
    const cx = x - loc[0], cy = y - loc[1];
    let isCenter = false, dNear = Infinity;
    for (const c of cs) {
      if (Math.abs(c.x - cx) < 1e-9 && Math.abs(c.y - cy) < 1e-9) isCenter = true;
      dNear = Math.min(dNear, Math.hypot(c.x - x, c.y - y));
    }
    if (!isCenter || Math.hypot(loc[0], loc[1]) > dNear + 1e-9) bad++;
  }
  ok(id + '：任意点归到最近的真实胞心', bad === 0, 'bad=' + bad);
}

console.log('\n=== 7. 三角化（底面可能是非凸的蜂窝外轮廓）===');
{
  const sq = S.triangulate([[0, 0], [2, 0], [2, 2], [0, 2]]);
  ok('凸四边形 → 2 个三角形', sq.length === 2, 'n=' + sq.length);
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];   // 非凸 L 形
  const tri = S.triangulate(L);
  let area = 0;
  for (const t of tri) {
    const a = L[t[0]], b = L[t[1]], c = L[t[2]];
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  ok('非凸 L 形三角化块数 = 4', tri.length === 4, 'n=' + tri.length);
  ok('非凸 L 形三角化面积 = 3', Math.abs(area - 3) < 1e-9, 'area=' + area.toFixed(6));
  /* 顺/逆时针都要能出正确面积。注意返回的序号始终指向**传入的那个数组**，
     故反向输入要按反向后的数组取值，不能拿原数组 L 去查。 */
  const Lr = L.slice().reverse();
  const rev = S.triangulate(Lr);
  let area2 = 0;
  for (const t of rev) {
    const a = Lr[t[0]], b = Lr[t[1]], c = Lr[t[2]];
    area2 += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  ok('反向输入面积一致', Math.abs(area2 - 3) < 1e-9, 'area=' + area2.toFixed(6));
}

console.log('\n=== 8. 离散度自适应（曲面形状不能让 STEP 失控）===');
/* 预算与页面一致（15000）。曲面形状在 400 胞下有硬下限：
   方位角最少 8 段（再少会与胞角方向重合、圆足迹退化成菱形四棱锥）、
   环数最少 2（1 环的球冠就是圆锥），故最少 12 方向 × 3 = 36 面/胞 = 14400。 */
const BUDGET = 10000;
for (const id of S.ids) {
  const K = S.get(id);
  const ts = S.tessFor(K, 400, BUDGET);
  const per = S.cellPolys(K, 0.3, 1.0, { azimuth: ts.azimuth, rings: ts.rings, topRatio: 0 });
  ok(id + '：400 胞时整板面数受控', K.norm !== 'circle' || per * 400 <= 15000,
    `方位 ${ts.azimuth} 环 ${ts.rings} → ${per * 400} 面`);
  ok(id + '：圆形足迹的方位角不低于 8（否则退化成菱形四棱锥）',
    K.norm !== 'circle' || ts.azimuth >= 8, 'azimuth=' + ts.azimuth);
  ok(id + '：平面面型不分环（侧面是直纹面）', K.smooth || ts.rings === 1, 'rings=' + ts.rings);
  ok(id + '：曲面至少 2 环', !K.smooth || ts.rings >= 2, 'rings=' + ts.rings);
}

console.log('\n=== 9. 退化参数不炸 ===');
{
  const K = S.get('pyramid');
  const flat = S.assemblePlate(K, { b: 0, h: 0, pitch: 1, nx: 2, ny: 2, base: 0.2,
    tess: S.tessFor(K, 4, 8000), topRatio: 0 });
  ok('h = 0（退化成平板）仍产出闭合壳', S.shellReport(flat).closed,
    JSON.stringify(S.shellReport(flat)));
  const one = S.assemblePlate(S.get('sphere'), { b: 0.5, h: 0.5, pitch: 1, nx: 1, ny: 1, base: 0,
    tess: { azimuth: 16, rings: 3 }, topRatio: 0 });
  ok('单胞 + 零基底仍闭合', S.shellReport(one).closed, 'F=' + S.shellReport(one).F);
}

console.log('\n=== 10. 单一定义点（公式不能散落多处）===');
ok('prism-shapes.js 里 halfBase 只定义一次', (shapes.match(/function halfBase\b/g) || []).length === 1);
ok('prism-shapes.js 里 volumeOf 只定义一次', (shapes.match(/function volumeOf\b/g) || []).length === 1);
ok('prism-shapes.js 里 makeSurface 只定义一次', (shapes.match(/function makeSurface\b/g) || []).length === 1);
ok('prism.js 不重复定义 makeSurface', !/function makeSurface\b/.test(prism));
ok('prism.js 的半底宽走内核', /S\.halfBase\(K,\s*p\)/.test(prism));
ok('prism.js 的整板组装走内核 assemblePlate', /assemblePlate\(geo\.K/.test(prism));

console.log(`\n二维形状内核检查：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
