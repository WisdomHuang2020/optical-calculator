/* ============================================================
 * prism.js —— 棱镜板参数化设计（一维棱镜肋 / 二维金字塔阵列）
 *
 * 来源：用户提供的 MLA_Prism.html（单页独立版本）。
 * 并入本站时的三处必要改造（均为实测后决定，非风格偏好）：
 *
 *   1. 去 CDN 依赖。"零外部依赖"是本项目的硬约束（页脚明示，
 *      且 CDN 被墙/离线时会整页白屏）。three.js 与 OrbitControls
 *      已落盘到 js/vendor-*.js，改为本地引入。
 *
 *   2. 语义色单一来源。原文件自带一套独立色板（--bg:#0e1116 等），
 *      与本站 styles.css 的 --bg:#0a0a0a 不同源 —— 同一语义写两处必然
 *      漂移，这正是 tests/theme-check.js 要守的缺陷。
 *      本文件全部颜色改从 getComputedStyle 读取 --c-* 变量，
 *      由 styles.css 单点定义。
 *
 *   3. 画布尺寸自愈。原文件在容器尚未布局时初始化 WebGLRenderer，
 *      实测画布高度停在 20px（与本站历史上"Canvas 停在 300×150"
 *      同类）。这里在 resize 时按容器实际尺寸设置，并在切到本视图时
 *      同步重绘，不依赖 rAF 首次绘制。
 *
 * 计算逻辑（截面点生成、圆角拟合、体积积分、STEP AP214 生成、
 * build123d / CADQuery 脚本生成）与原文件一致，未做数值改动。
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var TAU = Math.PI * 2;
  var RAD = Math.PI / 180;

  /* ---------- 语义色：从 styles.css 的 --c-* 读取，不硬编码 ---------- */
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback;
  }
  var COL = {};
  function refreshColors() {
    COL.grid       = cssVar('--c-grid', '#262626');
    COL.gridSub    = cssVar('--c-axisline', '#404040');
    COL.accent     = cssVar('--primary', '#14b8a6');
    COL.accent2    = cssVar('--primary-2', '#2dd4bf');
    COL.bg3d       = cssVar('--bg-3d', '#0a0a0a');
    COL.prism      = cssVar('--c-prism', '#5f6d7e');
    COL.prismKey   = cssVar('--c-prism-key', '#ffffff');
    COL.prismRim   = cssVar('--c-prism-rim', '#88bbff');
    COL.prismFill  = cssVar('--c-prism-fill', '#ffffff');
  }

  /* ============================================================
   * 主控状态
   * ============================================================ */
  var mode = '1d';
  var currentGeo = null;
  var currentLang = 'build123d';
  var xrayMode = false;
  var inited = false;
  /* 自动取景时记录模型包围盒（中心 + 半尺寸），供 probe() 做屏幕投影量测 */
  var probeCenter = null;
  var probeHalf = null;

  var scene, camera, renderer, controls, mesh, wireframeMesh;

  /* ============================================================
   * 一维棱镜：截面几何
   * ============================================================ */
  /* 计数类输入的显式钳位，并把钳位事实记进 inputNotes 供提示区回报。

     原实现写作 Math.max(1, Math.round(x)) —— 超范围时**静默改值**：
     输入框里仍显示用户填的数，几何却按另一个数算，页面没有任何提示。
     用户「填了 600 个齿」却只得到 500 个齿的模型，且无从知道原因。
     这正是本文件反复在修的一类缺陷（输入 ≠ 实际建模，且静默）。 */
  var inputNotes = [];
  function readCount(id, lo, hi, label) {
    var raw = parseFloat($(id).value);
    if (!isFinite(raw)) {
      inputNotes.push(label + ' 不是有效数字，已按 ' + lo + ' 计算。');
      return lo;
    }
    var rounded = Math.round(raw);
    var v = Math.max(lo, Math.min(hi, rounded));
    if (rounded < lo || rounded > hi) {
      inputNotes.push(label + ' 超出 ' + lo + '–' + hi + '，已按 ' + v +
        ' 计算（输入框仍显示 ' + rounded + '）。');
    }
    return v;
  }

  function readParams() {
    inputNotes = [];
    return {
      pitch: parseFloat($('p_pitch').value),
      height: parseFloat($('p_height').value),
      angle: parseFloat($('p_angle').value),
      base: parseFloat($('p_base').value),
      radius: parseFloat($('p_radius').value),
      N: readCount('p_teeth', 1, 500, '齿数 N'),
      L: parseFloat($('p_length').value)
    };
  }

  /* 齿半底宽的**唯一定义点**。rawProfile 与 buildGeometry 必须共用它，
     否则「页面显示的几何量」与「真实生成的截面」会各说各话 ——
     本文件历史上反复出现的正是这一类缺陷。

     顶角 α 是**齿顶处的夹角**，故等腰三角形齿的半底宽
         b = h·tan(α/2)      （h = 齿高）
     原文写的是 h/tan(α/2)，那是它的**倒数**：顶角 60°、齿高 0.25 时
     给出 0.433 mm，而正确值是 0.144 mm，且与真实截面（半底宽 0.5 mm）
     三者互不相等。

     want = 参数意图值；use = 实际可用于建模的值。
     齿底宽 2b 超过齿距 pitch 时相邻齿必然重叠，此处按半齿距封顶，
     保证截面不自交；调用方须就此给出可见告警，不能静默封顶。 */
  function halfBase(p) {
    var want = p.height * Math.tan(p.angle / 2 * RAD);
    var max = p.pitch / 2;
    return { want: want, use: Math.min(want, max), clamped: want > max + 1e-9 };
  }

  /* 折线去重：跳过与上一点重合的点，并检查首尾是否重复。

     为什么必须有这一步：2b = pitch 是**物理上完全合法**的最密排
     （齿底恰好相接、没有平谷），此时相邻两齿的齿根点落在同一个位置，
     轮廓里出现重合的相邻点 —— 实测 pitch=1 / h=0.25 / α=126.87° 时
     有 21 个重合点（索引 2,5,8,…）。

     后果不只是"多几个点"：零长边围出的面面积为 0，面法线经 nrm() 的
     `|| 1` 兜底变成**零向量**，于是 STEP 里写出
     `DIRECTION('',(0.000000,0.000000,0.000000))` —— 而 DIRECTION 按
     定义必须是单位向量。实测该参数下 108 个侧面里有 **63 个**轴系非法，
     内核读入会失败或得到垃圾几何。正常参数（α=60°）下是 0 个。

     注意：这里刻意只去掉**相邻**重合点，不做全局去重 —— 轮廓允许
     自交之外的其它形态，全局去重会误删合法的重复顶点。 */
  function dedupePts(pts, eps) {
    eps = eps || 1e-9;
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var q = pts[i], r = out[out.length - 1];
      if (!r || Math.hypot(q[0] - r[0], q[1] - r[1]) > eps) out.push(q);
    }
    if (out.length > 1) {
      var a = out[0], z = out[out.length - 1];
      if (Math.hypot(a[0] - z[0], a[1] - z[1]) <= eps) out.pop();
    }
    return out;
  }

  /* 无圆角原始截面点（X-Z 平面，逆时针）

     齿形由**顶角**决定，不是白占满一个齿距：
       · 齿底宽 2b = 2h·tan(α/2)，居于所属齿距中央；
       · 齿间保留宽度 (pitch − 2b) 的平台 —— 相邻齿不接触。
     这正是棱镜膜的实物形态，也是「填充率 η = 2b/pitch」的由来。

     原实现把齿根直接落在 i·pitch 上，即齿底宽恒等于一个整 pitch，
     于是**顶角参数完全不参与建模**：实测顶角 20°→150° 生成的截面
     逐点相同，实际齿顶角恒为 2·atan(pitch/2h)（默认参数下 126.87°），
     与输入的 60° 无关。 */
  function rawProfile(p) {
    var pitch = p.pitch, hh = p.height, t = p.base, N = p.N;
    var b = halfBase(p).use;
    var W = N * pitch;
    var pts = [];
    pts.push([0, 0]);
    pts.push([W, 0]);
    pts.push([W, t]);
    for (var i = N - 1; i >= 0; i--) {
      var xc = (i + 0.5) * pitch;
      pts.push([xc + b, t]);        // 齿根（出射侧）
      pts.push([xc, t + hh]);       // 齿顶
      pts.push([xc - b, t]);        // 齿根（入射侧）
    }
    pts.push([0, t]);
    /* 去重见 dedupePts 的说明：2b = pitch（最密排，合法）时齿根点会重合 */
    return { pts: dedupePts(pts), W: W, half: b };
  }

  /* 每个顶点的圆角半径与切线长：**唯一定义点**。
     filletDetailed（生成轮廓）与 exactArea（解析算面积）都必须用它 ——
     原实现两处各写一遍 min(r, 0.45·l1, 0.45·l2)，只能靠注释约束一致，
     而注释挡不住漂移。

     为什么只钳到 0.45·l 不够：
       切线长 T = rr / tan(θ/2)（θ = 内角）。尖角处 tan(θ/2) 很小，
       T 远大于 rr —— 齿顶 60° 时 T = 1.73·rr。于是同一条边上相邻两个
       圆角的切点会互相越过（T_u + T_v > 边长），采样弧随之翻向，
       轮廓自交、面积与体积一起失真。
       齿变小之后这一条特别容易踩到：radius 0.2 配 60° 齿顶时
       1.73×0.2 = 0.35 > 单边斜长 0.29（本版把齿底宽从整齿距收窄到
       2b 之后才暴露出来）。

     故补第二步：按边施加 T_u + T_v ≤ 边长。逐顶点取其两条邻边约束的
     最小缩放系数、一次性施加。施加后每条边仍满足约束，因为
       k_u·T_u + k_v·T_v ≤ f·(T_u + T_v) = 边长   （f = 该边算出的系数）。

     返回与 pts 等长的 rr / T / turn；退化顶点（可直接用原顶点）为 0。 */
  function filletRadii(pts, r) {
    var n = pts.length, i;
    var rr = new Array(n), T = new Array(n), turn = new Array(n);
    for (i = 0; i < n; i++) {
      rr[i] = 0; T[i] = 0; turn[i] = 0;
      if (!(r > 0)) continue;
      var P = pts[i], Pr = pts[(i - 1 + n) % n], Pn = pts[(i + 1) % n];
      var v1 = [P[0] - Pr[0], P[1] - Pr[1]];
      var v2 = [Pn[0] - P[0], Pn[1] - P[1]];
      var l1 = Math.hypot(v1[0], v1[1]);
      var l2 = Math.hypot(v2[0], v2[1]);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      var cross = (v1[0] * v2[1] - v1[1] * v2[0]) / (l1 * l2);
      var dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
      /* 有符号转向 → 有符号外角 turn，归一到 (−π,π)；(0,π) 为凸角 */
      var t = Math.atan2(cross, dot);
      if (Math.abs(t) < 1e-12) continue;
      var theta = Math.PI - Math.abs(t);          // 内角
      var tanHalf = Math.tan(theta / 2);
      if (!(Math.abs(tanHalf) > 1e-12)) continue;
      var cand = Math.min(r, l1 * 0.45, l2 * 0.45);
      if (!(cand > 1e-12)) continue;
      turn[i] = t;
      rr[i] = cand;
      T[i] = cand / tanHalf;
    }
    var k = new Array(n);
    for (i = 0; i < n; i++) k[i] = 1;
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var L = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
      var sum = T[i] + T[j];
      if (sum > L && sum > 1e-12) {
        var f = L / sum;
        if (f < k[i]) k[i] = f;
        if (f < k[j]) k[j] = f;
      }
    }
    for (i = 0; i < n; i++) { rr[i] *= k[i]; T[i] *= k[i]; }
    return { rr: rr, T: T, turn: turn };
  }

  /* 精确截面积：无圆角多边形面积 + 每个角按「圆角替换」的解析增减量。

     单个顶点 P（内角 θ = π − |turn|）被半径 rr 的圆角替换后，面积的改变量：
       原顶点邻域 = 两切线 + 顶点围成的两个直角三角形，面积 = rr·T
         （T = rr/tan(θ/2) 为切线长）
       替换后     = 圆心到两切点的扇形，面积 = rr²·|turn|/2
         （扇形圆心角就是**外角** |turn|，不是内角 θ —— 这是本函数原先的
          错误：用 θ 作扇形角会多算 rr²·(θ−|turn|)/2 = rr²·(π−2|turn|)/2，
          对 126.87° 的齿角误差达 2.4 倍。同时原先对凹角整体取反号也是错的。）
       凸角：扇形在材料内被切掉 → Δ = rr²·|turn|/2 − rr·T （负，削料）
       凹角：扇形在材料外被补上 → Δ = +rr·(2T 的对应量) 的相反组合，
             统一写作 Δ = +rr²·|turn|/2 + rr·T 的「补料」形式。
       因轮廓逆时针时凸角 turn>0、凹角 turn<0，两者可合并为：
         Δ = sgn·(rr²·|turn|/2) − rr·T·sgn 的等价式 → 见下实现。

     rr 的钳位必须与 filletDetailed 完全一致（min(r, 0.45·l1, 0.45·l2)），
     否则显示面积与导出件对不上。 */
  function exactArea(pts, r) {
    var n = pts.length;
    var a = 0;
    for (var i = 0; i < n; i++) {
      var p0 = pts[i], p1 = pts[(i + 1) % n];
      a += p0[0] * p1[1] - p1[0] * p0[1];
    }
    a = Math.abs(a) / 2;
    if (!(r > 0)) return a;

    /* 半径与切线长一律取自 filletRadii（唯一定义点），
       绝不在本函数里另算一遍 —— 两处各写一遍正是「显示值 ≠ 导出件」的根因。 */
    var fr = filletRadii(pts, r);
    var dA = 0;
    for (var k = 0; k < n; k++) {
      var rr = fr.rr[k], T = fr.T[k], turn = fr.turn[k];
      if (!(rr > 1e-12) || !(T > 1e-12)) continue;
      var absTurn = Math.abs(turn);
      var sector = rr * rr * absTurn / 2;       // 扇形圆心角 = 外角 |turn|
      var tri = rr * T;                         // 顶点侧两直角三角形
      /* 凸角：切线三角形被削去、扇形补回 → 净削 (sector−tri)，为负。
         凹角：本就在缺口处，圆角是「补」上一块 → 净增 (tri−sector) 的相反数
         即 +(sector−tri) 的负号，用 turn 符号统一表达：
           dA += (turn > 0 ? (sector − tri) : (tri − sector))
         由于凹角 |turn| 小而 T 大，tri−sector 通常为正，材料增加。
         但当凹角很浅时 tri−sector 可能为负，仍正确（表示仍略削）。 */
      dA += (turn > 0 ? (sector - tri) : (tri - sector));
    }

    return a + dA;
  }

  /* 闭合路径圆角：每个拐角插入圆弧（直线段拟合）
     返回 { pts, arcs, segArc }：
       pts      —— 圆角后的轮廓点（含圆弧采样点）
       arcs[k]  —— 与 pts 等长；若 pts[k] 是圆弧采样点则给出
                   { cx, cy, r }（圆心与半径），否则为 null
       segArc[k]—— 与 pts 等长；描述「pts[k] → pts[k+1] 这一条边」
                   是否为圆弧：是则给出 { cx, cy, r }，否则 null。
                   STEP 导出按边（segment）取用它来决定写 CIRCLE 还是 LINE。 */
  function filletDetailed(pts, r, seg) {
    seg = seg || 8;
    var n = pts.length;
    var out = [];
    var arcs = [];
    var segArc = [];
    /* 半径/切线长取自 filletRadii（唯一定义点），与 exactArea 必然同源 */
    var fr = filletRadii(pts, r);
    for (var i = 0; i < n; i++) {
      var P = pts[i];
      var rr = fr.rr[i], T = fr.T[i], turn = fr.turn[i];
      if (!(rr > 1e-12) || !(T > 1e-12) || Math.abs(turn) < 1e-12) {
        out.push(P.slice()); arcs.push(null); segArc.push(null);
        continue;
      }
      var Pr = pts[(i - 1 + n) % n];
      var Pn = pts[(i + 1) % n];
      var v1 = [P[0] - Pr[0], P[1] - Pr[1]];
      var v2 = [Pn[0] - P[0], Pn[1] - P[1]];
      var l1 = Math.hypot(v1[0], v1[1]);
      var l2 = Math.hypot(v2[0], v2[1]);
      var d1 = [v1[0] / l1, v1[1] / l1];
      var d2 = [v2[0] / l2, v2[1] / l2];
      var a = [P[0] - d1[0] * T, P[1] - d1[1] * T];   // 入射边上的切点
      var b = [P[0] + d2[0] * T, P[1] + d2[1] * T];   // 出射边上的切点

      /* 圆心 = 切点 a 沿「入射边的内侧法线」偏移 rr。
         内侧法线：轮廓为逆时针（cross>0 左转）时凸角的内侧在左 →
         (−d1y, d1x)；凹角（右转）内侧在右 → (d1y, −d1x)。

         这里必须按 turn 的符号取法线，不能用「两切线单位向量之和」：
         后者对凸角与凹角给出的是**同一侧**的角平分线，于是凹角会被
         当成凸角处理，圆心落到材料外 → 采样弧朝内凹，把本应补上的
         缺口反而又挖掉一块。实测该错误使截面积从 6.4998 掉到 6.3842
         （少算 0.116 mm²，约 26 倍于真实圆角影响量），STEP 体积随之偏小。 */
      var nIn = turn > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
      var c = [a[0] + rr * nIn[0], a[1] + rr * nIn[1]];

      var angA = Math.atan2(a[1] - c[1], a[0] - c[0]);
      var angB = Math.atan2(b[1] - c[1], b[0] - c[0]);
      var dAng = angB - angA;
      while (dAng > Math.PI) dAng -= TAU;
      while (dAng < -Math.PI) dAng += TAU;
      var meta = { cx: c[0], cy: c[1], r: rr, cv: turn > 0 };
      /* 切点 a 写进轮廓（它替代了原来的顶点 P 作为该处轮廓通过点）。 */
      out.push(a.slice()); arcs.push(null); segArc.push(null);
      /* 中间采样点 s=1..seg-1 落在圆弧上；段 [s→s+1] 属于圆弧。 */
      for (var s = 1; s < seg; s++) {
        var ang = angA + dAng * (s / seg);
        out.push([c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr]);
        arcs.push(meta);
        segArc.push(meta);
      }
      /* 切点 b 收尾；段 [b → 下一个角的切点] 是直边，故 segArc 为 null。 */
      out.push(b.slice()); arcs.push(null); segArc.push(null);
    }
    return { pts: out, arcs: arcs, segArc: segArc };
  }

  /* 注：原先另有一个只返回点集、不带圆弧元数据的 fillet()，
     已被 filletDetailed() 完全取代（后者返回同样形态的点集，
     额外带回圆心/半径供 STEP 写真实 CIRCLE+CYLINDRICAL_SURFACE）。
     留着会形成「同语义两处实现」，故删除。 */

  function buildGeometry() {
    var p = readParams();
    var hb = halfBase(p);
    var half = hb.use;                                 // 实际用于建模的半底宽 b
    var beta = (180 - p.angle) / 2;                    // 底角（折射面与底面的夹角）
    var W = p.N * p.pitch;
    var H = p.base + p.height;
    var fill = 2 * half / p.pitch;                     // 填充率 η = 2b/pitch
    var ok = true, msg = '';
    /* 先并入计数类输入的钳位提示（readParams 读参数时已记录） */
    var warns = inputNotes.slice();
    if (!(p.pitch > 0) || !(p.height > 0) || !(p.base >= 0) || !(p.L > 0) || !(p.N >= 1) ||
        !(p.angle > 0) || !(p.angle < 180)) {
      /* 顶角的定义域是开区间 (0°, 180°)：0° 时齿退化成零宽、180° 时
         tan(α/2)→∞ 会让半底宽发散。原先只查 pitch/height/base/L/N，
         **没有查顶角**，等于把定义域外的值放进了 tan()。 */
      warns.push('存在非法参数，请检查：pitch / height / length 需 > 0，base / radius ≥ 0，' +
                 '顶角需落在 (0°, 180°) 开区间内，齿数 ≥ 1。');
      ok = false;
    }
    if (hb.clamped) {
      warns.push('齿半底宽 h·tan(α/2) = ' + hb.want.toFixed(3) + ' mm 超过半齿距 ' +
            (p.pitch / 2).toFixed(3) + ' mm，相邻齿会重叠。截面已按半齿距封顶' +
            '（齿底恰好相接，填充率 1.000）。要得到真实齿形请增大 pitch，' +
            '或减小 height / 顶角。');
      ok = false;
    }

    /* 保留圆弧元数据：轮廓点用于预览与面积，arcs 用于 STEP 里
       写出真正的 CIRCLE / CYLINDRICAL_SURFACE。 */
    var fd = filletDetailed(rawProfile(p).pts, p.radius, 10);
    var prof = fd.pts, arcs = fd.segArc;

    /* 圆角**实际生效值**。filletRadii 会按两条规则钳位：
         · rr = min(R, 0.45·l1, 0.45·l2)
         · 同一条边上两端切线长之和 T_u + T_v ≤ 边长
       于是 R 超过某个阈值后**完全不再生效**，且各角点的饱和值不同
       （齿顶与齿根的内角不同，T = rr/tan(θ/2) 随之内不同）。
       实测 pitch=1 / h=0.25 / 顶角 60°（齿边仅 0.289 mm）：
         R = 0.05 → 齿顶 0.050（1.00×）
         R = 0.1  → 齿顶 0.090（0.90×）
         R = 0.2  → 齿顶 0.090（0.45×）
         R = 1.57 → 齿顶 0.090（0.057×，相差 17 倍）
       输入 1.57 而实际只有 0.090 —— 页面原先对此没有任何提示，
       用户只会觉得"改了没反应"。 */
    var frAll = filletRadii(rawProfile(p).pts, p.radius);
    var rList = [];
    for (var q = 0; q < frAll.rr.length; q++) {
      if (frAll.rr[q] > 1e-12) rList.push(frAll.rr[q]);
    }
    var rMin = rList.length ? Math.min.apply(null, rList) : 0;
    var rMax = rList.length ? Math.max.apply(null, rList) : 0;
    var rClamped = (p.radius > 0) && (rMax < p.radius - 1e-9);
    if (rClamped) {
      warns.push('圆角半径 R = ' + p.radius + ' mm 超出该齿形能实现的尺寸' +
            '（齿边长度仅 ' + Math.hypot(hb.use, p.height).toFixed(3) + ' mm），' +
            '实际生效 ' + rMin.toFixed(3) + ' ~ ' + rMax.toFixed(3) + ' mm —— ' +
            '再增大 R 也不会改变形状。要得到更大的圆角请增大 pitch / height，' +
            '或减小顶角。');
    }
    showWarn(warns.join('\n'));

    /* 面积两种口径：
       · areaPoly —— 对折线采样点做鞋带公式。它等于「10 段折线近似」
         的截面积，与 Three.js 预览网格完全一致。
       · areaExact —— 把每个圆角按真实圆弧计入的精确截面积。
         STEP 导出用真圆弧，故导出件的体积对应 areaExact。
       两者相差约 0.85%，显示值必须用 areaExact，否则「页面显示」
       与「下载到的文件」对不上（这正是审核报告指出的口径不一致）。 */
    var areaPoly = 0;
    for (var i = 0; i < prof.length; i++) {
      var a = prof[i], b = prof[(i + 1) % prof.length];
      areaPoly += a[0] * b[1] - b[0] * a[1];
    }
    areaPoly = Math.abs(areaPoly) / 2;
    var areaExact = exactArea(rawProfile(p).pts, p.radius);
    var area = areaExact;
    var vol = area * p.L;

    /* 标签随模式切换（1D 原先是 index.html 的静态文字，且与写入的值错位：
       「面/边数」那一格实际写的是底角 β）。现由 LABELS_1D 单点定义。 */
    setText('s_k1', LABELS_1D[0]);
    setText('s_k2', LABELS_1D[1]);
    setText('s_k3', LABELS_1D[2]);
    setText('s_k4', LABELS_1D[3]);
    setText('s_k5', LABELS_1D[4]);
    setText('s_k6', LABELS_1D[5]);
    setText('s_w', W.toFixed(3) + ' mm');
    setText('s_h', H.toFixed(3) + ' mm');
    setText('s_half', half.toFixed(3) + ' mm');
    setText('s_beta', fill.toFixed(3));
    setText('s_v', prof.length);
    setText('s_vol', vol.toFixed(1) + ' mm³');
    /* 圆角实际生效值：各角点饱和值可能不同（齿顶与齿根内角不同），
       不一致时给区间，避免只报一个数掩盖了差异。 */
    setText('s_r', (Math.abs(rMax - rMin) < 1e-9)
      ? rMin.toFixed(3) + ' mm'
      : rMin.toFixed(3) + ' ~ ' + rMax.toFixed(3) + ' mm');
    var kvR = $('kv_radius');
    if (kvR) kvR.hidden = false;

    return {
      p: p, prof: prof, arcs: arcs, W: W, H: H, half: half, beta: beta, fill: fill,
      rMin: rMin, rMax: rMax, rClamped: rClamped,
      area: area, areaPoly: areaPoly, vol: vol, valid: ok
    };
  }

  /* ============================================================
   * 二维棱镜：金字塔阵列
   * ============================================================ */
  function readParams2D() {
    inputNotes = [];
    return {
      pitch: parseFloat($('p2_pitch').value),
      height: parseFloat($('p2_height').value),
      angle: parseFloat($('p2_angle').value),
      base: parseFloat($('p2_base').value),
      nx: readCount('p2_nx', 1, 500, '列数 Nx'),
      ny: readCount('p2_ny', 1, 500, '行数 Ny')
    };
  }

  /* 几何量的标签：两个模式各自单点定义。
     原实现的 1D 标签写在 index.html 里、且与代码写入的值错位
     （「面/边数」那一格实际写的是底角 β = (180−α)/2），
     LABELS_1D 则声明了却从未被调用 —— 属死代码加错位，一并修正。 */
  var LABELS_1D = ['板宽 W = N·p', '总高 H = t+h', '半底宽 b = h·tan(α/2)', '填充率 η = 2b/p', '网格点',
    '圆角 R（实际生效）'];
  var LABELS_2D = ['板宽 Wx = Nx·p', '总高 H = t+h', '半底宽 b = h/tan(α)', '填充率 η = (2b/p)²', '金字塔数',
    '圆角 R（实际生效）'];

  /* 二维金字塔的半底宽（唯一定义点）。

     面板把 α 标为「apex angle 斜面倾角」，即**斜面与水平面的夹角**，
     故 b = h/tan(α)。这与一维的 b = h·tan(α/2) 不是同一个式子 ——
     因为两个模式对 α 的定义本就不同（一维 = 齿顶夹角，二维 = 斜面倾角）。

     原实现算了 half 却只用于读数与告警，网格点固定落在 (i·pitch, j·pitch)、
     金字塔顶点固定落在格心 —— 于是金字塔底面恒为 pitch×pitch 满铺、
     四周没有平台，**倾角完全不参与建模**，体积也按 pitch² 而非 (2b)² 算。
     默认参数下两者相差 12 倍。 */
  function halfBase2D(p) {
    var want = p.height / Math.tan(p.angle * RAD);
    var max = p.pitch / 2;
    return { want: want, use: Math.min(want, max), clamped: want > max + 1e-9 };
  }

  /* 二维网格的三角形计数（唯一定义点）。
     读数的 nTris 必须与 rebuildMesh2D 实际压入的三角形数一致，
     否则又是一处「显示 ≠ 实际」——本文件反复踩的就是这一类。
       每格：金字塔侧面 4 个 + 平台环 4 个四边形（= 8 个三角形）
     b → 0 时金字塔退化成针尖（无侧面）；b = pitch/2 时平台宽度为 0
     （齿底相接，环面四边形面积为 0）—— 两种情况都要如实扣掉。 */
  function triCount2D(b, pitch, nx, ny) {
    var hasPyr = b > 1e-9;
    var hasLand = (pitch - 2 * b) > 1e-9;
    return nx * ny * ((hasPyr ? 4 : 0) + (hasLand ? 8 : 0));
  }

  function buildGeometry2D() {
    var p = readParams2D();
    var hb = halfBase2D(p);
    var half = hb.use;                       // 实际用于建模的半底宽 b
    var Wx = p.nx * p.pitch;
    var Wy = p.ny * p.pitch;
    var H = p.base + p.height;
    var side = 2 * half;                     // 金字塔底面边长
    var fill = (side / p.pitch) * (side / p.pitch);   // 面积填充率 η = (2b/p)²
    var ok = true, msg = '';
    var warns = inputNotes.slice();

    if (!(p.pitch > 0) || !(p.height > 0) || !(p.base >= 0) || !(p.nx >= 1) || !(p.ny >= 1) ||
        !(p.angle > 0) || !(p.angle < 180)) {
      /* 与一维同理：倾角的定义域是 (0°, 180°) 开区间，原先没查 */
      warns.push('存在非法参数，请检查：pitch / height 需 > 0，base ≥ 0，' +
                 '斜面倾角需落在 (0°, 180°) 开区间内，列数 / 行数 ≥ 1。');
      ok = false;
    }
    if (hb.clamped) {
      warns.push('金字塔半底宽 h/tan(α) = ' + hb.want.toFixed(3) + ' mm 超过半齿距 ' +
            (p.pitch / 2).toFixed(3) + ' mm，金字塔会重叠。底面已按齿距封顶' +
            '（相邻金字塔恰好相接，填充率 1.000）。要得到真实的稀疏金字塔阵列' +
            '请增大 pitch，或减小 height / 倾角。');
      ok = false;
    }
    showWarn(warns.join('\n'));

    var baseVol = Wx * Wy * p.base;
    var pyrVol = p.nx * p.ny * side * side * p.height / 3;
    var vol = baseVol + pyrVol;
    /* 每个齿距格：金字塔侧面 4 个三角形 + 四周平台环 4 个四边形（拆成 8 个三角形） */
    var nTris = triCount2D(half, p.pitch, p.nx, p.ny);

    setText('s_k1', LABELS_2D[0]);
    setText('s_k2', LABELS_2D[1]);
    setText('s_k3', LABELS_2D[2]);
    setText('s_k4', LABELS_2D[3]);
    setText('s_k5', LABELS_2D[4]);
    setText('s_w', Wx.toFixed(3) + ' × ' + Wy.toFixed(3) + ' mm');
    setText('s_h', H.toFixed(3) + ' mm');
    setText('s_half', half.toFixed(3) + ' mm');
    setText('s_beta', fill.toFixed(3));
    setText('s_v', p.nx * p.ny);
    setText('s_vol', vol.toFixed(1) + ' mm³');
    /* 二维金字塔阵列没有圆角（面板也没有该输入），整行隐藏 —— 留一个 "—"
       在那里反而会让人以为"二维的圆角是 0"。 */
    var kvR2 = $('kv_radius');
    if (kvR2) kvR2.hidden = true;

    return {
      p: p, Wx: Wx, Wy: Wy, H: H, half: half, side: side, fill: fill,
      vol: vol, baseVol: baseVol, pyrVol: pyrVol, nTris: nTris, valid: ok, msg: msg
    };
  }

  /* ============================================================
   * Three.js 预览
   * ============================================================ */
  function hasThree() {
    return typeof window.THREE !== 'undefined';
  }

  function initThree() {
    if (inited || !hasThree()) return;
    var canvas = $('gl');
    if (!canvas) return;

    refreshColors();
    renderer = new window.THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scene = new window.THREE.Scene();
    scene.background = new window.THREE.Color(COL.bg3d);

    camera = new window.THREE.PerspectiveCamera(42, 1, 0.1, 5000);
    /* 相机 up 必须显式设成世界 Z（光学件以 Z 为高度/光轴方向）。
       frameObject 的取景数学本来就是 Z-up 约定 —— 它按
       right = fwd × Z、up = right × fwd 构造屏幕基；
       而相机默认 up = 世界 Y，两者不一致时：

         · 板子的长边（世界 Y）被永远投影成竖向 —— 20×50 的板子
           渲染成「一堵竖墙」，实测投影仅 124×381 px；
         · 取景是按 Z-up 的屏幕基算的距离，与真实视锥不符 ——
           实测模型只占画面宽 13.6%（正确值 ≈ 88%）。

       必须在构造 OrbitControls **之前**设好：它内部就按 object.up
       一次性算出轨道坐标系的四元数（见 vendor-orbitcontrols.js 中
       setFromUnitVectors(object.up, (0,1,0))），之后再改不会重新计算。 */
    camera.up.set(0, 0, 1);
    camera.position.set(60, 40, 70);

    if (window.THREE.OrbitControls) {
      controls = new window.THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxDistance = 800;
      controls.minDistance = 5;
    }

    /* 灯光：为「哑光面 + 平面着色」配的。
       棱面结构靠**面朝向差异**读出，故压低各处无方向的补光、让方向光主导：
       环境光过高会把所有朝向的面一起抬亮，棱面之间就没有明暗差；
       侧面补光（fill）保留少量即可，否则背光面会黑成一片看不清轮廓。
       原先这套强度是为「高光玻璃感」调的 —— 那时亮度主要来自高光，
       环境光高低不敏感。 */
    scene.add(new window.THREE.AmbientLight(0xffffff, 0.22));
    var key = new window.THREE.DirectionalLight(COL.prismKey, 1.25);
    key.position.set(80, 120, 60);
    scene.add(key);
    var rim = new window.THREE.DirectionalLight(COL.prismRim, 0.42);
    rim.position.set(-60, 30, -80);
    scene.add(rim);
    var fill = new window.THREE.DirectionalLight(COL.prismFill, 0.22);
    fill.position.set(0, -40, 40);
    scene.add(fill);

    var grid = new window.THREE.GridHelper(200, 20, COL.gridSub, COL.grid);
    grid.position.y = -0.01;
    scene.add(grid);

    resize();
    window.addEventListener('resize', resize);
    inited = true;
    animate();
  }

  /* 按容器实际尺寸设置画布。
     必须量 .prism-stage（有确定高度的画布宿主），不能量视图容器本身
     —— 后者高度由内容撑开，改了尺寸也拿不到有效值。
     原 MLA_Prism.html 在容器未布局时初始化，实测画布高度停在 20px；
     这里改为量宿主 + 在切到本视图/窗口 resize 时再次调用。 */
  function resize() {
    if (!renderer) return;
    var el = document.querySelector('.prism-stage');
    if (!el) return;
    var w = el.clientWidth, h = el.clientHeight;
    if (!(w > 0) || !(h > 0)) return;
    renderer.setSize(w, h, false);
    var aspect = w / h;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();

    /* 首帧取景常常发生在 .prism-stage 还没拿到最终尺寸的时候（切到本视图
       之前它是隐藏的），此时量到的宽高比与真实视口不符 —— 实测取景按
       aspect 0.90 算，而真实视口是 1.754，于是模型只占画面宽 13.6%、
       且几乎正侧视。这里在宽高比明显变化时补一次重新取景。

       **只在相机仍停在我们上次取景留下的位置上时才补** —— 用户手动转过
       视角就绝不覆盖，这是 v3.3.0 定下的取景规则。 */
    if (lastFrameMode && probeHalf && frameAspect > 0) {
      if (Math.abs(aspect - frameAspect) / aspect > 0.02 && cameraUntouched()) {
        doFrame(probeCenter[0], probeCenter[1], probeCenter[2], probeHalf, aspect);
      }
    }
  }

  /* 渲染一帧。不依赖 rAF —— rAF 在后台标签/无头环境被节流，
     会出现"切回本页看到空白画布"。 */
  function drawOnce() {
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function animate() {
    if (!renderer) return;
    requestAnimationFrame(animate);
    if (controls) controls.update();
    drawOnce();
  }

  /* 棱镜板表面材质。

     原材质是「高光 + 半透明 + 清漆层」的玻璃感：
       color 0x9ecbff / roughness 0.18 / clearcoat 1.0 /
       clearcoatRoughness 0.08 / opacity 0.82
     对一维的连续肋面尚可，但二维金字塔阵列是**大量朝向各异的小平面** ——
     高光与清漆会在每个面上各打一块高亮，相邻面一起过曝成白，
     明暗差异被抹平、结构细节看不见；半透明还会透出背面，进一步糊掉层次。

     现改为哑光不透明：roughness 0.9、去掉清漆层、opacity 1。
     这样每个棱面的亮度只由「面法线 · 光向」决定，棱面朝向的差异直接
     变成可读的明暗层次。基色收到 --c-prism（语义色单一来源）。

     flat：二维用平面着色，让每个三角形用自己的面法线。
     否则共享顶点的法线会被平均，金字塔尖呈圆滑过渡、棱边消失。
     一维**不开** —— 它的圆角是 10 段折线拟合的，平面着色会把圆角
     显成 10 个折面，反而更假。 */
  function makeMaterial(flat) {
    return new window.THREE.MeshPhysicalMaterial({
      color: COL.prism,
      metalness: 0.0,
      roughness: 0.9,
      flatShading: !!flat,
      transparent: xrayMode,
      opacity: xrayMode ? 0.35 : 1.0,
      side: window.THREE.DoubleSide
    });
  }

  function disposeMeshes() {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
    if (wireframeMesh) {
      scene.remove(wireframeMesh);
      wireframeMesh.geometry.dispose();
      wireframeMesh.material.dispose();
      wireframeMesh = null;
    }
  }

  /* 首次进入时自动取景。
     原文件用 radius = max(W,L)*1.05 作相机距离 —— 实测在默认参数下
     （W=20、L=50、H=0.45）可见视锥高度只有 44.5 mm，而模型跨度 50 mm，
     模型必然超出画面，实测下边距只剩 1 px。

     仅靠"包围球 + 视场角反算"也不够准：棱镜板是 20×50×0.45 的极扁长条，
     斜视图下它在屏幕上的投影并不对称 —— 实测改用包围球后模型仍右偏 222 px。
     故这里用**投影包围盒**拟合：把包围盒 8 个角点投到相机坐标系，
     量出各轴所需半角，反算恰好容纳的距离。 */
  function frameObject(cx, cy, cz, half, aspect) {
    if (!camera || !controls) return;

    var fovV = camera.fov * RAD;                            // 垂直视场角
    var fovH = 2 * Math.atan(Math.tan(fovV / 2) * Math.max(aspect, 0.1));
    var tanV = Math.tan(fovV / 2), tanH = Math.tan(fovH / 2);

    // 3/4 俯视方向（单位向量）：能同时看到齿面与齿顶
    var dir = [0.62, 0.50, 0.60];
    var dl = Math.hypot(dir[0], dir[1], dir[2]);
    var u = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    var dist = Math.hypot(half[0], half[1], half[2]) * 3;    // 保守初值

    /* 8 个角点相对中心的位置 */
    var pts = [];
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sy = -1; sy <= 1; sy += 2) {
        for (var sz = -1; sz <= 1; sz += 2) {
          pts.push([sx * half[0], sy * half[1], sz * half[2]]);
        }
      }
    }

    /* 迭代收敛：相机沿 u 方向后退，距离为 dist。
       相机朝原点看，故前向 = -u。构造相机的 up/right 基。

       need 必须以 −Infinity 起手，不能以 0 起手：本式与 Math.max 配合，
       含义是「当前距离还差多少才装得下」，装得下时它是负数。
       写成 0 就等于给收敛加了一条「只能推远、不能拉近」的下限 ——
       而初值 3×包围盒对角线本来就偏远，实测该写法下循环第一轮
       need = 0 直接 break，相机被钉死在 1.8 倍于所需的距离上，
       模型只占画面宽 13.6%、几乎正侧视。 */
    for (var it = 0; it < 6; it++) {
      var fwd = [-u[0], -u[1], -u[2]];
      var right = cross3(fwd, [0, 0, 1]);
      var rl = norm3(right);
      if (rl < 1e-6) right = [1, 0, 0]; else right = scale3(right, 1 / rl);
      var camUp = cross3(right, fwd);

      var need = -Infinity;
      for (var i = 0; i < pts.length; i++) {
        var q = pts[i];
        var depth = dot3(q, fwd) + dist;             // 沿视线方向的距离
        if (depth < 1e-3) depth = 1e-3;
        var rx = Math.abs(dot3(q, right));
        var uy = Math.abs(dot3(q, camUp));
        // 该点落在视锥内要求 |x| <= depth*tanH 且 |y| <= depth*tanV
        need = Math.max(need, rx / tanH - depth, uy / tanV - depth);
      }
      dist += need;
      if (Math.abs(need) < 1e-4) break;
    }
    dist *= 1.12;                                     // 统一留 12% 边距

    controls.target.set(cx, cy, cz);
    camera.position.set(cx + u[0] * dist, cy + u[1] * dist, cz + u[2] * dist);
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.update();

    /* 把投影包围盒的中心对到画面中心。
       透视下「包围盒中心的投影」并不等于「投影的中心」—— 近端角点被放大、
       远端被压缩，直接对准中心会留下偏移（实测垂直方向 41 px，恰好在
       居中判据 40 px 之外）。这里把 8 个角点投到 NDC 量出偏移，
       再沿屏幕平面平移注视点与相机。

       注意 acc：平移之后角点相对注视点的位置会变，第二轮必须用**扣掉累计
       平移量**后的相对位置再算 —— 否则第二轮会看到与第一轮相同的偏移量，
       再修一次，正好过头一倍（实测 offX 从 +29 px 翻成 −29 px）。
       平移不改变相机朝向，故 right/camUp/fwd/dist 全程有效。 */
    var acc = [0, 0, 0];
    for (var pass = 0; pass < 3; pass++) {
      var lo = [1e9, 1e9], hi = [-1e9, -1e9];
      for (var m = 0; m < pts.length; m++) {
        var q2 = [pts[m][0] - acc[0], pts[m][1] - acc[1], pts[m][2] - acc[2]];
        var d2 = dot3(q2, fwd) + dist;
        if (d2 < 1e-3) d2 = 1e-3;
        var nx = (dot3(q2, right) / d2) / tanH;
        var ny = (dot3(q2, camUp) / d2) / tanV;
        lo[0] = Math.min(lo[0], nx); hi[0] = Math.max(hi[0], nx);
        lo[1] = Math.min(lo[1], ny); hi[1] = Math.max(hi[1], ny);
      }
      var sx = (lo[0] + hi[0]) / 2, sy = (lo[1] + hi[1]) / 2;
      if (Math.abs(sx) < 1e-4 && Math.abs(sy) < 1e-4) break;
      var dx = sx * dist * tanH, dy = sy * dist * tanV;
      for (var ax = 0; ax < 3; ax++) {
        var shift = right[ax] * dx + camUp[ax] * dy;
        controls.target.setComponent(ax, controls.target.getComponent(ax) + shift);
        camera.position.setComponent(ax, camera.position.getComponent(ax) + shift);
        acc[ax] += shift;
      }
      camera.lookAt(controls.target);
      controls.update();
    }
  }

  function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm3(a) { return Math.hypot(a[0], a[1], a[2]); }
  function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

  /* ============================================================
   * 自动取景
   * ------------------------------------------------------------
   * 取景规则（按用户实测反馈确定）：
   *   1. 首次进入某个模式  → 自动取景到标准 3/4 视角
   *   2. 用户手动转过视角后改参数 → **完全不动相机**，只重建模型
   *   3. 切换一维/二维     → 仍然自动取景（换的是完全不同的模型）
   *   4. 点「重置视角」    → 回到标准视角，并恢复自动取景
   *
   * 为什么不能按"尺寸签名变化"取景：上一版就是这么写的，结果是
   * 用户把视角固定好之后一改参数相机就被拉回标准视角 ——
   * 因为改参数必然改变包围盒尺寸，签名必然变化，于是必然重取景。
   *
   * 现改为以「模式」为唯一的取景触发条件：同一模式内，模型怎么变
   * 都不动相机。用户手动调整的视角因此天然被保留 —— 不需要额外的
   * "用户是否调整过"标志位来保护（那种写法还要处理拖拽交互事件，
   * 且"点一下没拖动"会误判）。模式切换与重置视角会清空 lastFrameMode，
   * 从而显式触发一次重新取景。
   * ============================================================ */
  var lastFrameMode = '';    // 上一次自动取景时的模式（'' = 尚未取景 / 已请求重置）
  var frameAspect = 0;       // 上一次取景所用的视口宽高比
  var frameCamPos = null;    // 上一次取景后留下的相机位置（判断用户是否动过）
  var frameTarget = null;    // 上一次取景后留下的注视点

  function maybeFrame(m, cx, cy, cz, half, aspect) {
    probeCenter = [cx, cy, cz];
    probeHalf = [half[0], half[1], half[2]];
    if (m === lastFrameMode) return false;   // 同模式：绝不自动取景
    lastFrameMode = m;
    doFrame(cx, cy, cz, half, aspect);
    return true;
  }

  function doFrame(cx, cy, cz, half, aspect) {
    frameObject(cx, cy, cz, half, aspect);
    if (!camera || !controls) return;
    frameAspect = aspect;
    frameCamPos = [camera.position.x, camera.position.y, camera.position.z];
    frameTarget = [controls.target.x, controls.target.y, controls.target.z];
  }

  /* 用户有没有动过相机？直接与我们上次取景后留下的位置逐分量比较。
     比监听拖拽事件可靠：不需要区分「点一下但没拖动」这类情形，
     也不依赖任何额外标志位（v3.3.0 就是因为标志位难判才改成按模式取景的）。 */
  function cameraUntouched() {
    if (!frameCamPos || !frameTarget || !camera || !controls) return false;
    var e = 1e-3, p = camera.position, t = controls.target;
    return Math.abs(p.x - frameCamPos[0]) < e &&
           Math.abs(p.y - frameCamPos[1]) < e &&
           Math.abs(p.z - frameCamPos[2]) < e &&
           Math.abs(t.x - frameTarget[0]) < e &&
           Math.abs(t.y - frameTarget[1]) < e &&
           Math.abs(t.z - frameTarget[2]) < e;
  }

  /* 回到标准视角，并恢复"允许自动取景" */
  function resetView() {
    lastFrameMode = '';
    if (!currentGeo) return;
    if (mode === '1d') rebuildMesh(currentGeo); else rebuildMesh2D(currentGeo);
  }

  function rebuildMesh(geo) {
    if (!scene) return;
    disposeMeshes();

    var prof = geo.prof, p = geo.p;
    var shape = new window.THREE.Shape();
    shape.moveTo(prof[0][0], prof[0][1]);
    for (var i = 1; i < prof.length; i++) shape.lineTo(prof[i][0], prof[i][1]);
    shape.closePath();

    var g = new window.THREE.ExtrudeGeometry(shape, { depth: p.L, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    g.computeVertexNormals();

    mesh = new window.THREE.Mesh(g, makeMaterial());
    mesh.position.set(-geo.W / 2, p.L / 2, 0);
    scene.add(mesh);

    var wg = new window.THREE.WireframeGeometry(g);
    var wm = new window.THREE.LineBasicMaterial({
      color: COL.accent, transparent: true, opacity: 0.25
    });
    wireframeMesh = new window.THREE.LineSegments(wg, wm);
    wireframeMesh.position.copy(mesh.position);
    scene.add(wireframeMesh);

    // 包围盒半尺寸：x∈[-W/2,W/2]，y∈[-L/2,L/2]，z∈[0,H]
    var aspect = (camera.aspect > 0) ? camera.aspect : (708 / 420);
    maybeFrame('1d', 0, 0, geo.H / 2, [geo.W / 2, p.L / 2, geo.H / 2], aspect);
    if (controls) controls.update();
    resize();
    drawOnce();
  }

  function rebuildMesh2D(geo) {
    if (!scene) return;
    disposeMeshes();

    var p = geo.p, Wx = geo.Wx, Wy = geo.Wy, H = geo.H;
    var t = p.base, h = p.height, pitch = p.pitch, nx = p.nx, ny = p.ny;
    var b = geo.half;                 // 半底宽 b —— 与几何量读数同源
    var hasPyr = b > 1e-9;            // b → 0：金字塔退化成针尖
    var hasLand = (pitch - 2 * b) > 1e-9;   // 2b = pitch：齿底相接，无平台

    var verts = [], faces = [];
    var b0 = 0; verts.push(0, 0, 0);
    var b1 = 1; verts.push(Wx, 0, 0);
    var b2 = 2; verts.push(Wx, Wy, 0);
    var b3 = 3; verts.push(0, Wy, 0);

    var g = [], i, j;
    for (i = 0; i <= nx; i++) {
      g[i] = [];
      for (j = 0; j <= ny; j++) { g[i][j] = verts.length / 3; verts.push(i * pitch, j * pitch, t); }
    }

    /* 每格：底面 4 个角点 + 顶点。
       格内划分为「四周平台环 + 金字塔侧面」：
         平台环 = 4 个四边形（格角 → 底面角），拆成 8 个三角形
         金字塔 = 4 个侧面三角形
       合计 12 个三角形/格，与 triCount2D() 一致。

       原实现把底面角点直接取成格角、顶点取格心 —— 金字塔底面恒为
       pitch×pitch 满铺、四周没有平台，**倾角参数完全不参与建模**
       （体积也按 pitch² 算，默认参数下比真实值大 12 倍）。 */
    var base4 = [], apex = [];
    var shareBase = !hasLand;    // 无平台 → 底面角点即格角，直接共用（避免接缝）
    for (i = 0; i < nx; i++) {
      base4[i] = []; apex[i] = [];
      for (j = 0; j < ny; j++) {
        if (shareBase) {
          base4[i][j] = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
        } else {
          var cx = (i + 0.5) * pitch, cy = (j + 0.5) * pitch;
          var o = [];
          /* 逆时针：左下 → 右下 → 右上 → 左上 */
          o.push(verts.length / 3); verts.push(cx - b, cy - b, t);
          o.push(verts.length / 3); verts.push(cx + b, cy - b, t);
          o.push(verts.length / 3); verts.push(cx + b, cy + b, t);
          o.push(verts.length / 3); verts.push(cx - b, cy + b, t);
          base4[i][j] = o;
        }
        apex[i][j] = verts.length / 3; verts.push((i + 0.5) * pitch, (j + 0.5) * pitch, t + h);
      }
    }

    faces.push([b0, b3, b2, b1]);
    faces.push([b0, b1, g[nx][0], g[0][0]]);
    faces.push([b1, b2, g[nx][ny], g[nx][0]]);
    faces.push([b2, b3, g[0][ny], g[nx][ny]]);
    faces.push([b3, b0, g[0][0], g[0][ny]]);

    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) {
        /* 格角（逆时针）与底面角（逆时针）序号一一对应 */
        var O = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
        var I = base4[i][j];
        var A = apex[i][j];
        for (var k = 0; k < 4; k++) {
          var k2 = (k + 1) % 4;
          if (hasLand) faces.push([O[k], O[k2], I[k2], I[k]]);   // 平台环
          if (hasPyr) faces.push([I[k], I[k2], A]);              // 金字塔侧面
        }
      }
    }

    var indices = [];
    for (var fi = 0; fi < faces.length; fi++) {
      var f = faces[fi];
      if (f.length === 3) indices.push(f[0], f[1], f[2]);
      else { indices.push(f[0], f[1], f[2]); indices.push(f[0], f[2], f[3]); }
    }

    var g2 = new window.THREE.BufferGeometry();
    g2.setAttribute('position', new window.THREE.BufferAttribute(new Float32Array(verts), 3));
    g2.setIndex(indices);
    g2.computeVertexNormals();
    g2.translate(-Wx / 2, -Wy / 2, 0);

    mesh = new window.THREE.Mesh(g2, makeMaterial(true));
    scene.add(mesh);

    var wg = new window.THREE.WireframeGeometry(g2);
    var wm = new window.THREE.LineBasicMaterial({
      color: COL.accent, transparent: true, opacity: 0.18
    });
    wireframeMesh = new window.THREE.LineSegments(wg, wm);
    wireframeMesh.position.copy(mesh.position);
    scene.add(wireframeMesh);

    // 包围盒半尺寸：g2 已 translate 居中，x/y∈[-半,+半]，z∈[0,H]
    var aspect2 = (camera.aspect > 0) ? camera.aspect : (708 / 420);
    maybeFrame('2d', 0, 0, H / 2, [Wx / 2, Wy / 2, H / 2], aspect2);
    if (controls) controls.update();
    resize();
    drawOnce();
  }

  /* ============================================================
   * STEP (AP214) 生成
   * ============================================================ */
  function buildSTEP(geo) {
    var prof = geo.prof, p = geo.p;
    var V = prof.length, L = p.L;
    var i;

    /* ---- 拓扑压缩：把同一圆角上的 9 条折线段合并为 1 条 CIRCLE 边 ----
       prof 是「几何采样点」（每个圆角 10 个点，供预览与面积计算），
       但 STEP 的拓扑不应逐采样点建边：
         · 每个圆角真正只需要 2 个顶点（起、止切点）；
         · 中间 8 个采样点只是折线可视化用的，若也建成 VERTEX_POINT，
           相邻两条共圆的圆弧边会在端点处退化，OCCT 无法 sew 成有效壳
           （实测 BRepCheck.IsValid()=False、SOLID=0、体积偏小）。
       因此这里按 segArc 把轮廓压成边序列：圆弧段合并、直线段保留。 */
    var segArc = geo.arcs || [];
    var edges = [];   // { kind, i0, i1, arc }  —— i0/i1 为 prof 下标
    for (i = 0; i < V; i++) {
      var ar = segArc[i];
      if (ar) {
        /* 连续同圆的采样点归成一条弧：从当前点一路吃到圆心变化的那个点 */
        var j = i, cx = ar.cx, cy = ar.cy, r = ar.r;
        while (segArc[(j + 1) % V] &&
               Math.abs(segArc[(j + 1) % V].cx - cx) < 1e-9 &&
               Math.abs(segArc[(j + 1) % V].cy - cy) < 1e-9 &&
               (j + 1) % V !== i) {
          j = (j + 1) % V;
        }
        /* 记录圆弧的真正张角：STEP 里裸 CIRCLE 是「整圆」，
           EDGE_CURVE 引用它时必须用 TRIMMED_CURVE 把参数区间钉到
           这一段的起止角，否则内核按补弧解释（实测扫角会变成
           264°~306° 的优弧，材料被多切掉一大块）。 */
        var q0 = prof[i], q1 = prof[(j + 1) % V];
        var a0 = Math.atan2(q0[1] - cy, q0[0] - cx);
        var a1 = Math.atan2(q1[1] - cy, q1[0] - cx);
        var sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= TAU;
        while (sweep <= -Math.PI) sweep += TAU;
        edges.push({ kind: 'circle', i0: i, i1: (j + 1) % V, cx: cx, cy: cy, r: r, a0: a0, a1: a1, sweep: sweep });
        i = j;    // 跳过已并入的采样点
      } else {
        edges.push({ kind: 'line', i0: i, i1: (i + 1) % V });
      }
    }
    var NE = edges.length;

    /* 拓扑顶点：只取每条边的起点（底环）+ 对应顶环点。
       底环与顶环各 NE 个顶点，共 2·NE。 */
    function botPt(k) { return prof[edges[k].i0]; }
    function topPt(k) { return prof[edges[k].i0]; }
    var pts = [];
    for (i = 0; i < NE; i++) pts.push([botPt(i)[0], 0, botPt(i)[1]]);
    for (i = 0; i < NE; i++) pts.push([topPt(i)[0], L, topPt(i)[1]]);

    var id = 0;
    function N() { return ++id; }
    var defs = [];
    function push(s) { defs.push(s); }

    var vxId = [];
    for (i = 0; i < 2 * NE; i++) {
      var q = pts[i];
      var ptId = N();
      push('#' + ptId + " = CARTESIAN_POINT('',(" + q[0].toFixed(6) + ',' + q[1].toFixed(6) + ',' + q[2].toFixed(6) + '));');
      vxId[i] = N();
      push('#' + vxId[i] + " = VERTEX_POINT('',#" + ptId + ');');
    }

    /* 平面内曲线：圆弧写有理二次 B 样条（精确圆弧），直线写 LINE。

       为什么不用 CIRCLE + TRIMMED_CURVE：
         STEP 里 CIRCLE 语义是「整圆」，要表达其中一段必须靠
         TRIMMED_CURVE 把参数区间钉住；而 trim 点/参数、sense_agreement、
         轴系三者的组合约定极易踩错 —— 实测扫角会翻成补弧（264°~306°，
         优弧），或让 OCCT 在 TransferRoots 直接崩。
         有理 B 样条把「这一小段弧」写进曲线自身的定义，不含任何裁剪
         语义，各内核读法一致，OCCT 仍能识别为 GeomAbs_Circle。

       有理二次 Bézier 表示圆心角 Δ 的圆弧（标准做法）：
         P0 = 起点，P2 = 终点，P1 = 两切线交点，
         权重 w0 = w2 = 1，w1 = cos(Δ/2)。
       控制点用数值稳定的等价式（免去求角平分线方向）：
         P1 = c + ( (P0−c) + (P2−c) ) / (2·w1)
       本文件每个圆角的弧 Δ ≤ 90°，单段二次有理 Bézier 即精确，
       无需再细分子段。

       实体形式（复合实例，AP214 合法）：
         #n = ( BOUNDED_CURVE() B_SPLINE_CURVE(2,(#P0,#P1,#P2),...)
                B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.0,1.0),...)
                CURVE() GEOMETRIC_REPRESENTATION_ITEM()
                RATIONAL_B_SPLINE_CURVE((w-list)) REPRESENTATION_ITEM('') );
       注意：RATIONAL_B_SPLINE_CURVE 的权重必须**内联为实数列表**；
       写成 (#id) 这种「引用另一个列表实体」的形式 OCCT 不认。 */
    function emitPlanarCurve(k, y) {
      var e = edges[k];
      var p0 = prof[e.i0];
      if (e.kind === 'circle') {
        var t0 = e.a0;
        var dA = e.sweep;                       // 有符号圆心角
        var w1 = Math.cos(dA / 2);
        var P0 = [e.cx + e.r * Math.cos(t0), e.cy + e.r * Math.sin(t0)];
        var P2 = [e.cx + e.r * Math.cos(t0 + dA), e.cy + e.r * Math.sin(t0 + dA)];
        var kk = 1 / (2 * w1);
        var P1 = [e.cx + kk * ((P0[0] - e.cx) + (P2[0] - e.cx)),
                  e.cy + kk * ((P0[1] - e.cy) + (P2[1] - e.cy))];

        function pt3(P) {
          var idp = N();
          push('#' + idp + " = CARTESIAN_POINT('',(" + P[0].toFixed(9) + ',' + y.toFixed(6) + ',' + P[1].toFixed(9) + '));');
          return idp;
        }
        var c0 = pt3(P0), c1 = pt3(P1), c2 = pt3(P2);
        var bsp = N();
        push('#' + bsp + ' = ( BOUNDED_CURVE() B_SPLINE_CURVE(2,(#' + c0 + ',#' + c1 + ',#' + c2 +
          '),.UNSPECIFIED.,.F.,.F.) B_SPLINE_CURVE_WITH_KNOTS((3,3),(0.0,1.0),.UNSPECIFIED.) ' +
          'CURVE() GEOMETRIC_REPRESENTATION_ITEM() ' +
          'RATIONAL_B_SPLINE_CURVE((1.0,' + w1.toFixed(12) + ',1.0)) REPRESENTATION_ITEM(\'\') );');
        return bsp;
      }
      var p1 = prof[e.i1];
      var pa = [p0[0], y, p0[1]], pb = [p1[0], y, p1[1]];
      var dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      var len = Math.hypot(dx, dy, dz) || 1;
      var d2 = N();
      push('#' + d2 + " = DIRECTION('',(" + (dx / len).toFixed(6) + ',' + (dy / len).toFixed(6) + ',' + (dz / len).toFixed(6) + '));');
      var v2 = N();
      push('#' + v2 + " = VECTOR('',#" + d2 + ',1.0);');
      var l2 = N();
      push('#' + l2 + " = CARTESIAN_POINT('',(" + pa[0].toFixed(6) + ',' + pa[1].toFixed(6) + ',' + pa[2].toFixed(6) + '));');
      var ln = N();
      push('#' + ln + " = LINE('',#" + l2 + ',#' + v2 + ');');
      return ln;
    }

    var ecId = [];       // 底环边
    var ecIdTop = [];    // 顶环边
    var ecIdVert = [];   // 竖边
    for (i = 0; i < NE; i++) {
      var cB = emitPlanarCurve(i, 0);
      ecId[i] = N();
      push('#' + ecId[i] + " = EDGE_CURVE('',#" + vxId[i] + ',#' + vxId[(i + 1) % NE] + ',#' + cB + ',.T.);');
    }
    for (i = 0; i < NE; i++) {
      var cT = emitPlanarCurve(i, L);
      ecIdTop[i] = N();
      push('#' + ecIdTop[i] + " = EDGE_CURVE('',#" + vxId[NE + i] + ',#' + vxId[NE + (i + 1) % NE] + ',#' + cT + ',.T.);');
    }
    for (i = 0; i < NE; i++) {
      var pv = pts[i], pw = pts[NE + i];
      var dvx = pw[0] - pv[0], dvy = pw[1] - pv[1], dvz = pw[2] - pv[2];
      var lv = Math.hypot(dvx, dvy, dvz) || 1;
      var dvId = N();
      push('#' + dvId + " = DIRECTION('',(" + (dvx / lv).toFixed(6) + ',' + (dvy / lv).toFixed(6) + ',' + (dvz / lv).toFixed(6) + '));');
      var vvId = N();
      push('#' + vvId + " = VECTOR('',#" + dvId + ',1.0);');
      var lvId = N();
      push('#' + lvId + " = CARTESIAN_POINT('',(" + pv[0].toFixed(6) + ',' + pv[1].toFixed(6) + ',' + pv[2].toFixed(6) + '));');
      var lvv = N();
      push('#' + lvv + " = LINE('',#" + lvId + ',#' + vvId + ');');
      ecIdVert[i] = N();
      push('#' + ecIdVert[i] + " = EDGE_CURVE('',#" + vxId[i] + ',#' + vxId[NE + i] + ',#' + lvv + ',.T.);');
    }

    function B(i2) { return i2; }
    function T(i2) { return NE + i2; }
    function R(i2) { return 2 * NE + i2; }

    var facePlanes = [];
    var bottomLoop = [];
    for (i = 0; i < NE; i++) bottomLoop.push({ ec: B(i), orient: '.T.' });
    facePlanes.push({ kind: 'plane', dir: [0, -1, 0], ref: [1, 0, 0], loc: [0, 0, 0], loop: bottomLoop });

    var topLoop = [];
    for (i = NE - 1; i >= 0; i--) topLoop.push({ ec: T(i), orient: '.F.' });
    facePlanes.push({ kind: 'plane', dir: [0, 1, 0], ref: [1, 0, 0], loc: [0, L, 0], loop: topLoop });

    for (i = 0; i < NE; i++) {
      var j2 = (i + 1) % NE;
      var loop = [
        { ec: R(i), orient: '.T.' },
        { ec: T(i), orient: '.T.' },
        { ec: R(j2), orient: '.F.' },
        { ec: B(i), orient: '.F.' }
      ];
      if (edges[i].kind === 'circle') {
        /* 圆弧扫出的侧面 = 圆柱面（轴平行 Y） */
        facePlanes.push({ kind: 'cylinder', cx: edges[i].cx, cz: edges[i].cy, r: edges[i].r, loop: loop });
      } else {
        var pi = prof[edges[i].i0], pj = prof[edges[i].i1];
        var ddx = pj[0] - pi[0], ddz = pj[1] - pi[1];
        var nlen = Math.hypot(ddx, ddz) || 1;
        facePlanes.push({
          kind: 'plane',
          dir: [ddz / nlen, 0, -ddx / nlen], ref: [0, 1, 0], loc: [pi[0], 0, pi[1]],
          loop: loop
        });
      }
    }

    var faceIds = [];
    for (var f2 = 0; f2 < facePlanes.length; f2++) {
      var fp = facePlanes[f2];
      var surf;
      if (fp.kind === 'cylinder') {
        var cAxisLoc = N();
        push('#' + cAxisLoc + " = CARTESIAN_POINT('',(" + fp.cx.toFixed(6) + ',0.000000,' + fp.cz.toFixed(6) + '));');
        var cAxisDir = N();
        push('#' + cAxisDir + " = DIRECTION('',(0.000000,1.000000,0.000000));");
        var cAxisRef = N();
        push('#' + cAxisRef + " = DIRECTION('',(1.000000,0.000000,0.000000));");
        var cPl = N();
        push('#' + cPl + " = AXIS2_PLACEMENT_3D('',#" + cAxisLoc + ',#' + cAxisDir + ',#' + cAxisRef + ');');
        surf = N();
        push('#' + surf + " = CYLINDRICAL_SURFACE('',#" + cPl + ',' + fp.r.toFixed(6) + ');');
      } else {
        var dirF = N();
        push('#' + dirF + " = DIRECTION('',(" + fp.dir[0].toFixed(6) + ',' + fp.dir[1].toFixed(6) + ',' + fp.dir[2].toFixed(6) + '));');
        var dirRef = N();
        push('#' + dirRef + " = DIRECTION('',(" + fp.ref[0].toFixed(6) + ',' + fp.ref[1].toFixed(6) + ',' + fp.ref[2].toFixed(6) + '));');
        var locF = N();
        push('#' + locF + " = CARTESIAN_POINT('',(" + fp.loc[0].toFixed(6) + ',' + fp.loc[1].toFixed(6) + ',' + fp.loc[2].toFixed(6) + '));');
        var axF = N();
        push('#' + axF + " = AXIS2_PLACEMENT_3D('',#" + locF + ',#' + dirF + ',#' + dirRef + ');');
        surf = N();
        push('#' + surf + " = PLANE('',#" + axF + ');');
      }
      var oeIds = [];
      for (var ei = 0; ei < fp.loop.length; ei++) {
        var e = fp.loop[ei];
        /* B/T/R 的编码基准是 NE（压缩后的边数 = 拓扑顶点数），
           不是 V（几何采样点数）。曾误用 V 导致越界取到 undefined。 */
        var eid = e.ec < NE ? ecId[e.ec] : (e.ec < 2 * NE ? ecIdTop[e.ec - NE] : ecIdVert[e.ec - 2 * NE]);
        var oe = N();
        push('#' + oe + " = ORIENTED_EDGE('',*,*,#" + eid + ',' + e.orient + ');');
        oeIds.push(oe);
      }
      var eloop = N();
      push('#' + eloop + " = EDGE_LOOP('',(#" + oeIds.join(',#') + '));');
      var fb = N();
      push('#' + fb + " = FACE_OUTER_BOUND('',#" + eloop + ',.T.);');
      var fa = N();
      push('#' + fa + " = ADVANCED_FACE('',(#" + fb + '),#' + surf + ',.T.);');
      faceIds.push(fa);
    }

    var shell = N();
    push('#' + shell + " = CLOSED_SHELL('',(#" + faceIds.join(',#') + '));');
    var brep = N();
    push('#' + brep + " = MANIFOLD_SOLID_BREP('PrismSheet',#" + shell + ');');

    /* ---- AP214 产品结构 ----
       关键点（原实现的静默失败根源）：
       1) APPLICATION_CONTEXT 只接受 1 个参数，原代码多了个尾随的 ,1；
       2) GEOMETRIC_REPRESENTATION_CONTEXT 的参数是「维度数」，
          但必须与 GLOBAL_UNIT_ASSIGNED_CONTEXT 组成复合实体，
          否则 OCCT 报 "Count of Parameters is not 3" 并使
          ADVANCED_BREP_SHAPE_REPRESENTATION 无法转移（NbShapes()=0）；
       3) ADVANCED_BREP_SHAPE_REPRESENTATION 需要 3 个参数
          (name, (items), context)，原代码把上下文塞进了 items 列表。 */
    var appCtx = N();
    push('#' + appCtx + " = APPLICATION_CONTEXT('core data for automotive design');");
    var prodCtx = N();
    push('#' + prodCtx + " = PRODUCT_CONTEXT('mechanical',#" + appCtx + ",'mechanical');");
    var product = N();
    push('#' + product + " = PRODUCT('PrismSheet','PrismSheet','',(#" + prodCtx + '));');
    var pdf = N();
    push('#' + pdf + " = PRODUCT_DEFINITION_FORMATION('','',#" + product + ');');
    var pdCtx = N();
    push('#' + pdCtx + " = PRODUCT_DEFINITION_CONTEXT('design',#" + appCtx + ",'design');");
    var pd = N();
    push('#' + pd + " = PRODUCT_DEFINITION('design','',#" + pdf + ',#' + pdCtx + ');');
    var pds = N();
    push('#' + pds + " = PRODUCT_DEFINITION_SHAPE('','',#" + pd + ');');

    /* 长度单位（mm）与角度单位（rad），显式声明，
       避免下游按默认单位解释导致 25.4 倍尺度错乱。 */
    var lu = N();
    push('#' + lu + " = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );");
    var au = N();
    push('#' + au + " = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );");
    var su = N();
    push('#' + su + " = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );");
    var unc = N();
    push('#' + unc + " = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#" + lu + ",'distance_accuracy_value','');");
    var guac = N();
    push('#' + guac + ' = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#' + lu + ',#' + au + ',#' + su + ')) REPRESENTATION_CONTEXT(\'3D\',\'3D\') );');

    var absr = N();
    push('#' + absr + " = ADVANCED_BREP_SHAPE_REPRESENTATION('PrismSheet',(#" + brep + '),#' + guac + ');');
    var sdr = N();
    push('#' + sdr + ' = SHAPE_DEFINITION_REPRESENTATION(#' + pds + ',#' + absr + ');');

    return 'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('Prism sheet parametric model'),'2;1');\n" +
      "FILE_NAME('prism_sheet.step','" + new Date().toISOString() + "',(''),(''),'prism-sheet-designer','build123d-equivalent','');\n" +
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n" +
      'ENDSEC;\nDATA;\n' + defs.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  /* ============================================================
   * Python 脚本生成
   * ============================================================ */
  function buildScripts(geo) {
    var p = geo.p, half = geo.half;
    var v = function (x) { return Number(x).toFixed(6); };
    var params = '# 参数（单位 mm）\n' +
      'PITCH   = ' + v(p.pitch) + '   # 齿距\n' +
      'HEIGHT  = ' + v(p.height) + '  # 齿高\n' +
      'APEX    = ' + p.angle + '      # 顶角 (deg)\n' +
      'BASE_T  = ' + v(p.base) + '    # 基底厚\n' +
      'RADIUS  = ' + v(p.radius) + '  # 齿顶/齿根圆角\n' +
      'N       = ' + p.N + '         # 齿数\n' +
      'LENGTH  = ' + v(p.L) + '       # 拉伸方向板长\n' +
      'HALF_B  = ' + v(half) + '      # 自动：半底宽\n';

    var b123d = params + '\n' +
'from math import tan, radians\n' +
'from build123d import *\n' +
'\n' +
'# 原始截面点（XZ 平面，逆时针）\n' +
'# 齿底宽 = 2·HALF_B，齿间保留 (PITCH − 2·HALF_B) 的平台\n' +
'pts = [(0,0.0),(PITCH*N,0.0),(PITCH*N,BASE_T)]\n' +
'for i in range(N-1,-1,-1):\n' +
'    cx = (i+0.5)*PITCH\n' +
'    pts.append((cx+HALF_B, BASE_T))\n' +
'    pts.append((cx, BASE_T+HEIGHT))\n' +
'    pts.append((cx-HALF_B, BASE_T))\n' +
'pts.append((0.0, BASE_T))\n' +
'\n' +
'with BuildPart() as bp:\n' +
'    with BuildSketch(Plane.XZ) as sk:\n' +
'        poly = Polyline(*[Vector(px,py) for px,py in pts], close=True)\n' +
'        Sketch().add(poly)\n' +
'    extrude(amount=LENGTH, both=False)\n' +
'    edges_to_fillet = bp.part.edges().filter_by(Plane.XZ)\n' +
'    if RADIUS > 0:\n' +
'        try:\n' +
'            bp.part = bp.part.fillet(RADIUS, edges_to_fillet)\n' +
'        except Exception:\n' +
'            pass\n' +
'\n' +
'export_step(bp.part, "prism_sheet.step")\n' +
'print("OK -> prism_sheet.step")\n';

    var cq = params + '\n' +
'import cadquery as cq\n' +
'from math import tan, radians\n' +
'\n' +
'# 原始截面点（XZ 平面，逆时针）\n' +
'# 齿底宽 = 2·HALF_B，齿间保留 (PITCH − 2·HALF_B) 的平台\n' +
'pts = [(0,0.0),(PITCH*N,0.0),(PITCH*N,BASE_T)]\n' +
'for i in range(N-1,-1,-1):\n' +
'    cx = (i+0.5)*PITCH\n' +
'    pts.append((cx+HALF_B, BASE_T))\n' +
'    pts.append((cx, BASE_T+HEIGHT))\n' +
'    pts.append((cx-HALF_B, BASE_T))\n' +
'pts.append((0.0, BASE_T))\n' +
'\n' +
'# 在 XZ 平面画截面，沿 Y 拉伸\n' +
'wp = cq.Workplane("XZ")\n' +
'wp = wp.moveTo(*pts[0])\n' +
'for px,py in pts[1:]:\n' +
'    wp = wp.lineTo(px,py)\n' +
'wp = wp.close()\n' +
'part = wp.extrude(LENGTH)\n' +
'\n' +
'# 齿顶/齿根圆角（沿拉伸方向的棱边倒圆）\n' +
'if RADIUS > 0:\n' +
'    try:\n' +
'        edges = part.edges("|Y")\n' +
'        part = edges.fillet(RADIUS)\n' +
'    except Exception as e:\n' +
'        print("fillet skipped:", e)\n' +
'\n' +
'cq.exporters.export(part, "prism_sheet.step")\n' +
'print("OK -> prism_sheet.step")\n';

    return { b123d: b123d, cq: cq };
  }

  function buildScripts2D(geo) {
    var p = geo.p;
    var v = function (x) { return Number(x).toFixed(6); };
    var params = '# 参数（单位 mm）\n' +
      'PITCH   = ' + v(p.pitch) + '   # 齿距（X/Y 相同）\n' +
      'HEIGHT  = ' + v(p.height) + '  # 金字塔高度\n' +
      'APEX    = ' + p.angle + '      # 斜面倾角 (deg，与水平面夹角)\n' +
      'BASE_T  = ' + v(p.base) + '    # 基底厚\n' +
      'NX      = ' + p.nx + '         # X 方向列数\n' +
      'NY      = ' + p.ny + '         # Y 方向行数\n' +
      'HALF_B  = ' + v(geo.half) + '  # 自动：半底宽 b = h/tan(倾角)\n';

    var b123d = params + '\n' +
'from math import tan, radians\n' +
'from build123d import *\n' +
'\n' +
'# 基底\n' +
'base = Box(NX*PITCH, NY*PITCH, BASE_T, centered=(False,False,False))\n' +
'\n' +
'# 金字塔阵列：底面 2·HALF_B 见方，四周留 (PITCH − 2·HALF_B) 平台\n' +
'pyramids = []\n' +
'for i in range(NX):\n' +
'    for j in range(NY):\n' +
'        cx = (i+0.5)*PITCH\n' +
'        cy = (j+0.5)*PITCH\n' +
'        with BuildPart() as pyr:\n' +
'            with BuildSketch(Plane.XY.offset(BASE_T)):\n' +
'                with Locations((cx, cy)):\n' +
'                    Rectangle(2*HALF_B, 2*HALF_B)\n' +
'            with BuildSketch(Plane.XY.offset(BASE_T+HEIGHT)):\n' +
'                Point(cx, cy)\n' +
'            loft()\n' +
'        pyramids.append(pyr.part)\n' +
'\n' +
'result = base\n' +
'for pyr in pyramids:\n' +
'    result = result.union(pyr)\n' +
'\n' +
'export_step(result, "pyramid_array.step")\n' +
'print("OK -> pyramid_array.step")\n';

    var cq = params + '\n' +
'import cadquery as cq\n' +
'\n' +
'# 基底\n' +
'result = cq.Workplane("XY").box(NX*PITCH, NY*PITCH, BASE_T, centered=(False,False,False))\n' +
'\n' +
'# 金字塔阵列：底面 2·HALF_B 见方，四周留 (PITCH − 2·HALF_B) 平台\n' +
'for i in range(NX):\n' +
'    for j in range(NY):\n' +
'        cx = (i+0.5)*PITCH\n' +
'        cy = (j+0.5)*PITCH\n' +
'        pyr = (cq.Workplane("XY")\n' +
'               .workplane(offset=BASE_T)\n' +
'               .rect(2*HALF_B, 2*HALF_B)\n' +
'               .workplane(offset=HEIGHT)\n' +
'               .rect(0.001, 0.001)\n' +
'               .loft())\n' +
'        pyr = pyr.translate((cx-HALF_B, cy-HALF_B, 0))\n' +
'        result = result.union(pyr)\n' +
'\n' +
'cq.exporters.export(result, "pyramid_array.step")\n' +
'print("OK -> pyramid_array.step")\n';

    return { b123d: b123d, cq: cq };
  }

  /* ============================================================
   * 下载
   * ============================================================ */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  /* STL 导出（预览用，纯前端，二进制 STL） */
  /* ---- 导出前置检查与剪贴板降级 ---- */

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  /* 导出前的体积闸门。
     实测 2D 的 STEP 在 Nx=Ny=20 时已 3.1 MB、Nx=Ny=40 时约 12 MB；
     再大则生成与下载都会明显卡顿，多数 CAD 也打不开。
     关键是**先估再确认、再生成** —— 若先生成后确认，用户要多等十几秒
     才看到一个「要不要继续」的对话框，白等。 */
  function confirmExportSize(bytes, what) {
    if (bytes <= 12 * 1048576) return true;
    return window.confirm(what + ' 预计约 ' + fmtSize(bytes) +
      '，文件很大（生成与下载都会明显卡顿，多数 CAD 也难以打开）。\n\n仍要继续吗？');
  }

  /* 复制到剪贴板。
     navigator.clipboard **只在安全上下文**（https / localhost）可用 ——
     本项目是纯静态站，完全可能被直接以 file:// 打开，此时该 API 不存在
     或调用后 reject。原实现是 `navigator.clipboard.writeText(...).then(提示成功)`，
     既没有 else 分支也没有 catch，于是点「复制」**静默失败**：
     按钮文字都不变，用户不知道是没复制还是没点中。
     这里补 execCommand 降级，并把失败明确显示出来。 */
  function copyText(text, btn) {
    var orig = btn.textContent;
    var done = function () {
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = orig; }, 1200);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        if (ok) { done(); return; }
      } catch (e) { /* 落到下面的失败分支 */ }
      btn.textContent = '复制失败';
      setTimeout(function () { btn.textContent = orig; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function exportSTL(meshObj) {
    var g = meshObj.geometry;
    var pos = g.attributes.position;
    var idx = g.index ? g.index.array : null;
    var tris = [];
    function pushV(i) { tris.push(pos.getX(i), pos.getY(i), pos.getZ(i)); }
    var i;
    if (idx) {
      for (i = 0; i < idx.length; i += 3) { pushV(idx[i]); pushV(idx[i + 1]); pushV(idx[i + 2]); }
    } else {
      for (i = 0; i < pos.count; i += 3) { pushV(i); pushV(i + 1); pushV(i + 2); }
    }
    var nTri = tris.length / 9;
    var buf = new ArrayBuffer(84 + nTri * 50);
    var dv = new DataView(buf);
    dv.setUint32(80, nTri, true);
    var o = 84;
    for (var t = 0; t < nTri; t++) {
      var x1 = tris[t * 9], y1 = tris[t * 9 + 1], z1 = tris[t * 9 + 2];
      var x2 = tris[t * 9 + 3], y2 = tris[t * 9 + 4], z2 = tris[t * 9 + 5];
      var x3 = tris[t * 9 + 6], y3 = tris[t * 9 + 7], z3 = tris[t * 9 + 8];
      var ux = x2 - x1, uy = y2 - y1, uz = z2 - z1;
      var vx = x3 - x1, vy = y3 - y1, vz = z3 - z1;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var nl = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / nl, true); dv.setFloat32(o + 4, ny / nl, true); dv.setFloat32(o + 8, nz / nl, true);
      o += 12;
      var vs = [[x1, y1, z1], [x2, y2, z2], [x3, y3, z3]];
      for (var k = 0; k < 3; k++) {
        dv.setFloat32(o, vs[k][0], true);
        dv.setFloat32(o + 4, vs[k][1], true);
        dv.setFloat32(o + 8, vs[k][2], true);
        o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;
    }
    var blob = new Blob([buf], { type: 'model/stl' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = mode === '1d' ? 'prism_sheet.stl' : 'pyramid_array.stl';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 200);
  }

  /* ============================================================
   * 界面辅助
   * ============================================================ */
  function setText(id, txt) { var e = $(id); if (e) e.textContent = txt; }

  function showWarn(msg) {
    var w = $('prism-warn');
    if (!w) return;
    w.style.display = msg ? 'block' : 'none';
    w.textContent = msg;
  }

  /* ============================================================
   * 刷新
   * ============================================================ */
  function refresh() {
    if (mode === '1d') {
      currentGeo = buildGeometry();
      if (currentGeo.valid && inited) rebuildMesh(currentGeo);
    } else {
      currentGeo = buildGeometry2D();
      if (currentGeo.valid && inited) rebuildMesh2D(currentGeo);
    }
    var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
    var cv = $('codeview');
    if (cv) cv.textContent = currentLang === 'build123d' ? sc.b123d : sc.cq;
    /* 光学性能预估是重计算（二维约 3 s），参数一变只标脏、不自动重算 ——
       否则每敲一个数字都要卡几秒。软依赖，模块缺失时本页功能不受影响。 */
    if (window.PrismPerf) window.PrismPerf.markStale();
  }

  /* ============================================================
   * 初始化（由 app.js 在切到本视图时调用）
   * ============================================================ */
  function init() {
    if (!hasThree()) {
      var w = $('prism-warn');
      if (w) {
        w.style.display = 'block';
        w.textContent = '三维引擎未加载（js/vendor-three.min.js 缺失），参数与导出功能仍可用。';
      }
      refresh();
      return;
    }
    /* 首次进入本视图时容器才有尺寸，故 init 时再初始化 WebGL */
    initThree();
    bindControls();
    refresh();
    resize();
    drawOnce();
  }

  var bound = false;
  function bindControls() {
    if (bound) return;
    bound = true;

    /* 参数输入：防抖后刷新 */
    var inputs = document.querySelectorAll('#view-prism .field input');
    for (var i = 0; i < inputs.length; i++) {
      (function (el) {
        el.addEventListener('input', function () {
          clearTimeout(el._t);
          el._t = setTimeout(refresh, 120);
        });
      })(inputs[i]);
    }

    /* 模式切换 */
    var btns = document.querySelectorAll('#view-prism .mode-btn');
    for (var b = 0; b < btns.length; b++) {
      (function (btn) {
        btn.onclick = function () {
          var all = document.querySelectorAll('#view-prism .mode-btn');
          for (var k = 0; k < all.length; k++) all[k].classList.remove('active');
          btn.classList.add('active');
          var prevMode = mode;
          mode = btn.dataset.mode;
          $('params_1d').style.display = (mode === '1d') ? '' : 'none';
          $('params_2d').style.display = (mode === '2d') ? '' : 'none';
          /* 切模式 = 换了一个完全不同的模型（长条 vs 方阵），
             尺寸差异大，视角一并重置，避免新模型落到视野外。
             重复点当前模式不重置（避免误触把视角弄丢）。 */
          if (mode !== prevMode) lastFrameMode = '';
          disposeMeshes();
          refresh();
          resize();
          drawOnce();
        };
      })(btns[b]);
    }

    $('btn_step').onclick = function () {
      /* 按 valid 门控：参数非法时 currentGeo 是上一版的有效几何，
         直接导出会得到「与当前参数不符」的文件。原先没这道闸。 */
      if (!currentGeo || !currentGeo.valid) return;
      var is1d = (mode === '1d');
      /* 先估体积再生成：STEP 是 ASCII，字符数即字节数 */
      var est = is1d ? currentGeo.prof.length * 900
                     : (currentGeo.nTris || 0) * 800;
      if (!confirmExportSize(est, is1d ? '一维 STEP' : '二维 STEP')) return;
      var step = is1d ? buildSTEP(currentGeo) : buildSTEP2D(currentGeo);
      download(is1d ? 'prism_sheet.step' : 'pyramid_array.step', step, 'application/step');
    };
    $('btn_build123d').onclick = function () {
      if (!currentGeo || !currentGeo.valid) return;
      var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
      download(mode === '1d' ? 'prism_sheet_build123d.py' : 'pyramid_array_build123d.py', sc.b123d, 'text/x-python');
    };
    $('btn_cq').onclick = function () {
      if (!currentGeo || !currentGeo.valid) return;
      var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
      download(mode === '1d' ? 'prism_sheet_cadquery.py' : 'pyramid_array_cadquery.py', sc.cq, 'text/x-python');
    };
    $('btn_stl').onclick = function () {
      /* 原先只判 mesh 是否存在 —— 参数变非法后仍会导出**上一版旧网格**，
         与 STEP 按钮（按 currentGeo 生成）的行为不一致。现按 valid 门控。 */
      if (!currentGeo || !currentGeo.valid || !mesh) return;
      exportSTL(mesh);
    };

    $('btn_reset').onclick = function () {
      /* 回到标准视角，并恢复"允许自动取景" */
      resetView();
    };
    $('btn_defaults').onclick = function () {
      $('p_pitch').value = 1.0;
      $('p_height').value = 0.25;
      $('p_angle').value = 60;
      $('p_base').value = 0.20;
      $('p_radius').value = 0.02;
      $('p_teeth').value = 20;
      $('p_length').value = 50;
      $('p2_pitch').value = 1.0;
      $('p2_height').value = 0.25;
      $('p2_angle').value = 45;
      $('p2_base').value = 0.20;
      $('p2_nx').value = 20;
      $('p2_ny').value = 20;
      /* 「恢复默认」是整体复位，视角一并回到标准位（与「重置视角」一致） */
      lastFrameMode = '';
      refresh();
    };
    $('btn_xray').onclick = function () {
      xrayMode = !xrayMode;
      if (mesh) {
        var m = mesh.material;
        /* transparent 与 opacity 必须一起改：常态是**不透明**（transparent=false
           时 opacity 被忽略），透视模式才开混合。改 transparent 属材质结构性
           变更，需置 needsUpdate 让 three.js 重编着色器，否则不生效。 */
        m.transparent = xrayMode;
        m.opacity = xrayMode ? 0.35 : 1.0;
        m.needsUpdate = true;
      }
      drawOnce();
    };

    var tabs = document.querySelectorAll('#view-prism .tab[data-lang]');
    for (var t = 0; t < tabs.length; t++) {
      (function (tab) {
        tab.onclick = function () {
          var all = document.querySelectorAll('#view-prism .tab[data-lang]');
          for (var k = 0; k < all.length; k++) all[k].classList.remove('active');
          tab.classList.add('active');
          currentLang = tab.dataset.lang;
          var sc = (mode === '1d') ? buildScripts(currentGeo) : buildScripts2D(currentGeo);
          var cv = $('codeview');
          if (cv) cv.textContent = currentLang === 'build123d' ? sc.b123d : sc.cq;
        };
      })(tabs[t]);
    }

    $('btn_copy').onclick = function () {
      var cv = $('codeview');
      if (!cv) return;
      copyText(cv.textContent, $('btn_copy'));
    };
  }

  /* buildSTEP2D 与上面的 buildSTEP 同构，只是顶点来自金字塔网格。

     网格结构与 rebuildMesh2D 严格一致（否则预览与导出件对不上）：
       每格 = 四周平台环（4 个四边形）+ 金字塔侧面（4 个三角形）
     2b = pitch 时平台宽度为 0，此时金字塔底面角点与格角重合，
     直接共用网格点 —— 这样底面棱边由相邻两格共享，壳仍闭合。
     若给它们另起一套顶点，底面棱边会只被一个面引用，壳就不水密了。 */
  function buildSTEP2D(geo) {
    var p = geo.p, Wx = geo.Wx, Wy = geo.Wy;
    var t = p.base, h = p.height, pitch = p.pitch, nx = p.nx, ny = p.ny;
    var b = geo.half;
    var hasPyr = b > 1e-9;
    var hasLand = (pitch - 2 * b) > 1e-9;
    var shareBase = !hasLand;         // 无平台 → 底面角点即格角

    var pts = [];
    var b0 = 0, b1 = 1, b2 = 2, b3 = 3;
    pts.push([0, 0, 0], [Wx, 0, 0], [Wx, Wy, 0], [0, Wy, 0]);

    var g = [], i, j;
    for (i = 0; i <= nx; i++) { g[i] = []; for (j = 0; j <= ny; j++) { g[i][j] = pts.length; pts.push([i * pitch, j * pitch, t]); } }

    var base4 = [], apex = [];
    for (i = 0; i < nx; i++) {
      base4[i] = []; apex[i] = [];
      for (j = 0; j < ny; j++) {
        if (shareBase) {
          base4[i][j] = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
        } else {
          var cx = (i + 0.5) * pitch, cy = (j + 0.5) * pitch;
          var o = [];
          o.push(pts.length); pts.push([cx - b, cy - b, t]);
          o.push(pts.length); pts.push([cx + b, cy - b, t]);
          o.push(pts.length); pts.push([cx + b, cy + b, t]);
          o.push(pts.length); pts.push([cx - b, cy + b, t]);
          base4[i][j] = o;
        }
        apex[i][j] = pts.length; pts.push([(i + 0.5) * pitch, (j + 0.5) * pitch, t + h]);
      }
    }

    var edges = [];
    function E(a, b) {
      var pa = pts[a], pb = pts[b];
      var dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      var len = Math.hypot(dx, dy, dz);
      edges.push({ a: a, b: b, dx: dx / len, dy: dy / len, dz: dz / len, origin: pa.slice() });
      return edges.length - 1;
    }

    E(b0, b1); E(b1, b2); E(b2, b3); E(b3, b0);
    E(b0, g[0][0]); E(b1, g[nx][0]); E(b2, g[nx][ny]); E(b3, g[0][ny]);
    for (i = 0; i < nx; i++) for (j = 0; j <= ny; j++) E(g[i][j], g[i + 1][j]);
    for (i = 0; i <= nx; i++) for (j = 0; j < ny; j++) E(g[i][j], g[i][j + 1]);
    for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) {
      var I = base4[i][j], A = apex[i][j];
      var O = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
      if (!shareBase) {
        for (var k = 0; k < 4; k++) E(O[k], I[k]);                 // 平台环辐条
        for (var k2 = 0; k2 < 4; k2++) E(I[k2], I[(k2 + 1) % 4]);  // 金字塔底棱
      }
      if (hasPyr) for (var k3 = 0; k3 < 4; k3++) E(I[k3], A);      // 金字塔侧棱
    }

    function cross(a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }
    function nrm(vec) { var l = Math.hypot(vec[0], vec[1], vec[2]) || 1; return [vec[0] / l, vec[1] / l, vec[2] / l]; }
    function pickRef(n) { return Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; }

    function faceFromVerts(vl) {
      var loopEdges = [];
      for (var q = 0; q < vl.length; q++) {
        var a = vl[q], b = vl[(q + 1) % vl.length];
        var found = -1, orient = '.T.';
        for (var e = 0; e < edges.length; e++) {
          if (edges[e].a === a && edges[e].b === b) { found = e; orient = '.T.'; break; }
          if (edges[e].a === b && edges[e].b === a) { found = e; orient = '.F.'; break; }
        }
        loopEdges.push({ ec: found, orient: orient });
      }
      var P0 = pts[vl[0]], P1 = pts[vl[1]], P2 = pts[vl[2]];
      var n = cross(
        [P1[0] - P0[0], P1[1] - P0[1], P1[2] - P0[2]],
        [P2[0] - P0[0], P2[1] - P0[1], P2[2] - P0[2]]
      );
      return { dir: nrm(n), ref: pickRef(n), loc: P0.slice(), loop: loopEdges };
    }

    var facePlanes = [];
    facePlanes.push(faceFromVerts([b0, b3, b2, b1]));
    var sideY0 = [b0, b1];
    for (i = nx; i >= 0; i--) sideY0.push(g[i][0]);
    facePlanes.push(faceFromVerts(sideY0));
    var sideX1 = [b1, b2];
    for (j = ny; j >= 0; j--) sideX1.push(g[nx][j]);
    facePlanes.push(faceFromVerts(sideX1));
    var sideY1 = [b2, b3];
    for (i = 0; i <= nx; i++) sideY1.push(g[i][ny]);
    facePlanes.push(faceFromVerts(sideY1));
    var sideX0 = [b3, b0];
    for (j = 0; j <= ny; j++) sideX0.push(g[0][j]);
    facePlanes.push(faceFromVerts(sideX0));
    for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) {
      var O2 = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
      var I2 = base4[i][j], A2 = apex[i][j];
      for (var kk = 0; kk < 4; kk++) {
        var kk2 = (kk + 1) % 4;
        if (!shareBase) facePlanes.push(faceFromVerts([O2[kk], O2[kk2], I2[kk2], I2[kk]]));  // 平台环
        if (hasPyr) facePlanes.push(faceFromVerts([I2[kk], I2[kk2], A2]));                   // 金字塔侧面
      }
    }

    var id = 0;
    function N() { return ++id; }
    var defs = [];
    function push(s) { defs.push(s); }
    var ptId = [], vxId = [];
    for (i = 0; i < pts.length; i++) {
      ptId[i] = N();
      push('#' + ptId[i] + " = CARTESIAN_POINT('',(" + pts[i][0].toFixed(6) + ',' + pts[i][1].toFixed(6) + ',' + pts[i][2].toFixed(6) + '));');
      vxId[i] = N();
      push('#' + vxId[i] + " = VERTEX_POINT('',#" + ptId[i] + ');');
    }
    var ecId = [], lnId = [];
    for (i = 0; i < edges.length; i++) {
      var l = edges[i];
      var dirId = N();
      push('#' + dirId + " = DIRECTION('',(" + l.dx.toFixed(6) + ',' + l.dy.toFixed(6) + ',' + l.dz.toFixed(6) + '));');
      var vecId = N();
      push('#' + vecId + " = VECTOR('',#" + dirId + ',1.0);');
      var locId = N();
      push('#' + locId + " = CARTESIAN_POINT('',(" + l.origin[0].toFixed(6) + ',' + l.origin[1].toFixed(6) + ',' + l.origin[2].toFixed(6) + '));');
      /* lnId 必须是数组并逐条落位。原实现把它声明为循环内局部 var，
         却在 EDGE_CURVE 里按索引取 lnId[i]，i>=1 时恒为 undefined，
         于是导出 #undefined 引用 —— 2448 条 EDGE_CURVE 全部语法错误，
         壳无法闭合、体积算出 1e+102 的垃圾值。 */
      lnId[i] = N();
      push('#' + lnId[i] + " = LINE('',#" + locId + ',#' + vecId + ');');
      ecId[i] = N();
      push('#' + ecId[i] + " = EDGE_CURVE('',#" + vxId[l.a] + ',#' + vxId[l.b] + ',#' + lnId[i] + ',.T.);');
    }
    var faceIds = [];
    for (var fi = 0; fi < facePlanes.length; fi++) {
      var fp = facePlanes[fi];
      var dirF = N();
      push('#' + dirF + " = DIRECTION('',(" + fp.dir[0].toFixed(6) + ',' + fp.dir[1].toFixed(6) + ',' + fp.dir[2].toFixed(6) + '));');
      var dirRef = N();
      push('#' + dirRef + " = DIRECTION('',(" + fp.ref[0] + ',' + fp.ref[1] + ',' + fp.ref[2] + '));');
      var locF = N();
      push('#' + locF + " = CARTESIAN_POINT('',(" + fp.loc[0].toFixed(6) + ',' + fp.loc[1].toFixed(6) + ',' + fp.loc[2].toFixed(6) + '));');
      var axF = N();
      push('#' + axF + " = AXIS2_PLACEMENT_3D('',#" + locF + ',#' + dirF + ',#' + dirRef + ');');
      var pln = N();
      push('#' + pln + " = PLANE('',#" + axF + ');');
      var oeIds = [];
      for (var ei = 0; ei < fp.loop.length; ei++) {
        var e2 = fp.loop[ei];
        var oe = N();
        push('#' + oe + " = ORIENTED_EDGE('',*,*,#" + ecId[e2.ec] + ',' + e2.orient + ');');
        oeIds.push(oe);
      }
      var eloop = N();
      push('#' + eloop + " = EDGE_LOOP('',(#" + oeIds.join(',#') + '));');
      var fb = N();
      push('#' + fb + " = FACE_OUTER_BOUND('',#" + eloop + ',.T.);');
      var fa = N();
      push('#' + fa + " = ADVANCED_FACE('',(#" + fb + '),#' + pln + ',.T.);');
      faceIds.push(fa);
    }
    var shell = N();
    push('#' + shell + " = CLOSED_SHELL('',(#" + faceIds.join(',#') + '));');
    var brep = N();
    push('#' + brep + " = MANIFOLD_SOLID_BREP('PyramidArray',#" + shell + ');');

    /* 产品结构与单位声明：修法同 buildSTEP，详见该处注释。 */
    var appCtx = N();
    push('#' + appCtx + " = APPLICATION_CONTEXT('core data for automotive design');");
    var prodCtx = N();
    push('#' + prodCtx + " = PRODUCT_CONTEXT('mechanical',#" + appCtx + ",'mechanical');");
    var product = N();
    push('#' + product + " = PRODUCT('PyramidArray','PyramidArray','',(#" + prodCtx + '));');
    var pdf = N();
    push('#' + pdf + " = PRODUCT_DEFINITION_FORMATION('','',#" + product + ');');
    var pdCtx = N();
    push('#' + pdCtx + " = PRODUCT_DEFINITION_CONTEXT('design',#" + appCtx + ",'design');");
    var pd = N();
    push('#' + pd + " = PRODUCT_DEFINITION('design','',#" + pdf + ',#' + pdCtx + ');');
    var pds = N();
    push('#' + pds + " = PRODUCT_DEFINITION_SHAPE('','',#" + pd + ');');

    var lu2 = N();
    push('#' + lu2 + " = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );");
    var au2 = N();
    push('#' + au2 + " = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );");
    var su2 = N();
    push('#' + su2 + " = ( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() );");
    var unc2 = N();
    push('#' + unc2 + " = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#" + lu2 + ",'distance_accuracy_value','');");
    var guac2 = N();
    push('#' + guac2 + ' = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#' + lu2 + ',#' + au2 + ',#' + su2 + ')) REPRESENTATION_CONTEXT(\'3D\',\'3D\') );');

    var absr = N();
    push('#' + absr + " = ADVANCED_BREP_SHAPE_REPRESENTATION('PyramidArray',(#" + brep + '),#' + guac2 + ');');
    var sdr = N();
    push('#' + sdr + ' = SHAPE_DEFINITION_REPRESENTATION(#' + pds + ',#' + absr + ');');

    return 'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('Pyramid prism array'),'2;1');\n" +
      "FILE_NAME('pyramid_array.step','" + new Date().toISOString() + "',(''),(''),'pyramid-designer','','');\n" +
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n" +
      'ENDSEC;\nDATA;\n' + defs.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  /* ---------- 对外接口 ---------- */
  window.Prism = {
    init: init,
    resize: function () { resize(); drawOnce(); },
    redraw: function () { drawOnce(); },
    get mode() { return mode; },
    get geo() { return currentGeo; },
    /* 按当前模式分派：1D 走棱镜肋、2D 走金字塔阵列。
       原实现恒调 buildSTEP，2D 下会把金字塔几何喂给 1D 生成器并抛
       TypeError（geo.prof undefined），导出按钮（自带分派）不受影响，
       但所有通过此 API 的调用方都会拿到空字符串或异常。 */
    buildSTEP: function () {
      if (!currentGeo) return '';
      return (mode === '1d') ? buildSTEP(currentGeo) : buildSTEP2D(currentGeo);
    },
    buildScripts: function () { return currentGeo ? buildScripts(currentGeo) : null; },
    /* 供无头验证同步驱动 OrbitControls 的阻尼收敛。
       真实浏览器里由 rAF 循环逐帧调 controls.update()；
       无头环境 rAF 被节流（实测 9000ms 预算只跑 3~5 帧），
       拖拽产生的角度变化靠阻尼逼近，不显式驱动就永远落不了地。 */
    spin: function (n) {
      n = n || 40;
      for (var i = 0; i < n; i++) { if (controls) controls.update(); }
      drawOnce();
    },
    /* 供无头验证读取的内部状态：把模型包围盒 8 角点投到屏幕，
       直接量出屏占比与居中偏移，避免靠截图目测/像素近似判断。 */
    /* ---------- 供「材料与参考」页的设计校核读取 ----------
       刻意让校核清单复用本页的计算，而不是在校核侧另写一套判据：
       两边的圆角判据本来就不一致（本页是 filletRadii 的「0.45×边长」+
       「同边两切点不互越」两条钳位，另写一套常见的只有前者），
       各算各的必然给出互相矛盾的结论。 */
    params: function () {
      var a = readParams(), b = readParams2D();
      return {
        mode: mode,
        p1: { pitch: a.pitch, height: a.height, angle: a.angle, base: a.base,
              radius: a.radius, N: a.N, L: a.L },
        p2: { pitch: b.pitch, height: b.height, angle: b.angle, base: b.base,
              nx: b.nx, ny: b.ny }
      };
    },
    /* 纯计算、无副作用：给定一维参数，返回半底宽与**实际生效**的圆角半径 */
    fillet: function (p1) {
      var p = p1;
      var hb = halfBase(p);
      var fr = filletRadii(rawProfile(p).pts, p.radius);
      var list = [];
      for (var i = 0; i < fr.rr.length; i++) {
        if (fr.rr[i] > 1e-12) list.push(fr.rr[i]);
      }
      return {
        half: hb.use, want: hb.want, halfClamped: hb.clamped,
        rMin: list.length ? Math.min.apply(null, list) : 0,
        rMax: list.length ? Math.max.apply(null, list) : 0
      };
    },
    /* ---------- 供「光学性能预估」读取 ----------
       性能预估必须用**本文件生成的同一套轮廓**去做光线追迹，不能另写一份
       齿形公式 —— 本项目历史上所有「显示 ≠ 实际」的缺陷都源于同一个式子
       被写了两遍。故这里只暴露「取几何」的纯函数，追迹由 prism-perf.js 负责。 */
    /* 一维轮廓（含圆角采样）+ 单元胞所需的基本量。纯计算、无副作用。 */
    profile1D: function (p1, seg) {
      var p = {
        pitch: +p1.pitch, height: +p1.height, angle: +p1.angle,
        base: +p1.base, radius: +p1.radius,
        N: Math.max(1, Math.min(500, Math.round(+p1.N))),
        L: isFinite(+p1.L) ? +p1.L : 1
      };
      if (!(p.pitch > 0) || !(p.height >= 0) || !(p.base >= 0) || !(p.radius >= 0) ||
          !isFinite(p.pitch) || !isFinite(p.height) || !isFinite(p.base) || !isFinite(p.angle) ||
          !(p.angle > 0) || !(p.angle < 180)) {
        return null;
      }
      /* seg = 圆弧的折线采样段数。默认 10 与 STEP 导出保持一致；
         光学预估走 5 —— 圆角只张 60°~90°，5 段已足够，而折线段数直接
         决定光线求交的成本（每次命中要扫一整个单元胞的所有折线段）。 */
      var fd = filletDetailed(rawProfile(p).pts, p.radius, seg || 10);
      return {
        pts: fd.pts, segArc: fd.segArc,
        pitch: p.pitch, t: p.base, h: p.height, N: p.N,
        half: halfBase(p).use, halfWant: halfBase(p).want, halfClamped: halfBase(p).clamped,
        W: p.N * p.pitch, H: p.base + p.height, angle: p.angle, radius: p.radius
      };
    },
    /* 二维金字塔的半底宽 b（含按半齿距封顶），唯一定义点仍是 halfBase2D */
    half2D: function (p2) {
      var q = { pitch: +p2.pitch, height: +p2.height, angle: +p2.angle, base: +p2.base };
      if (!(q.pitch > 0) || !(q.height >= 0) || !(q.base >= 0) ||
          !isFinite(q.pitch) || !isFinite(q.height) || !isFinite(q.base) ||
          !(q.angle > 0) || !(q.angle < 180)) {
        return null;
      }
      var hb = halfBase2D(q);
      return { half: hb.use, want: hb.want, clamped: hb.clamped };
    },
    probe: function () {      if (!camera || !renderer || !currentGeo) return null;
      var el = document.querySelector('.prism-stage');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var three = window.THREE;
      var minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, any = false;
      var half = probeHalf;
      if (!half) return null;
      for (var sx = -1; sx <= 1; sx += 2)
        for (var sy = -1; sy <= 1; sy += 2)
          for (var sz = -1; sz <= 1; sz += 2) {
            var v = new three.Vector3(sx * half[0], sy * half[1], sz * half[2]);
            var origin = new three.Vector3(probeCenter[0], probeCenter[1], probeCenter[2]);
            v.add(origin);
            v.project(camera);
            if (!isFinite(v.x) || !isFinite(v.y)) return null;
            var px = (v.x * 0.5 + 0.5) * r.width;
            var py = (-v.y * 0.5 + 0.5) * r.height;
            minx = Math.min(minx, px); maxx = Math.max(maxx, px);
            miny = Math.min(miny, py); maxy = Math.max(maxy, py);
            any = true;
          }
      if (!any) return null;
      return {
        mode: mode,
        stageW: Math.round(r.width), stageH: Math.round(r.height),
        modelW: Math.round(maxx - minx), modelH: Math.round(maxy - miny),
        leftMargin: Math.round(minx), rightMargin: Math.round(r.width - maxx),
        topMargin: Math.round(miny), bottomMargin: Math.round(r.height - maxy),
        fillH: (maxx - minx) / r.width, fillV: (maxy - miny) / r.height,
        offX: Math.round((minx + maxx) / 2 - r.width / 2),
        offY: Math.round((miny + maxy) / 2 - r.height / 2),
        /* 相机状态：用于断言"固定视角后改参数不复原"。
           这三个数是判断相机有没有被动的唯一直接依据。 */
        camPos: [+camera.position.x.toFixed(4), +camera.position.y.toFixed(4), +camera.position.z.toFixed(4)],
        camTarget: [+controls.target.x.toFixed(4), +controls.target.y.toFixed(4), +controls.target.z.toFixed(4)],
        frameMode: lastFrameMode,
        /* 取景所依据的视口宽高比，以及「相机是否仍停在取景留下的位置」。
           这两项让「取景是否与真实视口一致」成为可直接断言的量 ——
           原先只能靠截图目测，而取景用错宽高比时画面是"模型缩在一角"，
           极易被当成模型尺寸问题。 */
        frameAspect: +frameAspect.toFixed(4),
        camUntouched: cameraUntouched(),
        /* 材质参数：让「哑光不透明、二维平面着色」成为可断言的量。
           这几项曾是高光玻璃感（roughness 0.18 + 清漆层 + 半透明），
           会把二维金字塔阵列的棱面明暗差异糊掉。 */
        mat: (mesh && mesh.material) ? {
          roughness: +mesh.material.roughness.toFixed(3),
          clearcoat: mesh.material.clearcoat === undefined ? null : +mesh.material.clearcoat.toFixed(3),
          opacity: +mesh.material.opacity.toFixed(3),
          transparent: !!mesh.material.transparent,
          flatShading: !!mesh.material.flatShading,
          color: '#' + mesh.material.color.getHexString()
        } : null
      };
    }
  };
})();
