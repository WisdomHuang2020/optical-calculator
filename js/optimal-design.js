/* ============================================================
 * optimal-design.js —— 「最优设计方法」页面的物理内核（DOM 无关）
 *
 * 设计目标：给定目标出光均匀度 U* 与目标出光效率 η*，自动给出
 *   扩散板材料（透过率 Td、雾度 Hd）+ 棱镜（形状、关键角度 α）
 * 的平衡最优组合，并画出 (U, η) 的权衡散点（Pareto 可视）。
 *
 * 为什么是「筛选级模型」而非真实仿真（务必诚实标注）：
 *   - 棱镜板自身的萃取效率 ηx 与输出收敛半角 β 由 prism-perf.js 的
 *     几何光学蒙特卡洛（斯涅尔 + 菲涅耳 + 全反射 + 腔体回收）给出，
 *     已数值校核。但 MC 每次要几百毫秒，无法在优化器里逐候选跑，
 *     所以这里用**分析与 MC 在参考点（金字塔 α=45°）校准过的代理**：
 *       β_surrogate(α=45, pyramid) 与 ηx_surrogate(α=45, pyramid)
 *       刻意对齐 perf MC 的 ≈0.59 出光效率；其余形状/角度靠单调形状
 *     外推，只保证趋势正确、量级合理，不做逐点验证。
 *   - 扩散板用标准「透过率 Td + 雾度 Hd」两段式模型：Td 决定效率损失，
 *     Hd 决定发光面空间均匀度（U）与被棱镜收拢的难易（η）。
 *   - 棱镜几乎不改发光面空间均匀度（那是扩散板的活），它只把漫射光
 *     收拢到观看锥内（准直），从而提升出光效率 η。
 *   本页结论用于方案筛选与趋势判断；正式设计请用 LightTools /
 *   LiteTrace 复核。
 * ============================================================ */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;

  /* 代表性棱镜几何（BEF 量级，单位 mm）。优化只扫形状 + 角度 α，
     其余几何固定，避免 UI 过杂；输出里会把实际取值列出，便于复核。 */
  var GEO = { height: 0.25, pitch: 1.00, base: 0.20, topRatio: 0.30, n: 1.49 };

  /* 每种形状的代理参数：
       aMin/aMax : 侧壁倾角 α 的扫描区间（°）
       beta      : 收敛半角形状因子（越大越难收拢 → 半角更宽）
       etaBest   : 极限萃取效率（最锐时）
     注意：β 形状因子越大代表越「散」（圆锥/球冠是回转光滑面，本来就偏扩散）。
     棱镜的「侧壁斜率分布」这个真实控制量，在本模型里就是 α —— 同一族形状
     改 α 比换形状更显著，与「棱镜原理」页的论断一致。 */
  var SHAPES = {
    pyramid: { label: '四棱锥',       aMin: 30, aMax: 60, beta: 1.00, etaBest: 0.82 },
    frustum: { label: '台锥（截顶）', aMin: 30, aMax: 60, beta: 1.06, etaBest: 0.80 },
    hexpyr:  { label: '六棱锥蜂窝',   aMin: 30, aMax: 60, beta: 1.00, etaBest: 0.83 },
    cone:    { label: '圆锥',         aMin: 30, aMax: 60, beta: 1.45, etaBest: 0.76 },
    sphere:  { label: '球冠微透镜',   aMin: 25, aMax: 55, beta: 1.70, etaBest: 0.70 },
    parabola:{ label: '抛物面帽',     aMin: 30, aMax: 60, beta: 1.20, etaBest: 0.79 }
  };

  /* 同总高纯平板（腔体回收）的萃取效率基线，来自 prism-perf 的 computeFlat。 */
  var ETA_FLAT = 0.238;
  var BETA_MAX = 70;       // 半角上限（°），α 最平时接近朗伯

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /* ---- 棱镜代理：给定形状 + 倾角 α → {beta(°), etax} ---- */
  function prismSurrogate(shapeId, alphaDeg) {
    var S = SHAPES[shapeId] || SHAPES.pyramid;
    var a = clamp((alphaDeg - S.aMin) / (S.aMax - S.aMin), 0, 1);  // 0 平 .. 1 锐
    /* 锐 → 半角更窄；形状因子放大（回转面更难收拢）。校准：金字塔 a=0.5(α=45) 时
       β = 70·(1−0.8·0.5)·1.0 = 42°，与 perf MC 输出半角同量级。 */
    var beta = BETA_MAX * (1 - 0.8 * a) * S.beta;
    /* 锐 → 全反射回收更充分 → 萃取更高（平滑过渡到 etaBest）。标定：
       a=0.5 时 etax = 0.238 + (0.82−0.238)·(0.30+0.70·0.5) = 0.603 ≈ perf 0.594。 */
    var etax = ETA_FLAT + (S.etaBest - ETA_FLAT) * (0.30 + 0.70 * a);
    return { beta: beta, etax: etax, a: a };
  }

  /* 圆柱/锥状足迹的填充率（= 1−平台占比）。与 prism-shapes.fillOf 同式，
     这里内联以便 Node 直跑；浏览器里若 PrismShapes 已加载则改用它。 */
  function fillOf(shapeId, b, pitch) {
    var sq = function () { var s = 2 * b; return (s * s) / (pitch * pitch); };
    if (shapeId === 'hexpyr') {
      /* 六边形底面（内切圆半径 b）面积 2√3 b²，蜂窝晶格单胞面积 pitch²·√3/2 */
      var foot = 2 * Math.sqrt(3) * b * b;
      var cell = pitch * pitch * Math.sqrt(3) / 2;
      return clamp(foot / cell, 0, 1);
    }
    if (shapeId === 'cone' || shapeId === 'sphere' || shapeId === 'parabola') {
      var fc = Math.PI * b * b;
      return clamp(fc / (pitch * pitch), 0, 1);
    }
    return clamp(sq(), 0, 1);
  }

  /* 计算某候选（扩散板 + 棱镜）的输出 (U, η_out) */
  function evaluate(diff, prism, thetaV) {
    var Td = diff.Td, Hd = diff.Hd;
    var sur = prismSurrogate(prism.shape, prism.alpha);
    var beta = sur.beta, etax = sur.etax;
    var thv = thetaV * DEG;

    /* 前向锥内占比 C：
       镜面份 (1−Hd) 被收拢到半角 β；漫射份 Hd 被雾度撑宽到 sqrt(β²+(Hd·70°)²)。
       锥内占比用「均匀锥分布」近似：β ≤ θv 时≈0.97（存在尾部），否则 (sinθv/sinβ)²。 */
    function fwd(bd) {
      if (bd <= thetaV) return 0.97;
      var r = Math.sin(thv) / Math.sin(bd * DEG);
      return r * r;
    }
    var fSpec = fwd(beta);
    var bDiff = Math.sqrt(beta * beta + (Hd * 70) * (Hd * 70));
    var fDiff = fwd(bDiff);
    var C = (1 - Hd) * fSpec + Hd * fDiff;

    var etaOut = Td * etax * C;

    /* 发光面空间均匀度 U：主要由扩散板决定（棱镜不改空间分布）。
       U0 随 Hd 饱和上升；棱镜填充率低（平台多）→ 轻微条带惩罚。 */
    var U0 = 0.50 + 0.45 * (1 - Math.exp(-Hd / 0.35));
    var b = halfBaseUse(prism.shape, prism.alpha);
    var fill = fillOf(prism.shape, b, GEO.pitch);
    var band = (1 - fill) * 0.10;            // 平台多 → 条带风险
    var U = clamp(U0 - band, 0.40, 0.99);

    return {
      U: U, etaOut: etaOut,
      beta: beta, etax: etax, fill: fill, C: C,
      fSpec: fSpec, fDiff: fDiff, thetaV: thetaV
    };
  }

  /* 代表性几何下，半底宽 b（棱镜原理页同一套公式，这里内联）。 */
  function halfBaseUse(shapeId, alphaDeg) {
    var S = SHAPES[shapeId] || SHAPES.pyramid;
    var h = GEO.height, p = GEO.pitch;
    var k = (shapeId === 'frustum') ? GEO.topRatio : 0;
    /* 四棱锥：b = h/tanα；台锥：b = h/(tanα·(1−k))；其余同四棱锥。 */
    var want = h / (Math.tan(alphaDeg * DEG) * (1 - k));
    return Math.min(want, p / 2);
  }

  /* 选材初判（启发式，标注为初判）。 */
  function materialClass(Td, Hd) {
    if (Td >= 0.92 && Hd >= 0.70) return '高透高雾扩散膜（PET/PC 基，表里加硬涂层）';
    if (Td >= 0.92 && Hd < 0.50) return '低雾增透扩散膜（微结构 / 低散射，靠棱镜板补均匀）';
    if (Td >= 0.88 && Hd >= 0.55) return '标准扩散片（PMMA 基，中雾中透）';
    if (Td < 0.86) return '高吸收遮光扩散片（慎选：效率偏低，仅特殊遮瑕用）';
    return '通用扩散片（中等透过 / 雾度）';
  }

  /* 优化器：扫描 (Td,Hd) × 形状 × α，返回满足双约束的最优解 + 全部候选。 */
  function optimize(targetU, targetEta, thetaV) {
    var Tds = [], Hds = [], alphas = {};
    for (var t = 0.80; t <= 0.981; t += 0.02) Tds.push(+t.toFixed(2));
    for (var h = 0.10; h <= 0.951; h += 0.05) Hds.push(+h.toFixed(2));
    var shapeIds = Object.keys(SHAPES);
    shapeIds.forEach(function (id) {
      var S = SHAPES[id], arr = [];
      for (var a = S.aMin; a <= S.aMax + 1e-9; a += 5) arr.push(Math.round(a));
      alphas[id] = arr;
    });

    var points = [];           // 全部候选 {Td,Hd,shape,alpha,U,eta,fill}
    var feasible = [];
    var i, j, s, ai;
    for (i = 0; i < Tds.length; i++) {
      for (j = 0; j < Hds.length; j++) {
        for (s = 0; s < shapeIds.length; s++) {
          var id = shapeIds[s];
          var aArr = alphas[id];
          for (ai = 0; ai < aArr.length; ai++) {
            var alpha = aArr[ai];
            var r = evaluate({ Td: Tds[i], Hd: Hds[j] },
                             { shape: id, alpha: alpha }, thetaV);
            var pt = { Td: Tds[i], Hd: Hds[j], shape: id, alpha: alpha,
                       U: r.U, eta: r.etaOut, fill: r.fill, beta: r.beta };
            points.push(pt);
            if (r.U >= targetU - 1e-9 && r.etaOut >= targetEta - 1e-9) feasible.push(pt);
          }
        }
      }
    }

    /* 候选评分：优先满足双约束；在可行集里取「离目标最近」且「最省」
       （高填充=少平台浪费、低 Hd=少散射损耗）的点。 */
    function cost(pt) {
      var du = pt.U - targetU, de = pt.eta - targetEta;
      var miss = Math.max(0, -du) + Math.max(0, -de);          // 未达成的缺口
      var dist = du * du * 4 + de * de * 4;                     // 达成后的超额距离
      var waste = (1 - pt.fill) * 0.6 + pt.Hd * 0.4;            // 材料/能耗浪费
      return { miss: miss, score: dist + waste * 0.15 };
    }

    var chosen = null, best = null;
    for (i = 0; i < points.length; i++) {
      var c = cost(points[i]);
      if (c.miss < 1e-9) {
        if (!chosen || c.score < chosen._score) { chosen = points[i]; chosen._score = c.score; }
      } else {
        if (!best || c.miss < best._miss || (Math.abs(c.miss - best._miss) < 1e-9 && c.score < best._score)) {
          best = points[i]; best._miss = c.miss; best._score = c.score;
        }
      }
    }
    var result = chosen || best;
    return {
      feasible: !!chosen,
      targetU: targetU, targetEta: targetEta, thetaV: thetaV,
      chosen: result ? {
        Td: result.Td, Hd: result.Hd, shape: result.shape, alpha: result.alpha,
        U: result.U, eta: result.eta, fill: result.fill, beta: result.beta,
        material: materialClass(result.Td, result.Hd)
      } : null,
      points: points, feasibleCount: feasible.length, totalCount: points.length
    };
  }

  var API = {
    GEO: GEO,
    SHAPES: SHAPES,
    ETA_FLAT: ETA_FLAT,
    prismSurrogate: prismSurrogate,
    fillOf: fillOf,
    evaluate: evaluate,
    materialClass: materialClass,
    optimize: optimize,
    /* 浏览器里若 PrismShapes 先加载，用它的 fillOf 覆盖内联版（口径一致）。 */
    bindShapes: function () {
      if (root.PrismShapes && root.PrismShapes.fillOf) {
        fillOf = function (id, b, p) {
          var K = root.PrismShapes.get(id);
          return root.PrismShapes.fillOf(K, b, p);
        };
      }
    }
  };

  root.OptimalDesign = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof global !== 'undefined' ? global : this);
