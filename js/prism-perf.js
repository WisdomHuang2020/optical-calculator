/* ============================================================
 * prism-perf.js —— 棱镜板光学性能预估（导出前的筛选性估算）
 *
 * 回答两个问题：
 *   ① 相对**同总高 H 的纯平板**，本设计的出光效率与视角均匀度各是多少？
 *   ② 若均匀度不达标，把齿做矮到哪一点能追平纯平板的均匀度 —— 那时出光效率还剩多少？
 *
 * ── 物理模型 ────────────────────────────────────────────────
 * 几何光学的蒙特卡洛光线追迹：
 *   · 斯涅尔定律 + 全反射；界面按**菲涅耳非偏振功率透过率**分配能量，
 *     反射分量留在材料内继续追迹（不是简单地判「透 or 不透」）。
 *   · 一维肋是**挤出几何**：面外波矢分量在界面处守恒，故截面内的二维
 *     追迹是严格的（不是近似）。单元胞取轮廓中间那一个齿所在的齿距格，
 *     用**本文件之外生成的同一套轮廓点**（window.Prism.profile1D），
 *     所以含圆角的真实齿形被如实追迹 —— 不另写一份齿形公式。
 *   · 二维金字塔在单元胞内做真三维追迹，横向按周期回卷。
 *   · 光从平整底面逸出后，按腔体回收率 ρ 作**朗伯再发射**重新注入
 *     （这条是棱镜板能超过逃逸锥上限的物理原因：斜面全反射把角度打乱，
 *      排除了「原路返回、原角度再全反射」的死循环）。每条初始光线最多回收 6 次。
 *
 * ── 纯平板参考（解析，不走蒙特卡洛）────────────────────────
 * 理想平行平板：内部角超过临界角的光在顶面全反射，落到同样平行的底面
 * 又全反射，角度不变 —— 在两平行面之间往复，既出不来、也进不了腔体。
 * 因此纯平板的出光效率存在硬上限：逃逸锥内的透过率加权值。
 * 也正因为它的光学与厚度无关，「同总高」比较才成立。
 *
 * ── 这个数能信到什么程度 ────────────────────────────────────
 * 它是**理想几何上限**：不含材料吸收、粗糙面散射、膜层干涉、莫尔效应、
 * 制造偏差与边缘效应，也未计入光在膜内被多次全反射后走到的侧边损耗。
 * 实测/仿真值通常**低于**此处数值，接近程度取决于上述损耗里哪一项占主导。
 * 用途是方案筛选与趋势判断，不能替代 LightTools / LiteTrace。
 * ============================================================ */
