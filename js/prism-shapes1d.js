/* ============================================================
 * prism-shapes1d.js —— 一维棱镜（肋条）截面形状内核
 *
 * 为什么单独成文件：
 *   一维原先只有一种 V 形肋，公式（半底宽、截面积）直接写在 prism.js 里。
 *   补形状时若照原样在 prism.js 里加分支，就会形成「几何量 / 预览网格 /
 *   STEP / 脚本」四处各写一遍的局面 —— 二维那边正是为此把公式抽成了
 *   prism-shapes.js。一维同理。
 *
 * 形状无关的下游（prism.js 负责）：折线 → 圆角 → 拉伸成 3D → STEP / 脚本。
 * 本文件只回答三件事：
 *   ① α 在这个形状里是什么量、定义域是什么；
 *   ② 半底宽 b 怎么算；
 *   ③ 单个肋的截面点怎么生成（曲面形状要连圆弧元数据一起给，
 *      否则 STEP 只能写成分片折线）。
 *
 * 角度约定（各形状不同，UI 上会随形状改写标签与提示，不能混用）：
 *   tri  顶角 α  —— 齿顶两条齿面的**全角**（沿用一维原有定义，不改动）
 *   trap 倾角 α  —— 侧面与底面的夹角
 *   cyl  切线角 α —— 底缘处切线与底面的夹角（90° 即正半圆）
 *   saw  缓面倾角 α —— 缓侧斜面与底面的夹角，陡侧竖直
 *   sine 最大坡度 α —— 拐点处斜率对应的角
 *   para 切线角 α —— 底缘处切线与底面的夹角
 *
 * 所有曲面（cyl / sine / para）都按折线采样给预览与网格，面积另给解析值
 * （采样折线比真实曲线小 0.2%~0.6%，直接拿鞋带公式当"精确值"会与 STEP
 * 导出的真圆弧对不上 —— 这正是本站此前踩过的口径不一致）。
 * ============================================================ */