(function () {
  'use strict';

  var TAU = Math.PI * 2, RAD = Math.PI / 180, DEG = 180 / Math.PI;

  /* ---- 数值口径（工程取舍，不是物理常数）---- */
  /* 角度分布按 **立体角等分**（cosθ 均匀）分格。刻意不按 θ 等分：
     按 θ 等分时 0° 附近那格的立体角只有 2π(1−cos1.25°) ≈ 1.5e-3 sr，
     一根光线落进去就把该格「强度」抬到正常值的几十倍 —— 峰值随统计涨落
     乱跳，均匀度直接失稳（实测只有 8.7%，纯属噪声）。立体角等分后
     每格 ΔΩ = 2π/NBIN 相同，没有哪一格的除数特别小。 */
  var NBIN = 120;
  var DOM = TAU / NBIN;                // 每格立体角（球面度），恒定
  var RAYS_1D = 1200;                  // 一维：单元胞便宜，光线多一点
  var RAYS_2D = 450;                   // 二维：每次求交要步进搜索
  var RAYS_SCAN = 200;                 // 等均匀度扫描每一步的光线数
  var SCAN_IT = 4;                     // 扫描二分次数
  var MAXCAV = 8;                      // 每条初始光线的最大腔体回收次数
  var MAXSTEP = 40;                    // 单段在上下界面之间的最大折返次数（见文件头对截断的说明）
  var SCAN_MAXSTEP = 25;               // 扫描用较松的循环上限：只需要相对趋势
  var SMOOTH = [1, 2, 3, 2, 1];        // 角度分布平滑核（抑制统计涨落）
  var SEED = 20260919;                 // 固定种子：结果可复现、可断言

  /* ============================================================
     基础工具
     ============================================================ */
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 菲涅耳**功率**透过率（非偏振）= 1 − (r_s² + r_p²)/2。
     用功率而不是辐照度，正好对应光线携带的能量。
     ci = cosθ_i、ct = cosθ_t 均为正；法向入射时退化为 1 − ((n₂−n₁)/(n₂+n₁))²。 */
  function fresnelT(n1, n2, ci, ct) {
    var a = n1 * ci, b = n2 * ct;
    var rs = (a - b) / (a + b);
    var rp = (n2 * ci - n1 * ct) / (n2 * ci + n1 * ct);
    return 1 - 0.5 * (rs * rs + rp * rp);
  }

  /* 抽一条入射方向，返回 [dx, dy, dz, ky]。
       ky = 面外波矢分量（以空气为单位）——**挤出几何里它界面处守恒**，
            一维的很多结论都挂在它身上（见 traceCell 里的「永久困住」判据）。
     两种工况：
       coupled —— 介质内**各向同性**（与导光板/扩散腔光学耦合，内部角不受限）
       air     —— 光自空气经平整底面折射进入：空气侧半球各向同性，
                  折射后内部角 ≤ θc，且 |ky| ≤ 1 自动成立 */
  function sampleDir(rnd, n, coupling) {
    var ph = rnd() * TAU, c = Math.cos(ph), s2 = Math.sin(ph);
    if (coupling === 'air') {
      var mua = rnd();                       // 空气侧 cosθ
      var sa = Math.sqrt(Math.max(0, 1 - mua * mua));
      var st = sa / n;                       // 折射后 sinθ = sinθ_air / n
      var ct = Math.sqrt(Math.max(0, 1 - st * st));
      return [st * c, st * s2, ct, sa * s2];
    }
    var mu = rnd();
    var sti = Math.sqrt(Math.max(0, 1 - mu * mu));
    return [sti * c, sti * s2, mu, n * sti * s2];
  }

  function wrap(v, p) {
    var r = v - Math.floor(v / p) * p;
    return r;
  }

  /* ============================================================
     单元胞：一维（挤出肋）
     ============================================================ */
  /* 从 profile1D 的闭合轮廓里取出**一个齿距格**的上表面，作为周期高度场。
     取中间那个齿，保证左右两侧都有完整的齿间平台。
     轮廓点沿顶面是 x 单调的（rawProfile 的构造保证），故按遍历顺序收集后
     反转即得升序 —— 刻意不排序：排序会把圆角圆弧上的点重新排列，
     反而可能拼出虚假的折线。 */
  function makeCell1D(g) {
    var pitch = g.pitch, t = g.t, N = g.N;
    var i = Math.max(0, Math.min(N - 1, Math.floor(N / 2)));
    var xc = (i + 0.5) * pitch;
    var lo = xc - pitch / 2, hi = xc + pitch / 2;

    var pts = g.pts, collected = [], k;
    for (k = 0; k < pts.length; k++) {
      var q = pts[k];
      if (q[1] >= t - 1e-9 && q[0] >= lo - 1e-9 && q[0] <= hi + 1e-9) {
        collected.push([q[0] - xc, q[1]]);
      }
    }
    /* 遍历顺序是 x 递减（顶面自右向左），反转成递增 */
    collected.reverse();
    /* 同一局部 x 上取最高的点（圆弧采样在顶点附近可能出现 x 相同的情形） */
    var cellPts = [];
    for (k = 0; k < collected.length; k++) {
      var last = cellPts[cellPts.length - 1];
      if (last && Math.abs(collected[k][0] - last[0]) < 1e-12) {
        if (collected[k][1] > last[1]) cellPts[cellPts.length - 1] = collected[k];
      } else cellPts.push(collected[k]);
    }
    if (!cellPts.length) return null;
    /* 两端补到齿距格边界（落在平台上，高度 = t） */
    if (cellPts[0][0] > -pitch / 2 + 1e-12) cellPts.unshift([-pitch / 2, t]);
    else cellPts[0] = [-pitch / 2, Math.max(cellPts[0][1], t) === cellPts[0][1] ? cellPts[0][1] : t];
    var lastP = cellPts[cellPts.length - 1];
    if (lastP[0] < pitch / 2 - 1e-12) cellPts.push([pitch / 2, t]);

    var n = cellPts.length;
    /* 折线段放进扁平 Float64Array：求交是内层热点，避免嵌套数组的元素访问 */
    var seg = new Float64Array(n * 4), nSeg = 0;
    for (k = 0; k + 1 < n; k++) {
      var a = cellPts[k], b = cellPts[k + 1];
      if (b[0] - a[0] < 1e-12) continue;
      seg[nSeg * 4] = a[0]; seg[nSeg * 4 + 1] = a[1];
      seg[nSeg * 4 + 2] = b[0]; seg[nSeg * 4 + 3] = b[1];
      nSeg++;
    }
    if (!nSeg) return null;

    var zMax = -1e9;
    for (k = 0; k < n; k++) zMax = Math.max(zMax, cellPts[k][1]);

    /* 精确求交：把单元胞沿 x 周期复制若干份，逐段解线性方程组。
       比步进搜索精确 —— 圆角是 r/10 量级的圆弧采样，步进很容易跨过它，
       于是命中位置与法线都会偏。

       搜索范围可以严格收窄，不必从起点一路扫过去：
         · 起点在基准面 z = t 之下且朝上时 —— 射线在 z < t 处一定在表面之下
           （表面处处 ≥ t），故首次命中必在跨过 z = t 之后；记跨过处的横坐标
           为 xₜ，则 xₜ 落平台就当场命中，落齿的足迹内则命中点仍在该足迹之内
           （齿面在足迹边界回落到 t，射线在 z > t 处必然已穿过齿面），
           横向行程 ≤ 2b ≤ pitch。
         · 其余情形（起点已在齿层内、或朝下）—— 命中点必在起点附近 ±2 个齿距内：
           表面只有齿根到齿尖这一段起伏（幅度 h、横向 b），射线要甩开它
           就得在这段里走完，走不出去。
       于是只需扫窗口内的单元胞 —— 求交成本从 O(行程) 降成 O(常数)，
       近水平光线（行程可达板宽量级）不再拖慢整个预估。 */
    function hit(x0, y0, z0, dx, dy, dz) {
      var xt = x0;
      if (dz > 0 && z0 < t) xt = x0 + dx * ((t - z0) / dz);
      var kC = Math.floor((xt - xc) / pitch);
      /* 窗口 ±1 个单元胞就够：单元胞的局部坐标是 [−p/2, p/2]，三个相邻胞
         合起来覆盖 xt 两侧各 ≥p，而命中点距 xt 不超过 2b ≤ p。 */
      var bestS = 1e300, bi = -1, o4, ii, kk, ox;
      for (kk = kC - 1; kk <= kC + 1; kk++) {
        ox = xc + kk * pitch;
        for (ii = 0; ii < nSeg; ii++) {
          o4 = ii * 4;
          var ax = ox + seg[o4], az = seg[o4 + 1];
          var ex = seg[o4 + 2] - seg[o4], ez = seg[o4 + 3] - seg[o4 + 1];
          var det = ex * dz - ez * dx;
          if (det < 1e-15 && det > -1e-15) continue;
          var rx = ax - x0, rz = az - z0;
          var sm = (-rx * ez + ex * rz) / det;
          if (sm <= 1e-9 || sm >= bestS) continue;
          var u = (dx * rz - dz * rx) / det;
          if (u < -1e-9 || u > 1 + 1e-9) continue;
          bestS = sm; bi = ii;
        }
      }
      if (bi < 0) return null;
      o4 = bi * 4;
      var nx = seg[o4 + 3] - seg[o4 + 1], nz = -(seg[o4 + 2] - seg[o4]);
      var L = Math.sqrt(nx * nx + nz * nz);
      nx /= L; nz /= L;
      if (nz < 0) { nx = -nx; nz = -nz; }
      return {
        x: x0 + bestS * dx, y: y0, z: z0 + bestS * dz, s: bestS,
        nx: nx, ny: 0, nz: nz
      };
    }

    return {
      kind: '1d', pitch: pitch, t: t, h: g.h, b: g.half,
      xc: xc, zMax: zMax, segCount: nSeg, hit: hit
    };
  }

  /* ============================================================
     单元胞：二维（金字塔阵列）
     ============================================================ */
  /* 高度场：周期 pitch，格心一个正方形底的金字塔，四周是平台。
       底面边长 2b，塔尖高 h ⇒ z = t + h·(1 − max(|dx|,|dy|)/b)
     二维模式没有圆角输入，面全是平面，故用步进 + 二分求交即可
     （一维有圆角，才必须精确求交）。 */
  /* 二维单元胞：形状无关。
     高度场与法线来自 prism-shapes.js 的 makeSurface（六种形状共用同一套
     范数 + 剖面模型），晶格归约来自同一个文件的 reduce —— 追迹用的曲面
     与预览网格、STEP 用的是同一份公式，不再是三处各写一遍。 */
  function makeCell2D(K, p, b, t, h, topRatio) {
    var S = window.PrismShapes;
    var surf = S.makeSurface(K, { pitch: p, height: h, angle: 45, topRatio: topRatio || 0 }, b, t, h);
    var zMax = t + h;
    function f(x, y) {
      var loc = S.reduce(K, p, x, y);
      return surf(loc[0], loc[1]).z;
    }
    /* 横向步长：只需分辨最小横向特征 = min(足迹跨度, 平台宽)。
       步长取它的 1/6，再用 pitch/80 兜住「平台极窄」的极端（否则步数会爆）；
       步长过大会整个跨过很窄的足迹（两端 g 都为正）→ 漏掉真正的首次命中。 */
    var stepLat = Math.max(S.lateralFeature(K, b, p) / 6, p / 80, 1e-6);

    function out(s, x0, y0, z0, dx, dy, dz) {
      var hx = x0 + s * dx, hy = y0 + s * dy;
      var loc = S.reduce(K, p, hx, hy);
      var q = surf(loc[0], loc[1]);
      return { x: hx, y: hy, z: z0 + s * dz, s: s, nx: q.nx, ny: q.ny, nz: q.nz };
    }

    /* 步进 + 二分。搜索范围按同一套「命中点必在足迹附近」的判据收窄：
       朝上且起点在基准面之下时锚在跨过 z = t 的点 (xₜ,yₜ)，其余情形锚在起点；
       命中点必在以锚点为心、足迹外接圆直径 2·rFoot 的范围内（朝下时同理，
       表面要降到射线的高度才能相遇，横向走不出一个足迹）。近水平光线的
       行程再长也不影响成本。 */
    function hit(x0, y0, z0, dx, dy, dz) {
      var lat = Math.sqrt(dx * dx + dy * dy);   /* 热路径：避开 Math.hypot */
      var reach = 2 * S.footRadius(K, b) * 1.5 + 1e-9;
      var sMax;
      if (dz > 1e-12) {
        sMax = (zMax - z0) / dz;
        if (lat > 1e-12) {
          var base = z0 < t ? (t - z0) / dz : 0;
          sMax = Math.min(sMax, base + reach / lat);
        }
      } else if (dz < -1e-12) {
        sMax = -z0 / dz;                       /* 到平整底面为止 */
        if (lat > 1e-12) sMax = Math.min(sMax, reach / lat);
      } else return null;
      if (!(sMax > 1e-9)) return null;
      /* 只按**横向**特征分步：沿射线的 g(s) = z(s) − f(x(s)) 在起点之后
         是单调抬升的（射线持续上升，路面高度有界），故按 z 再细分没有意义；
         真正需要分辨的是横向的足迹边界，横向步长才是 ds。
         横向步长与 s 步长的换算是 ÷|d_xy|。 */
      var ds = lat > 1e-9 ? stepLat / lat : sMax / 12;
      var ns = Math.ceil(sMax / ds);
      if (!isFinite(ns) || ns < 12) ns = 12;
      if (ns > 200) ns = 200;
      var stp = sMax / ns;
      var sPrev = 0;
      for (var j = 1; j <= ns; j++) {
        var sm = j * stp;
        var g = z0 + dz * sm - f(x0 + sm * dx, y0 + sm * dy);
        if (g >= 0) {
          /* 起点就在表面上（上一次反射的落点）：把区间下端压到 0⁺，
             避免二分收敛回 s = 0 的自命中。 */
          var a = sPrev, bb2 = sm;
          for (var it = 0; it < 24; it++) {
            var m = 0.5 * (a + bb2);
            if (z0 + dz * m - f(x0 + m * dx, y0 + m * dy) >= 0) bb2 = m; else a = m;
          }
          var sOut = 0.5 * (a + bb2);
          if (sOut <= 1e-9) sOut = Math.min(sm, 1e-6);
          return out(sOut, x0, y0, z0, dx, dy, dz);
        }
        sPrev = sm;
      }
      return null;
    }

    return { kind: '2d', pitch: p, t: t, h: h, b: b, zMax: zMax, hit: hit };
  }

  /* ============================================================
     光线追迹
     ============================================================ */
  /* 立体角等分格：第 i 格 cosθ ∈ [1 − (i+1)/NBIN, 1 − i/NBIN]。
     每格 ΔΩ = 2π/NBIN 恒定，没有哪一格的除数特别小。 */
  function binOfCos(cth) {
    var i = Math.floor((1 - Math.min(1, Math.max(0, cth))) * NBIN);
    return i < 0 ? 0 : (i >= NBIN ? NBIN - 1 : i);
  }
  /* 第 i 格中心的极角（度） */
  function binTheta(i) { return Math.acos(1 - (i + 0.5) / NBIN) * DEG; }

  /* ------------------------------------------------------------
     光线追迹主循环
     ------------------------------------------------------------
     每一步只问一件事：**顶面与平整底面，谁先被碰到**。
       顶面先到 → 斯涅尔 + 菲涅耳，反射分量**从命中点继续**；
       底面先到 → 平整界面：超临界就原路折回，亚临界就出射到腔体、
                  按回收率 ρ 朗伯再注入。

     反射分量必须「从命中点继续」，不能写成「一律下到 z = 0 再折回」：
     斜面法线是斜的，垂直向上入射的光打在 60° 斜面上会**反射成斜向上**
     （d′ = d − 2(d·N)N，只有平面才保证 dz 反号）。按「必然朝下」写，
     这些光线会被塞进一条根本不存在的路径，实测被误判成困住的有 7%~16%。
     ------------------------------------------------------------ */
  function traceCell(cell, o, rays, seed) {
    var rnd = mulberry32(seed >>> 0);
    var n = o.n, rho = o.rho;
    var bins = new Float64Array(NBIN);
    var esc = 0, first = 0, cavLoss = 0, trunc = 0, escSq = 0, miss = 0, orphan = 0;
    var hits = 0, guardMax = 0, leftoverMax = 0;
    /* 未逸出的原因分解。一维里「面外分量守恒」那一项是**物理**限制，
       不是数值截断 —— 它是本页最该让人看到的一个结论，必须拆出来单列。 */
    var tb = { ky: 0, step: 0, flat: 0, miss: 0, cav: 0 };
    var maxStep = o.maxStep || MAXSTEP;
    var maxCav = o.maxCav === undefined ? MAXCAV : o.maxCav;

    for (var r = 0; r < rays; r++) {
      var rayEsc = 0, cav = 0;
      var pending = [{ w: 1, x: rnd() * cell.pitch, y: rnd() * cell.pitch }];
      var guard = 0;

      while (pending.length && guard++ < 400) {
        var item = pending.pop();
        var w = item.w;
        var x = item.x, y = item.y, z = 0;
        var isFirstItem = (guard === 1);
        var d = sampleDir(rnd, n, o.coupling);
        var dx = d[0], dy = d[1], dz = d[2], ky = d[3];

        /* 挤出几何（一维）的**永久困住**判据 —— 这是物理，不是数值截断：
           斜面法线全部落在 x–z 平面内 ⇒ 面外波矢分量 ky 在界面处守恒，而
             |k_t|² = n² − (k·N)² ≥ ky²     （因 (k·N)² ≤ kx² + kz²）
           故 |ky| > 1 时光线在**任何**斜面上都满足全反射；底面法线是 (0,0,−1)，
           同样有 |k_t|² ≥ ky² > 1。这条光线在两界面之间来回弹，永远出不来。
           介质内各向同性注入时 |ky| > 1 的占比 = 1 − 1/n（n = 1.49 时 32.9%）——
           这正是背光行业要把两张 BEF 正交交叉使用的原因。
           二维金字塔没有这条限制：它的斜面法线带 y 分量，大 |ky| 的光也能取出。
           顺带这也是个性能开关：不早退的话这些光线会把每个循环上限吃满。

           这里必须用 continue 而不是 break —— 同一段里光线可能**多次**从底面
           出射（每次出射都往队列里塞一项），break 会把还挂着的那些回收光
           一起丢掉，能量账上直接漏掉几个百分点（实测 3.07%）。 */
        if (cell.kind === '1d' && Math.abs(ky) > 1 - 1e-12) { trunc += w; tb.ky += w; continue; }

        var steps = 0, encounter = 0;
        while (true) {
          if (steps++ >= maxStep) { trunc += w; tb.step += w; break; }
          hits++;

          var sBot = dz < 0 ? (-z / dz) : Infinity;          /* 到平整底面 z = 0 */
          var top = cell.hit(x, y, z, dx, dy, dz);          /* 最近的顶面交点 */

          if (top && top.s <= sBot) {
            /* ---------- 顶面 ---------- */
            x = top.x; y = top.y; z = top.z;
            encounter++;
            var kx = n * dx, ky2 = n * dy, kz = n * dz;
            var kN = kx * top.nx + ky2 * top.ny + kz * top.nz;
            if (kN < 0) { top.nx = -top.nx; top.ny = -top.ny; top.nz = -top.nz; kN = -kN; }
            var kt2 = n * n - kN * kN;
            if (kt2 < 1) {                                   /* 折射出射 */
              var kNp = Math.sqrt(1 - kt2);
              var Ti = fresnelT(n, 1, kN / n, kNp);
              var e = w * Ti;
              if (e > 0) {
                var oz = kz - kN * top.nz + kNp * top.nz;
                bins[binOfCos(Math.abs(oz))] += e;
              }
              esc += e; rayEsc += e;
              if (isFirstItem && encounter === 1) first += e;
              w -= e;
              if (w < 1e-12) break;
            }
            kx += -2 * kN * top.nx; ky2 += -2 * kN * top.ny; kz += -2 * kN * top.nz;
            dx = kx / n; dy = ky2 / n; dz = kz / n;
            continue;
          }
          if (isFinite(sBot)) {
            /* ---------- 平整底面 ---------- */
            x = x + sBot * dx; y = y + sBot * dy; z = 0;
            var czi = -dz;                                   /* 法线 (0,0,−1) */
            var sti2 = Math.max(0, 1 - czi * czi);
            if (n * n * sti2 >= 1) { dz = -dz; continue; }    /* 全反射，原路折返 */
            var ctt = Math.sqrt(Math.max(0, 1 - n * n * sti2));
            var Tb = fresnelT(n, 1, czi, ctt);
            var wOut = w * Tb;
            w *= (1 - Tb);
            if (wOut > 1e-12) {
              cavLoss += wOut * (1 - rho);
              if (cav < maxCav) {
                cav++;
                pending.push({ w: wOut * rho, x: rnd() * cell.pitch, y: rnd() * cell.pitch });
              } else {
                trunc += wOut * rho; tb.cav += wOut * rho;
              }
            }
            if (w < 1e-12) break;
            dz = -dz;
            continue;
          }
          /* 该有交点却没有：搜索窗口出了问题，绝不能算成「逃逸」 */
          if (dz > 1e-12) { trunc += w; tb.miss += w; miss++; }
          else { trunc += w; tb.flat += w; }
          break;
        }
      }
      /* 队列里没处理完的能量：正常应为 0。留着是为了让「能量账对不平」
         这件事可见 —— 上面 continue/break 的差别就是这么查出来的。 */
      for (var q = 0; q < pending.length; q++) orphan += pending[q].w;
      if (guard > guardMax) guardMax = guard;
      if (pending.length > leftoverMax) leftoverMax = pending.length;
      escSq += rayEsc * rayEsc;
    }

    var eta = esc / rays;
    var variance = Math.max(0, escSq / rays - eta * eta);
    return {
      eta: eta,
      first: first / rays,
      bins: bins,
      cavLoss: cavLoss / rays,
      trunc: trunc / rays,
      miss: miss / rays,
      orphan: orphan / rays,
      guardMax: guardMax,
      leftoverMax: leftoverMax,
      truncBy: {
        ky: tb.ky / rays, step: tb.step / rays, flat: tb.flat / rays,
        miss: tb.miss / rays, cav: tb.cav / rays
      },
      se: Math.sqrt(variance / rays),
      hits: hits / rays,
      rays: rays
    };
  }

  /* ============================================================
     纯平板参考（解析）
     ============================================================ */
  /* 每个方向的贡献彼此独立，可直接对内部角求积，无需蒙特卡洛。
     逃逸锥外的光在顶面全反射，落到同样平行的底面又全反射（角度不变）
     —— 在两平行面之间往复，既出不去也进不了腔体。这正是纯平板的硬上限，
     也是棱镜板相对它的增益来源。

     腔体回收必须和棱镜板用同一套口径，否则比较是不公平的：
     一次入射中菲涅耳反射回去的那部分会从平整底面透射出去、经腔体以 ρ
     回到板内，而且**方向被重新随机化**，故每一轮的角分布相同 —— 于是
       η = ē / (1 − r̄)，  ē = ⟨T_顶⟩， r̄ = ⟨(1 − T_顶)·T_底·ρ⟩
     闭式即可，不必迭代。
     结论很有用：空气耦合下平板本来就取出 90%，回收只添一点点（97%）；
     棱镜板反而要绕更多圈、多付几次 ρ 的损耗，总通量**低于**平板 ——
     它的收益是轴上准直，不是总通量。耦合工况下才反过来：
     平板被逃逸锥死死卡住（74% 的光出不来），棱镜板把角度打乱才解得开。 */
  function computeFlat(o) {
    var n = o.n, rho = o.rho;
    var muLo = o.coupling === 'air' ? Math.sqrt(Math.max(0, 1 - 1 / (n * n))) : 0;
    var M = 20000, bins = new Float64Array(NBIN);
    var eSum = 0, rSum = 0, trap = 0;
    for (var i = 0; i < M; i++) {
      var mu = muLo + (1 - muLo) * (i + 0.5) / M;
      var st = Math.sqrt(Math.max(0, 1 - mu * mu));
      if (n * st >= 1) { trap += 1; continue; }   /* 全反射 → 两平行面之间往复，出不来 */
      var ct = Math.sqrt(Math.max(0, 1 - n * n * st * st));   /* 出射角余弦（空气侧） */
      var Tt = fresnelT(n, 1, mu, ct);            /* 顶面透射 */
      var Tb = fresnelT(n, 1, mu, ct);            /* 底面透射（同一角度） */
      eSum += Tt;
      rSum += (1 - Tt) * Tb * rho;
      bins[binOfCos(ct)] += Tt;
    }
    var eBar = eSum / M, rBar = rSum / M;
    var eta = rBar < 1 ? eBar / (1 - rBar) : 1;
    var scale = eBar > 0 ? eta / eBar : 0;        /* 出射角分布按同一次入射归一 */
    for (var b = 0; b < NBIN; b++) bins[b] = bins[b] / M * scale;
    return { eta: eta, first: eBar, bins: bins, trapped: trap / M, rBar: rBar, rays: M, se: 0 };
  }

  /* ============================================================
     角度分布指标
     ============================================================ */
  function smoothBins(bins) {
    var out = new Float64Array(NBIN), k = SMOOTH.length >> 1, s = 0, i, j;
    for (j = 0; j < SMOOTH.length; j++) s += SMOOTH[j];
    for (i = 0; i < NBIN; i++) {
      var acc = 0;
      for (j = -k; j <= k; j++) {
        var idx = i + j;
        if (idx < 0) idx = 0;
        if (idx >= NBIN) idx = NBIN - 1;
        acc += SMOOTH[j + k] * bins[idx];
      }
      out[i] = acc / s;
    }
    return out;
  }

  /* 把「每格能量」换成「每格立体角内的平均强度」（球面度⁻¹）。
     格子本来就是立体角等分的，故只差一个常数因子 1/ΔΩ —— 但保留这一步，
     是为了让「均匀度 = 锥内平均强度 / 峰值强度」这句话在代码里直接可读。 */
  function toIntensity(bins) {
    var I = new Float64Array(NBIN);
    for (var i = 0; i < NBIN; i++) I[i] = bins[i] / DOM;
    return I;
  }

  /* 视角均匀度 U = 视角锥内强度的**立体角加权平均** / 峰值强度。
     取峰用平滑后的分布：单个统计涨落的格子会把峰值抬高、把 U 压低，
     而这个数要跟「≥70%」这类工程门限比，不能让它随涨落乱跳。
     口径写清楚：这是**角度均匀度**，看的是配光曲线平不平；
     面内照度均匀度取决于整个灯具（导光板、扩散板、灯距），
     本页给不出，必须另行仿真或实测。 */
  function uniformity(bins, thetaV) {
    var I = smoothBins(toIntensity(bins));
    var sum = 0, cnt = 0, mx = 0;
    for (var i = 0; i < NBIN; i++) {
      if (binTheta(i) > thetaV) break;
      sum += I[i]; cnt++;
      if (I[i] > mx) mx = I[i];
    }
    if (!cnt || !(mx > 0)) return 0;
    return (sum / cnt) / mx;
  }

  /* 半高全角：峰两侧降到峰值一半处的张角 */
  function fwhm(bins) {
    var I = smoothBins(toIntensity(bins));
    var ip = 0, i;
    for (i = 1; i < NBIN; i++) if (I[i] > I[ip]) ip = i;
    if (!(I[ip] > 0)) return 0;
    var half = 0.5 * I[ip];
    var left = 0, right = 90, found = false;
    for (i = ip; i < NBIN; i++) if (I[i] <= half) { right = binTheta(i); found = true; break; }
    if (!found) right = 90;
    found = false;
    for (i = ip; i >= 0; i--) if (I[i] <= half) { left = binTheta(i); found = true; break; }
    if (!found) left = 0;
    return ip === 0 ? 2 * right : (right + left);
  }

  /* ============================================================
     等均匀度设计点：齿高按比例缩放，二分找到 U 追平纯平板的点
     ============================================================ */
  /* 扫描只是用来找「均匀度追平平板」的那个齿高，关心的是相对趋势、
     不是绝对效率，故用较松的循环上限换速度。 */
  function scanOpt(o) {
    var q = {};
    for (var k in o) q[k] = o[k];
    q.maxStep = Math.min(o.maxStep || MAXSTEP, SCAN_MAXSTEP);
    return q;
  }
  function equalUniformity(makeCell, o, targetU, baseU) {
    if (baseU >= targetU) return { needed: false, k: 1 };
    var lo = 0.0, hi = 1.0, k, c, t, U, last = null;
    for (var it = 0; it < SCAN_IT; it++) {
      k = 0.5 * (lo + hi);
      c = makeCell(k);
      if (!c) { hi = k; continue; }
      t = traceCell(c, scanOpt(o), RAYS_SCAN, SEED + 977);
      U = uniformity(t.bins, o.thetaV);
      if (U < targetU) hi = k; else lo = k;
      last = { k: k, eta: t.eta, U: U };
    }
    /* 取二分收敛后的中点再算一次，报出的数才与 k 对应 */
    var kf = 0.5 * (lo + hi);
    var cf = makeCell(kf);
    if (!cf) return { needed: true, k: kf, eta: null, U: null };
    var tf = traceCell(cf, scanOpt(o), RAYS_SCAN, SEED + 977);
    return { needed: true, k: kf, eta: tf.eta, U: uniformity(tf.bins, o.thetaV), last: last };
  }

  /* ============================================================
     主计算：纯函数，不碰 DOM（便于无头断言）
     ============================================================ */
  function compute(opts) {
    var o = {
      n: opts.n, rho: opts.rho, coupling: opts.coupling, thetaV: opts.thetaV,
      uMin: opts.uMin
    };
    var P = (window.Prism && window.Prism.params) ? window.Prism.params() : null;
    if (!P) return { ok: false, why: '棱镜模块未就绪' };
    /* 允许显式指定模式：测试要能不动 DOM 就把两种模式都跑一遍 */
    if (opts.mode === '1d' || opts.mode === '2d') P = { mode: opts.mode, p1: P.p1, p2: P.p2 };

    var flat = computeFlat(o);
    var design, cell, makeCell, note = '';

    if (P.mode === '1d') {
      /* 圆弧只采 5 段：折线段数直接决定每次求交的成本，而圆角只张 60°~90°，
         5 段与 10 段的几何差在微米量级，对筛选性估算无影响。 */
      var g = window.Prism.profile1D(P.p1, 5);
      if (!g || !(g.h > 0) || !(g.half > 0)) {
        return { ok: false, why: '一维几何无效（齿高或半底宽为 0），当前参数等同平板。' };
      }
      cell = makeCell1D(g);
      if (!cell) return { ok: false, why: '无法从轮廓中取出单元胞。' };
      makeCell = function (k) {
        var gg = window.Prism.profile1D({
          pitch: P.p1.pitch, height: P.p1.height * k, angle: P.p1.angle,
          base: P.p1.base, radius: P.p1.radius, N: P.p1.N, L: P.p1.L
        }, 5);
        return gg ? makeCell1D(gg) : null;
      };
      design = traceCell(cell, o, RAYS_1D, SEED);
      note = '一维肋按挤出几何作严格二维追迹（面外波矢分量在界面处守恒）';
    } else {
      var K2 = window.Prism.shapeOf(P.p2.shape);
      var hb = window.Prism.half2D(P.p2);
      if (!hb || !(hb.half > 0) || !(P.p2.height > 0)) {
        return { ok: false, why: '二维几何无效（结构高或半底宽为 0），当前参数等同平板。' };
      }
      cell = makeCell2D(K2, P.p2.pitch, hb.half, P.p2.base, P.p2.height, P.p2.topRatio);
      makeCell = function (k) {
        return makeCell2D(K2, P.p2.pitch, hb.half * k, P.p2.base, P.p2.height * k, P.p2.topRatio);
      };
      design = traceCell(cell, o, RAYS_2D, SEED);
      note = K2.label + '阵列在单元胞内作真三维追迹（横向按' +
             (K2.lattice === 'hex' ? '蜂窝晶格' : '方形晶格') + '回卷）';
    }

    var Ud = uniformity(design.bins, o.thetaV);
    var Uf = uniformity(flat.bins, o.thetaV);
    var scan = equalUniformity(makeCell, o, Uf, Ud);

    return {
      ok: true, mode: P.mode, opt: o, note: note,
      flat: { eta: flat.eta, first: flat.first, U: Uf, fwhm: fwhm(flat.bins), trapped: flat.trapped },
      design: {
        eta: design.eta, first: design.first, U: Ud, fwhm: fwhm(design.bins),
        se: design.se, cavLoss: design.cavLoss, trunc: design.trunc, rays: design.rays,
        truncBy: design.truncBy, orphan: design.orphan
      },
      scan: scan,
      geometry: P.mode === '1d'
        ? { pitch: P.p1.pitch, height: P.p1.height, angle: P.p1.angle, base: P.p1.base, H: P.p1.base + P.p1.height }
        : { pitch: P.p2.pitch, height: P.p2.height, angle: P.p2.angle, base: P.p2.base, H: P.p2.base + P.p2.height }
    };
  }

  /* ============================================================
     DOM 层
     ============================================================ */
  var $ = function (id) { return document.getElementById(id); };
  var bound = false, running = false, stale = true, last = null;

  function num(id, lo, hi, dflt) {
    var e = $(id);
    if (!e) return dflt;
    var v = parseFloat(e.value);
    if (!isFinite(v)) return dflt;
    return Math.max(lo, Math.min(hi, v));
  }
  function pct(x, d) { return (100 * x).toFixed(d === undefined ? 1 : d) + '%'; }
  function set(id, txt) { var e = $(id); if (e) e.textContent = txt; }
  var EMPTY = ['pf_p1f', 'pf_p1d', 'pf_etaf', 'pf_etad', 'pf_uf', 'pf_ud', 'pf_ff', 'pf_fd'];

  function readOpts() {
    var c = $('perf_coupling');
    return {
      coupling: (c && c.value === 'air') ? 'air' : 'coupled',
      n: num('perf_n', 1.30, 2.60, 1.49),
      rho: num('perf_rho', 0, 1, 0.85),
      thetaV: num('perf_thetav', 5, 89, 60),
      uMin: num('perf_umin', 5, 100, 70) / 100
    };
  }

  function clearTable() {
    for (var i = 0; i < EMPTY.length; i++) set(EMPTY[i], '—');
  }

  function render(r, o) {
    var cls = 'perf-verdict';
    var v = $('pf_verdict');
    if (!r.ok) {
      clearTable();
      if (v) { v.textContent = r.why || '无法预估'; v.className = cls + ' warn'; }
      set('pf_scan', '');
      set('pf_meta', '');
      return;
    }
    set('pf_p1f', pct(r.flat.first));
    set('pf_p1d', pct(r.design.first));
    set('pf_etaf', pct(r.flat.eta));
    set('pf_etad', pct(r.design.eta));
    set('pf_uf', pct(r.flat.U, 0));
    set('pf_ud', pct(r.design.U, 0));
    set('pf_ff', r.flat.fwhm.toFixed(0) + '°');
    set('pf_fd', r.design.fwhm.toFixed(0) + '°');

    /* 未逸出的分解要如实写出来：一维里「面外分量守恒」那一项是**物理**限制
       （1 − 1/n），不是数值问题；「循环上限」那一项才是数值截断。
       两者混在一起会让人把物理上限误当成算法没跑够。 */
    var tb = r.design.truncBy;
    var tail = '';
    if (tb && tb.ky > 0.001) tail += '；其中面外分量守恒 ' + pct(tb.ky, 1) + ' 物理上取不出来';
    if (tb && tb.step > 0.005) tail += '；循环上限截断 ' + pct(tb.step, 1) + '（真实值略高）';
    set('pf_meta', r.design.rays + ' 条光线 · 统计标准误 ±' + (100 * r.design.se).toFixed(1) +
      '% · 未逸出 ' + pct(r.design.trunc, 1) + tail);

    var gain = r.flat.eta > 0 ? (r.design.eta / r.flat.eta - 1) : NaN;
    var uOk = r.design.U >= o.uMin;
    var lines = [];
    lines.push('出光效率 ' + (isFinite(gain) && gain >= 0 ? '+' : '') + (100 * gain).toFixed(0) +
      '%（相对同总高 ' + r.geometry.H.toFixed(2) + ' mm 纯平板）');
    lines.push('视角均匀度 ' + pct(r.design.U, 0) + ' ' + (uOk ? '≥ ' : '< ') +
      pct(o.uMin, 0) + ' 门限 ' + (uOk ? '✓' : '✗'));
    if (v) { v.textContent = lines.join('\n'); v.className = cls + (uOk ? ' ok' : ' warn'); }

    var s = r.scan;
    if (!s || !s.needed) {
      set('pf_scan', '均匀度已不低于纯平板，无需折衷 —— 齿高保持 ' +
        r.geometry.height.toFixed(3) + ' mm 即为等均匀度设计点。');
    } else if (s.eta === null) {
      set('pf_scan', '等均匀度扫描未能收敛（参数退化）。');
    } else {
      var kNew = r.geometry.height * s.k;
      var g2 = r.flat.eta > 0 ? (s.eta / r.flat.eta - 1) : NaN;
      set('pf_scan', '等均匀度设计点：齿高降到 ' + kNew.toFixed(3) + ' mm（×' + s.k.toFixed(2) +
        '）时视角均匀度追平纯平板 ' + pct(r.flat.U, 0) + '，此时出光效率 ' + pct(s.eta) +
        '，仍比纯平板高 ' + (100 * g2).toFixed(0) + '%。');
    }
  }

  /* 计算是本页最重的操作（二维约 2~4 s），故**按需触发**：
     参数一变先标脏、不自动重算，等用户点「重新预估」——
     否则每敲一个数字都要卡几秒。 */
  function markStale() {
    stale = true;
    var b = $('pf_btn');
    if (b) { b.textContent = '重新预估'; b.classList.add('dirty'); }
    var v = $('pf_verdict');
    if (v && last) {
      v.textContent = '参数已改动 —— 点「重新预估」更新结果';
      v.className = 'perf-verdict stale';
    }
  }

  function run() {
    if (running) return;
    var v = $('pf_verdict');
    if (v) { v.textContent = '计算中…（一维约 0.2 s，二维约 2~4 s）'; v.className = 'perf-verdict'; }
    var b = $('pf_btn');
    if (b) { b.disabled = true; b.textContent = '计算中…'; }
    /* 先让浏览器把「计算中」画出来，再做同步的重计算 */
    setTimeout(function () {
      var o = readOpts(), r;
      try { r = compute(o); }
      catch (e) { r = { ok: false, why: '预估失败：' + (e && e.message ? e.message : e) }; }
      render(r, o);
      last = r;
      stale = false;
      running = false;
      if (b) { b.disabled = false; b.textContent = '重新预估'; b.classList.remove('dirty'); }
    }, 30);
    running = true;
  }

  function bind() {
    if (bound) return;
    bound = true;
    ['perf_coupling', 'perf_n', 'perf_rho', 'perf_thetav', 'perf_umin'].forEach(function (id) {
      var e = $(id);
      if (!e) return;
      e.addEventListener('input', markStale);
      e.addEventListener('change', markStale);
    });
    var btn = $('pf_btn');
    if (btn) btn.addEventListener('click', function () { run(); });
  }

  function init() {
    if (!$('pf_verdict')) return;
    bind();
    if (!last) run();          /* 首次进入自动算一次，之后由用户按需重算 */
  }

  window.PrismPerf = {
    init: init,
    run: run,
    markStale: markStale,
    compute: compute,
    /* 供离线诊断与测试读取内部量：角度分布、单元胞、循环上限。
       页面本身不用它 —— 但「命中次数是否撞上限」「角度分布长什么样」
       这类问题只能从这里回答，靠截图与聚合值都看不出来。 */
    _internals: {
      traceCell: traceCell, makeCell1D: makeCell1D, makeCell2D: makeCell2D,
      toIntensity: toIntensity, uniformity: uniformity, fwhm: fwhm, computeFlat: computeFlat,
      defaults: {
        RAYS_1D: RAYS_1D, RAYS_2D: RAYS_2D, RAYS_SCAN: RAYS_SCAN, SCAN_IT: SCAN_IT,
        MAXSTEP: MAXSTEP, SCAN_MAXSTEP: SCAN_MAXSTEP, MAXCAV: MAXCAV, NBIN: NBIN, DOM: DOM
      },
      binTheta: binTheta, binOfCos: binOfCos
    },
    /* 供无头验证读取：当前渲染出的判定文本与表格值 */
    probe: function () {
      return {
        verdict: ($('pf_verdict') || {}).textContent || '',
        verdictCls: ($('pf_verdict') || {}).className || '',
        scan: ($('pf_scan') || {}).textContent || '',
        meta: ($('pf_meta') || {}).textContent || '',
        stale: stale,
        btnText: ($('pf_btn') || {}).textContent || '',
        cells: {
          p1f: ($('pf_p1f') || {}).textContent, p1d: ($('pf_p1d') || {}).textContent,
          etaf: ($('pf_etaf') || {}).textContent, etad: ($('pf_etad') || {}).textContent,
          uf: ($('pf_uf') || {}).textContent, ud: ($('pf_ud') || {}).textContent,
          ff: ($('pf_ff') || {}).textContent, fd: ($('pf_fd') || {}).textContent
        },
        last: last ? {
          ok: true, mode: last.mode,
          etaFlat: last.flat.eta, etaDesign: last.design.eta,
          UFlat: last.flat.U, UDesign: last.design.U,
          fwhmFlat: last.flat.fwhm, fwhmDesign: last.design.fwhm,
          trunc: last.design.trunc, truncKy: last.design.truncBy.ky,
          truncStep: last.design.truncBy.step, truncFlat: last.design.truncBy.flat,
          truncMiss: last.design.truncBy.miss, orphan: last.design.orphan,
          cavLoss: last.design.cavLoss, se: last.design.se, rays: last.design.rays,
          scanNeeded: last.scan && last.scan.needed,
          scanK: last.scan && last.scan.k,
          scanEta: last.scan && last.scan.eta,
          H: last.geometry.H
        } : { ok: false }
      };
    }
  };
})();