(function () {
  'use strict';

  var RAD = Math.PI / 180;

  /* 曲面采样段数：预览够顺、STEP 合并后每段 ≤60°（有理二次 Bézier 在
     Δ≥180° 时 w1=cos(Δ/2)→0 会退化，故必须切成小段）。 */
  var SEG_CYL = 16, SEG_SOFT = 24;

  var S = {
    tri: {
      name: '三角形肋（V 型）', en: 'Triangular rib',
      angleLabel: '顶角 α', angleHint:
        '齿顶处两条齿面之间的夹角 α，是<b>全角</b>（不是半角，也不是斜面与底面的夹角）。' +
        '半底宽 <b>b = h·tan(α/2)</b>，齿底宽 2b。',
      aMin: 5, aMax: 175, aDef: 60, usesTop: false, curved: false,
      hint: '标准增亮膜 / 棱镜膜的形态：等腰三角肋，顶角常取 90°（BEF 类）。齿间平台 (pitch−2b) 不参与角度变换，只贡献平面泄漏。',
      bExpr: '半底宽 b = h·tan(α/2)',
      bOf: function (h, a) { return h * Math.tan(a * RAD / 2); },
      areaOf: function (h, b) { return b * h; },
      profile: function (c) {
        return { pts: [[c.xc + c.b, c.t], [c.xc, c.t + c.h], [c.xc - c.b, c.t]],
                 skip: [false, false, false], meta: null };
      }
    },

    trap: {
      name: '梯形肋（平顶 / 截头）', en: 'Trapezoidal rib',
      angleLabel: '侧面倾角 α', angleHint:
        '侧面与<b>底面</b>的夹角 α（与三角肋的「顶角」不是同一个量）。' +
        '半底宽 <b>b = h/(tanα·(1−k))</b>，平顶半宽 = k·b。平顶不参与角度变换，' +
        '只增加脱模余量与耐刮面积 —— 实物棱镜膜的平顶就是为此。',
      aMin: 10, aMax: 85, aDef: 60, usesTop: true, curved: false,
      hint: '平顶截头肋：牺牲一部分角度变换面积换取耐刮与脱模——实物膜片齿顶被压平后就长这样。',
      bExpr: '半底宽 b = h/(tanα·(1−k))',
      bOf: function (h, a, k) { return h / (Math.tan(a * RAD) * (1 - k)); },
      areaOf: function (h, b, k) { return h * b * (1 + k); },
      profile: function (c) {
        var kt = c.k * c.b;
        return { pts: [[c.xc + c.b, c.t], [c.xc + kt, c.t + c.h],
                       [c.xc - kt, c.t + c.h], [c.xc - c.b, c.t]],
                 skip: [false, false, false, false], meta: null };
      }
    },

    cyl: {
      name: '半圆柱脊（柱面微透镜）', en: 'Cylindrical / lenticular ridge',
      angleLabel: '底缘切线角 α', angleHint:
        '底缘处切线与<b>底面</b>的夹角 α：<b>α = 90° 即正半圆</b>，' +
        '小于 90° 是浅的弓形，大于 90° 会出现倒扣（脱模困难）。' +
        '半底宽 <b>b = h·cot(α/2)</b>，弧半径 R = (b²+h²)/(2h)。' +
        'STEP 里写成真圆柱面（多段有理 Bézier 精确圆弧），不是分片折线。',
      aMin: 20, aMax: 90, aDef: 90, usesTop: false, curved: true,
      hint: '柱面微透镜阵列（lenticular）：无尖角、光学上偏扩散，多见于防窥膜与扩散增亮复合膜。',
      bExpr: '半底宽 b = h·cot(α/2)',
      bOf: function (h, a) { return h / Math.tan(a * RAD / 2); },
      /* 弓形面积：R²·φ − b·(R−h)，φ = asin(b/R)。半圆时 R=b=h，φ=π/2 → πR²/2 */
      areaOf: function (h, b) {
        var R = (b * b + h * h) / (2 * h);
        var s = Math.min(1, b / R);
        var phi = Math.asin(s);
        return R * R * phi - b * (R - h);
      },
      profile: function (c) {
        var R = (c.b * c.b + c.h * c.h) / (2 * c.h);
        var cy = c.t + c.h - R;
        /* 右基 → 顶 → 左基：θ 递增，θ_top = 90° */
        var thR = Math.atan2(R - c.h, c.b);
        var thL = Math.atan2(R - c.h, -c.b);
        var meta = { cx: c.xc, cy: cy, r: R, cv: true };
        var pts = [], skip = [], m = SEG_CYL;
        for (var j = 0; j <= m; j++) {
          var th = thR + (thL - thR) * (j / m);
          pts.push([c.xc + R * Math.cos(th), cy + R * Math.sin(th)]);
          /* 首尾是与平板的交角（要倒圆角），中间是弧上采样点（不能倒） */
          skip.push(!(j === 0 || j === m));
        }
        return { pts: pts, skip: skip, meta: meta };
      }
    },

    saw: {
      name: '锯齿肋（非对称斜肋）', en: 'Blazed / sawtooth rib',
      angleLabel: '缓面倾角 α', angleHint:
        '缓侧斜面与<b>底面</b>的夹角 α；陡侧<b>竖直</b>。底宽 = h/tanα，' +
        '半宽 <b>b = h/(2·tanα)</b>（此处 b 是半宽，齿形左右不对称）。' +
        '非对称截面把出光偏到一侧 —— 转向膜、导光板耦合就是靠它。',
      aMin: 10, aMax: 80, aDef: 45, usesTop: false, curved: false,
      hint: '非对称斜肋：一侧陡一侧缓，把出光整体偏到一侧——转向膜与导光板耦合靠它。',
      bExpr: '半宽 b = h/(2·tanα)',
      bOf: function (h, a) { return h / (2 * Math.tan(a * RAD)); },
      areaOf: function (h, b) { return b * h; },      /* 直角三角形：½·2b·h */
      profile: function (c) {
        /* 陡面在右：右基竖直上到齿顶，再沿缓面斜下到左基 */
        return { pts: [[c.xc + c.b, c.t], [c.xc + c.b, c.t + c.h], [c.xc - c.b, c.t]],
                 skip: [false, false, false], meta: null };
      }
    },

    sine: {
      name: '正弦波脊', en: 'Sinusoidal / wavy ridge',
      angleLabel: '最大坡度 α', angleHint:
        '波形在拐点处的最大坡度角 α（底缘处斜率为 0，与平板<b>平滑相接</b>，' +
        '没有尖角 —— 脱模最好、也最不容易看出摩尔纹）。' +
        '半底宽 <b>b = πh/(2·tanα)</b>，截面积 = b·h。',
      aMin: 10, aMax: 80, aDef: 60, usesTop: false, curved: true,
      hint: '正弦波脊：与平板平滑相接、没有尖角，脱模最好，但角度变换能力最弱（偏扩散）。',
      bExpr: '半底宽 b = πh/(2·tanα)',
      areaOf: function (h, b) { return b * h; },
      bOf: function (h, a) { return Math.PI * h / (2 * Math.tan(a * RAD)); },
      profile: function (c) {
        var pts = [], skip = [], m = SEG_SOFT;
        for (var j = 0; j <= m; j++) {
          var u = 1 - 2 * (j / m);                    /* +1 → −1 */
          pts.push([c.xc + c.b * u, c.t + (c.h / 2) * (1 + Math.cos(Math.PI * u))]);
          skip.push(!(j === 0 || j === m));
        }
        return { pts: pts, skip: skip, meta: null };
      }
    },

    para: {
      name: '抛物面脊', en: 'Parabolic ridge',
      angleLabel: '底缘切线角 α', angleHint:
        '底缘处切线与<b>底面</b>的夹角 α。曲面斜率由缓变陡，利于把大角度光' +
        '收回轴向（准直）。半底宽 <b>b = 2h/tanα</b>，截面积 = (4/3)·b·h。',
      aMin: 10, aMax: 80, aDef: 60, usesTop: false, curved: true,
      hint: '抛物面脊：斜率由缓变陡，利于把大角度光收回轴向，准直性介于三角肋与柱面脊之间。',
      bExpr: '半底宽 b = 2h/tanα',
      areaOf: function (h, b) { return (4 / 3) * b * h; },
      bOf: function (h, a) { return 2 * h / Math.tan(a * RAD); },
      profile: function (c) {
        var pts = [], skip = [], m = SEG_SOFT;
        for (var j = 0; j <= m; j++) {
          var u = 1 - 2 * (j / m);
          pts.push([c.xc + c.b * u, c.t + c.h * (1 - u * u)]);
          skip.push(!(j === 0 || j === m));
        }
        return { pts: pts, skip: skip, meta: null };
      }
    }
  };

  var IDS = ['tri', 'trap', 'cyl', 'saw', 'sine', 'para'];

  function of(id) { return S[id] || S.tri; }

  /* 半底宽（含封顶）：2b 超过 pitch 时相邻肋必然重叠，按半齿距封顶。
     调用方须就此给出可见告警，不能静默封顶。 */
  function halfOf(id, p) {
    var k = p.topRatio || 0;
    var want = of(id).bOf(p.height, p.angle, k);
    var max = p.pitch / 2;
    if (!isFinite(want) || want < 0) want = max;
    return { want: want, use: Math.min(want, max), clamped: want > max + 1e-9 };
  }

  /* 整板截面（X-Z 平面，逆时针）
     返回 { pts, skip, inMeta, polyArea }：
       pts     —— 折线顶点（曲面形状含采样点）
       skip[k] —— 该顶点是否**不是**拐角（弧上采样点不该倒圆角）
       inMeta[k]——「pts[k−1] → pts[k]」这条边是圆弧时给 {cx,cy,r}，否则 null
       polyArea —— 未倒圆角时的解析截面积（平板 + N×单肋），曲面用解析式 */
  function profileOf(id, p, half) {
    var sh = of(id);
    var pitch = p.pitch, t = p.base, h = p.height, N = p.N, W = N * pitch;
    var k = p.topRatio || 0;

    var pts = [[0, 0], [W, 0], [W, t]];
    var skip = [false, false, false];
    var inMeta = [null, null, null];      /* 进入该点的那条边的弧元数据 */

    for (var i = N - 1; i >= 0; i--) {
      var r = sh.profile({ xc: (i + 0.5) * pitch, t: t, h: h, b: half, k: k });
      for (var j = 0; j < r.pts.length; j++) {
        pts.push(r.pts[j]);
        skip.push(r.skip[j]);
        /* 肋内相邻点之间是弧（曲面形状）；进入肋第一个点的那条边是平板，为 null */
        inMeta.push(j === 0 ? null : r.meta);
      }
    }
    pts.push([0, t]);
    skip.push(false);
    inMeta.push(null);

    var d = dedupeMasked(pts, skip, inMeta);
    return {
      pts: d.pts, skip: d.skip, inMeta: d.inMeta,
      polyArea: W * t + N * sh.areaOf(h, half, k)
    };
  }

  /* 折线去重（保 skip / inMeta 对齐）
     为什么必须有：2b = pitch 是最密排（合法），此时相邻两肋的基点重合，
     轮廓里出现重合点 → 零长边 → 面法线零向量 → STEP 里写出非法的
     DIRECTION(0,0,0)。详见 prism.js 中 dedupePts 的说明。
     这里不能直接用 pts 版去重 —— 三个数组必须同步删。 */
  function dedupeMasked(pts, skip, inMeta) {
    var eps = 1e-9;
    var op = [], os = [], om = [];
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i], r = op[op.length - 1];
      if (!r || Math.hypot(q[0] - r[0], q[1] - r[1]) > eps) {
        op.push(q); os.push(skip[i]); om.push(inMeta[i]);
      } else if (inMeta[i]) {
        /* 删掉重合点后，进入它的那条弧元数据要让合并后的边继承 */
        om[om.length - 1] = inMeta[i];
      }
    }
    if (op.length > 1) {
      var a = op[0], z = op[op.length - 1];
      if (Math.hypot(a[0] - z[0], a[1] - z[1]) <= eps) { op.pop(); os.pop(); om.pop(); }
    }
    return { pts: op, skip: os, inMeta: om };
  }

  window.PrismShapes1D = {
    IDS: IDS, S: S, of: of,
    halfOf: halfOf, profileOf: profileOf
  };
})();
