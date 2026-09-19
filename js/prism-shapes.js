/* ============================================================
 * prism-shapes.js —— 二维面阵微结构的「形状内核」
 *
 * 为什么单独一个模块：
 *   二维设计原先只有一种形状（正方形底金字塔），几何量、预览网格、
 *   STEP 导出、性能预估四处各自写了一遍金字塔的公式。加形状时若照此
 *   复制，会变成 6 份互相漂移的实现 —— 本文件存在的意义就是把这些
 *   公式收敛到**一处**，并让 prism.js 与 prism-perf.js 共用同一套内核。
 *
 * 统一模型（六种形状都落在这个模型里，不是六套特判）：
 *
 *   ① 范数 d(x,y)。单元胞中心为原点，{d ≤ b} 就是足迹（底面轮廓）：
 *        四棱锥/台锥   d = max(|x|,|y|)            → 正方形足迹
 *        六棱锥        d = max(|u·nᵢ|), nᵢ 间隔 60° → 正六边形足迹（内切圆半径 b）
 *        圆锥/球冠/抛物面 d = √(x²+y²)              → 圆形足迹
 *      d 的单位是长度，|∇d| = 1，且 ∇d 指向"离中心最远"的那个方向 —— 
 *      正是曲面的水平梯度方向。
 *
 *   ② 剖面 g(u)，u = d/b ∈ [0,1]，高度 z = t + h·g(u)，g(0)=1、g(1)=0：
 *        线性（四棱锥/圆锥/六棱锥） g = 1 − u
 *        台锥（k = 顶面半宽占比）    g = 1 (u ≤ k)，g = (1−u)/(1−k) (u > k)
 *        球冠                        g 由球半径 R 决定（见 sphereGeom）
 *        抛物面帽                    g = 1 − u²
 *      于是曲面的斜率模长 = (h/b)·|g′(u)|：法线 n ∝ (−∇z, 1)。
 *
 *   ③ 倾角 α 的物理含义统一为「底面边缘处的切线倾角」——
 *      平面面型的切线就是面本身（故 α 就是面倾角），球冠/抛物面则是
 *      底部边缘那一圈的切线与水平面的夹角。这样才能在同一个输入框里
 *      换形状而不产生歧义。由此各形状的半底宽：
 *        线性面型      b = h/tan α
 *        球冠          b = h·cot(α/2)          （推导：b = h(1/tanα + 1/sinα)）
 *        抛物面        b = 2h/tan α            （z = h(1−(r/b)²) 在 r=b 处斜率 2h/b）
 *      台锥额外需要 k（顶面半宽 / 底面半宽）：b = h/(tanα·(1−k))，k=0 即四棱锥。
 *
 *   ④ 晶格（单元胞的铺排）：
 *        方形格（四棱锥/台锥/圆锥/球冠/抛物面）：胞间距 = pitch，胞面积 = pitch²
 *        蜂窝格（六棱锥）：中心连线间距 = pitch，胞面积 = (√3/2)·pitch²
 *      六棱锥的足迹内切圆半径 b ≤ pitch/2 时恰好密排（填充率 100%），
 *      与方形格的 2b = pitch 条件是同一个式子 —— 两条晶格的 η 公式见 fillOf()。
 *
 * 体积全部有解析式（见 volumeOf），测试里与数值积分逐形状对照 ——
 * 这是唯一能防住"网格改了、体积没跟着改"的办法。
 * ============================================================ */
(function (global) {
  'use strict';

  var SQRT3 = Math.sqrt(3);
  var COS60 = 0.5, SIN60 = SQRT3 / 2;
  /* 六边形范数的三个独立法线（0°、60°、120°，其余为反向） */
  var HEX_N = [[1, 0], [COS60, SIN60], [-COS60, SIN60]];

  function max3(a, b, c) { return a > b ? (a > c ? a : c) : (b > c ? b : c); }

  /* ------------------------------------------------------------
   * 范数与梯度方向
   * ------------------------------------------------------------ */

  /* 正方形范数：|∇d| = 1，方向为坐标轴方向（取绝对值较大的那个分量） */
  function normSquareDir(x, y) {
    var ax = Math.abs(x), ay = Math.abs(y);
    if (ax >= ay) return [x >= 0 ? 1 : -1, 0, ax];
    return [0, y >= 0 ? 1 : -1, ay];
  }
  /* 正六边形范数（内切圆半径 = d）。三对法线里取最大投影；
     注意交点处会出现两个并列最大值，此时取任意一个都对 ——
     那两个面在棱上相交，法线沿棱的任意一侧极限都成立。 */
  function normHexDir(x, y) {
    var best = -1, bi = 0, i, t;
    for (i = 0; i < 3; i++) {
      t = x * HEX_N[i][0] + y * HEX_N[i][1];
      var a = t < 0 ? -t : t;
      if (a > best) { best = a; bi = i; }
    }
    t = x * HEX_N[bi][0] + y * HEX_N[bi][1];
    var s = t >= 0 ? 1 : -1;
    return [s * HEX_N[bi][0], s * HEX_N[bi][1], best];
  }
  /* 圆范数：径向 */
  function normCircleDir(x, y) {
    var d = Math.sqrt(x * x + y * y);
    if (d < 1e-12) return [1, 0, 0];
    return [x / d, y / d, d];
  }

  var normOf = {
    square: normSquareDir,
    hex: normHexDir,
    circle: normCircleDir
  };

  /* ------------------------------------------------------------
   * 剖面：g(u) 与 |g′(u)|
   * ------------------------------------------------------------ */

  /* 球冠几何：已知底半径 b 与冠高 h，返球半径 R 与球心相对底面的高度。
     R = (b² + h²)/(2h)。h → 0 时 R → ∞（退化成平面），数学上正确。
     返回里必须带上 b 与 h —— 剖面函数 g/gp 要从同一个对象里取它们，
     少一个字段就会静默算出 NaN（页面不报错，只是几何全空）。 */
  function sphereGeom(b, h) {
    var R = (b * b + h * h) / (2 * h);
    return { R: R, b: b, h: h, centerZ: h - R };     /* 球心在底面之下 |centerZ| */
  }

  var PROFILES = {
    /* 线性：金字塔、圆锥、六棱锥 */
    linear: {
      g: function (u) { return 1 - u; },
      gp: function () { return 1; }       /* |g′| 恒定 */
    },
    /* 台锥：u ≤ k 为平顶（斜率 0），其余按 (1−u)/(1−k) 线性下降 */
    frustum: {
      g: function (u, k) { return u <= k ? 1 : (1 - u) / (1 - k); },
      gp: function (u, k) { return u <= k ? 0 : 1 / (1 - k); }
    },
    /* 球冠：z = t + h − (R − √(R² − (b u)²)) */
    sphere: {
      g: function (u, k, geo) {
        var R = geo.R, r = geo.b * u;
        return (Math.sqrt(Math.max(0, R * R - r * r)) - (R - geo.h)) / geo.h;
      },
      gp: function (u, k, geo) {
        var R = geo.R, r = geo.b * u;
        var s = Math.sqrt(Math.max(1e-18, R * R - r * r));
        return (geo.b * r) / s / geo.h;      /* |dz/du|/h = b²u/(s·h) */
      }
    },
    /* 抛物面：z = t + h(1 − u²) */
    parabola: {
      g: function (u) { return 1 - u * u; },
      gp: function (u) { return 2 * u; }
    }
  };

  /* ------------------------------------------------------------
   * 形状内核
   * ------------------------------------------------------------ */
  /* usesTop: 是否需要「顶面半宽占比 k」输入（仅台锥）
     lattice: 'square' | 'hex'
     facets : 侧面数（4 / 6 / 0 表示回转面，做网格时按方位角离散）
     bExpr  : 半底宽公式（读数标签要用，必须与 halfBase() 的实现一致 ——
              写成常量字符串而不是再算一遍，就是为了让"标签 ≠ 算法"这类
              错位没有藏身之处）
     smooth : 侧面是否曲面（曲面才需要径向分环，平面一环就够） */
  var KERNELS = {
    pyramid: {
      id: 'pyramid', label: '四棱锥', lattice: 'square', norm: 'square',
      profile: 'linear', facets: 4, usesTop: false, smooth: false,
      bExpr: 'b = h/tan(α)',
      hint: '正方形底金字塔阵列。倾角 α 即斜面倾角，半底宽 b = h/tan α。'
    },
    frustum: {
      id: 'frustum', label: '台锥（截头四棱锥）', lattice: 'square', norm: 'square',
      profile: 'frustum', facets: 4, usesTop: true, smooth: false,
      bExpr: 'b = h/(tanα·(1−k))',
      hint: '平顶截头金字塔。α 仍是斜面倾角，平顶半宽 = k·b。' +
            '平顶让尖顶不崩、脱模更容易，代价是顶部多一条"平板直通"通道。'
    },
    cone: {
      id: 'cone', label: '圆锥', lattice: 'square', norm: 'circle',
      profile: 'linear', facets: 0, usesTop: false, smooth: false,
      bExpr: 'b = h/tan(α)',
      hint: '圆形底圆锥阵列（方形排布，圆形足迹内切于胞）。回转对称 —— ' +
            '单张片在两个轴向上同时准直，配光各向同性；代价是填充率上限只有 π/4 ≈ 0.785。'
    },
    sphere: {
      id: 'sphere', label: '球冠（微透镜）', lattice: 'square', norm: 'circle',
      profile: 'sphere', facets: 0, usesTop: false, smooth: true,
      bExpr: 'b = h·cot(α/2)',
      hint: '球冠微透镜阵列。α 是底面边缘的切线倾角（曲面斜率逐点变化），' +
            'R = (b²+h²)/(2h)。偏扩散、增益低，均匀度最好。'
    },
    parabola: {
      id: 'parabola', label: '抛物面帽', lattice: 'square', norm: 'circle',
      profile: 'parabola', facets: 0, usesTop: false, smooth: true,
      bExpr: 'b = 2h/tan(α)',
      hint: '抛物面帽阵列，z = t + h(1−(r/b)²)。α 是边缘切线倾角。' +
            '侧壁斜率由缓变陡，比球冠更利于把光推向轴向。'
    },
    hexpyr: {
      id: 'hexpyr', label: '六棱锥（蜂窝密排）', lattice: 'hex', norm: 'hex',
      profile: 'linear', facets: 6, usesTop: false, smooth: false,
      bExpr: 'b = h/tan(α)',
      hint: '正六边形底六棱锥，蜂窝密排（中心间距 = pitch）。' +
            'b 为足迹内切圆半径，b = pitch/2 时恰好密排、无平台、无正交条纹。'
    }
  };

  var ORDER = ['pyramid', 'frustum', 'cone', 'sphere', 'parabola', 'hexpyr'];

  /* ------------------------------------------------------------
   * 半底宽：唯一定义点
   * ------------------------------------------------------------ */
  /* 返回 {want, use, clamped}：want 是形状要求的半底宽，
     use 是按晶格上限钳位后的实际值（钳位必须上报，不能静默改数）。 */
  function halfBase(K, p) {
    var h = p.height, a = p.angle * Math.PI / 180, tan = Math.tan(a);
    var want;
    if (K.profile === 'sphere') {
      /* b = h(1/tanα + 1/sinα) = h·cot(α/2) */
      want = h * (1 / tan + 1 / Math.sin(a));
    } else if (K.profile === 'parabola') {
      want = 2 * h / tan;
    } else if (K.profile === 'frustum') {
      var k = Math.max(0, Math.min(0.95, p.topRatio || 0));
      want = h / (tan * (1 - k));
    } else {
      want = h / tan;
    }
    if (!isFinite(want) || want < 0) want = 0;
    var max = p.pitch / 2;
    return { want: want, use: Math.min(want, max), clamped: want > max + 1e-9, max: max };
  }

  /* ------------------------------------------------------------
   * 面积与体积（解析式）
   * ------------------------------------------------------------ */
  function footprintArea(K, b) {
    if (K.norm === 'square') return 4 * b * b;
    if (K.norm === 'hex') return 2 * SQRT3 * b * b;
    return Math.PI * b * b;                    /* circle */
  }
  function cellArea(K, pitch) {
    return K.lattice === 'hex' ? (SQRT3 / 2) * pitch * pitch : pitch * pitch;
  }
  function fillOf(K, b, pitch) {
    return footprintArea(K, b) / cellArea(K, pitch);
  }
  /* 体积：线性剖面族的形状都是"底面按比例缩放的棱柱台"，
     故棱柱台公式 (1/3)h(A₁+A₂+√(A₁A₂)) 通用（圆锥/六棱锥同样适用，
     它们只是 A₂ = 0 的特例）。球冠与抛物面另有闭式。 */
  function volumeOf(K, b, h, k) {
    var A1 = footprintArea(K, b);
    if (K.profile === 'frustum') {
      var kk = Math.max(0, Math.min(0.95, k || 0));
      var A2 = A1 * kk * kk;
      return h * (A1 + A2 + Math.sqrt(A1 * A2)) / 3;
    }
    if (K.profile === 'sphere') return Math.PI * h * (3 * b * b + h * h) / 6;
    if (K.profile === 'parabola') return Math.PI * b * b * h / 2;
    return A1 * h / 3;
  }

  /* ------------------------------------------------------------
   * 曲面求值（性能预估内核的入口）
   * ------------------------------------------------------------ */
  /* 返 {z, nx, ny, nz, inside}：高度场取值的同一处定义。
     slope = (h/b)·|g′(u)| 是「高度随横向距离的下降率」，
     与 |∇d| = 1 一起给出水平梯度 (slope·dir)，故法线 ∝ (−slope·dir, 1)。 */
  function makeSurface(K, p, b, t, h) {
    var nrm = normOf[K.norm], prof = PROFILES[K.profile];
    var k = Math.max(0, Math.min(0.95, p.topRatio || 0));
    var geo = { R: 0, b: b, h: h };
    if (K.profile === 'sphere') geo = sphereGeom(b, h);
    var kTop = K.profile === 'frustum' ? k : 0;

    function at(x, y) {
      var nd = nrm(x, y), d = nd[2];
      if (b > 1e-12 && d <= b) {
        var u = d / b;
        var z = t + h * prof.g(u, k, geo);
        var slope = (h / b) * prof.gp(u, k, geo);
        var lx = slope * nd[0], ly = slope * nd[1];
        var L = Math.sqrt(lx * lx + ly * ly + 1);
        return { z: z, nx: lx / L, ny: ly / L, nz: 1 / L, inside: true, u: u };
      }
      return { z: t, nx: 0, ny: 0, nz: 1, inside: false, u: 1 };
    }
    at.kTop = kTop;
    at.geo = geo;
    return at;
  }

  /* 横向上"最细的可分辨特征"：足迹跨度与平台宽度里的小者。
     性能预估据此定步长 —— 步长太大会整个跨过一个很窄的足迹。 */
  function lateralFeature(K, b, pitch) {
    var foot = K.norm === 'circle' ? 2 * b : 2 * b;      /* 内切圆直径/对边距 */
    var land = pitch - 2 * b;
    return Math.max(Math.min(foot, land), 1e-6);
  }

  /* ------------------------------------------------------------
   * 晶格：把胞心铺满 nx × ny
   * ------------------------------------------------------------ */
  /* 方形格：中心在 (i+0.5)p, (j+0.5)p，板为矩形 p·nx × p·ny
     蜂窝格：行距 (√3/2)p，奇数行沿 x 偏移 p/2；板为各胞六边形的并集
       （外轮廓是锯齿状，由 tileOutline 求） */
  function latticeCenters(K, pitch, nx, ny) {
    var out = [], i, j;
    if (K.lattice === 'hex') {
      var rowH = SQRT3 / 2 * pitch;
      for (j = 0; j < ny; j++) {
      var off = hexOffset(j) * pitch;
      for (i = 0; i < nx; i++) out.push({ x: (i + 0.5) * pitch + off, y: (j + 0.5) * rowH });
      }
    } else {
      for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) {
        out.push({ x: (i + 0.5) * pitch, y: (j + 0.5) * pitch });
      }
    }
    return out;
  }

  function boundsOf(K, pitch, nx, ny) {
    if (K.lattice === 'hex') {
      var rowH = SQRT3 / 2 * pitch;
      return { Wx: nx * pitch + pitch / 2, Wy: ny * rowH };
    }
    return { Wx: nx * pitch, Wy: ny * pitch };
  }

  /* 胞边界（tile）在方向 e 上的半径：方形胞为正方形支撑函数，
     六边形胞为内切圆半径 p/2 的六边形支撑函数。 */
  function tileSupport(K, pitch, ex, ey) {
    if (K.lattice === 'hex') return (pitch / 2) / Math.max(Math.abs(ex), Math.abs(0.5 * ex + SIN60 * ey), Math.abs(-0.5 * ex + SIN60 * ey));
    var m = Math.max(Math.abs(ex), Math.abs(ey));
    return (pitch / 2) / (m || 1);
  }
  /* 足迹边界在方向 e 上的半径 */
  function footSupport(K, b, ex, ey) {
    if (K.norm === 'circle') return b;
    if (K.norm === 'hex') return b / Math.max(Math.abs(ex), Math.abs(0.5 * ex + SIN60 * ey), Math.abs(-0.5 * ex + SIN60 * ey));
    return b / (Math.max(Math.abs(ex), Math.abs(ey)) || 1);
  }

  /* ------------------------------------------------------------
   * 晶格归约：任意点 → 最近胞心的局部坐标
   * ------------------------------------------------------------ */
  /* 光线追迹每步都要问"我现在在哪个胞里"，这是热路径，不能用遍历。
     方形格直接取模；蜂窝格按行定位后只需比较 3×2 = 6 个候选中心。
     两种晶格共用同一套 latticeCenters 的排布约定（见 hexOffset），
     否则预览里看到的排布和追迹用的排布会悄悄错位。 */
  function hexOffset(j) { return (((j % 2) + 2) % 2) ? 0.5 : 0; }
  function rowPitch(pitch) { return SQRT3 / 2 * pitch; }

  function reduce(K, pitch, x, y) {
    if (K.lattice !== 'hex') {
      var half = pitch / 2;
      return [x - Math.floor(x / pitch) * pitch - half,
              y - Math.floor(y / pitch) * pitch - half];
    }
    var rh = rowPitch(pitch);
    var j0 = Math.floor(y / rh - 0.5);
    var bd = Infinity, bx = 0, by = 0, dj, di, j, i, cx, cy, dx, dy, d;
    for (dj = -1; dj <= 1; dj++) {
      j = j0 + dj;
      cy = (j + 0.5) * rh;
      i = Math.floor((x - hexOffset(j) * pitch) / pitch - 0.5);
      for (di = 0; di <= 1; di++) {
        cx = (i + di + 0.5) * pitch + hexOffset(j) * pitch;
        dx = x - cx; dy = y - cy;
        d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bx = dx; by = dy; }
      }
    }
    return [bx, by];
  }

  /* 足迹的最大半径（外接圆半径）：追迹时"命中点不会跑出这个范围"的判据要用。
     正方形足迹的对角线半径是 b√2，六边形是 2b/√3，圆就是 b。 */
  function footRadius(K, b) {
    if (K.norm === 'square') return b * Math.SQRT2;
    if (K.norm === 'hex') return 2 * b / SQRT3;
    return b;
  }

  /* ------------------------------------------------------------
   * 离散度：预览与导出用不同的精细度
   * ------------------------------------------------------------ */
  /* 平面侧面（金字塔/台锥/圆锥/六棱锥）沿径向**不需要分环** —— 侧面本身
     就是直纹面，一环到底就是精确几何；分环只会白白放大网格与 STEP 体积。
     曲面（球冠/抛物面）才需要径向分环，环数决定面形误差。 */
  function defaultRings(K) { return K.smooth ? 6 : 1; }

  /* 按胞数自适应离散度：目标是整板的面数不超过 budget。
     为什么必须自适应 —— 曲面形状在 20×20 = 400 个胞上按 32 段方位角 × 6 环
     铺开是 400 × 224 = 9 万个面，STEP 会到上百 MB，浏览器直接卡死。
     宁可在导出时把圆锥离散成 12 边形并**如实告知**，也不要让用户等死。
     返回的 object 同时给出面数估值，供界面显示"当前离散度"。 */
  function tessFor(K, nCells, budget) {
    if (K.norm !== 'circle') return { azimuth: K.norm === 'hex' ? 6 : 4, rings: 1, exact: true };
    var per = budget / Math.max(1, nCells);
    var minR = K.smooth ? 2 : 1;
    var best = null;
    /* 面数估算必须算上"并进去的胞角方向"（圆形足迹会额外加 4 个角），
       否则估小了 —— 实测 400 胞球冠按 8 段估是 9600 面，实际 14400。
       方位角下限取 8：等分角与胞角方向重合时（4 段时两者都是 45°+k·90°）
       去重后只剩 4 个方向 —— 圆形足迹会退化成一个菱形四棱锥，导出件
       与"圆锥/球冠"名不副实。宁可粗一点也要保住回转面的形状语义。 */
    var AA = [32, 24, 20, 16, 12, 10, 8];
    var i, r, A, D;
    for (i = 0; i < AA.length; i++) {
      A = AA[i]; D = A + 4;
      for (r = 6; r >= minR; r--) {
        if (D * (r + 1) <= per) { best = { azimuth: A, rings: r, exact: !K.smooth }; break; }
      }
      if (best) break;
    }
    if (!best) best = { azimuth: 8, rings: minR, exact: false };
    return best;
  }
  /* 一个胞按给定离散度会有多少面（用于估 STEP 体积） */
  function cellPolys(K, b, pitch, tess) {
    /* h 只影响 z 坐标、不影响面数；传 1 只是为了让球冠几何不出现 0 除 */
    var m = meshCell(K, b, 1, pitch, {
      azimuth: tess.azimuth, rings: tess.rings, topRatio: tess.topRatio || 0
    });
    return m.polys.length;
  }

  /* ------------------------------------------------------------
   * 网格：一个单元胞
   * ------------------------------------------------------------ */
  /* 采样方向：面型（正方/六边足迹）必须**取到角点**，否则 48 等分方位角
     会把方形足迹切成外接 48 边形、四条直棱变成圆弧 —— 几何就错了。
     故面型用角点方向（4 或 6 个），曲线足迹用 N 等分方位角。 */
  function sampleDirs(K, N) {
    var angs = [], dirs = [], i, n;
    if (K.norm === 'square') {
      for (i = 0; i < 4; i++) angs.push((45 + i * 90) * Math.PI / 180);
    } else if (K.norm === 'hex') {
      for (i = 0; i < 6; i++) angs.push((30 + i * 60) * Math.PI / 180);
    } else {
      n = N;
      for (i = 0; i < n; i++) angs.push((i + 0.5) * 2 * Math.PI / n);
      /* 曲线足迹落在方形 / 六边形胞里时，**等分方位角取不到胞的角点**：
         每个胞的平台环会在角上"抄近路"（从右边上的最后一点直接跳到
         上边上的第一点），四个胞拼起来就在角点处留下一个小方孔 ——
         实测 2×2 圆锥阵列在中心角点留下 0.18 mm 见方的洞，STEP 的壳
         因此多出一个内环，CAD 里体积直接算错。
         把胞角方向并进取样角即可补上：角点上必须有顶点。 */
      var corners = (K.lattice === 'hex') ? [30, 90, 150, 210, 270, 330] : [45, 135, 225, 315];
      for (i = 0; i < corners.length; i++) angs.push(corners[i] * Math.PI / 180);
      angs.sort(function (p, q) { return p - q; });
      var uniq = [];
      for (i = 0; i < angs.length; i++) {
        if (!uniq.length || angs[i] - uniq[uniq.length - 1] > 1e-9) uniq.push(angs[i]);
      }
      angs = uniq;
    }
    for (i = 0; i < angs.length; i++) dirs.push([Math.cos(angs[i]), Math.sin(angs[i])]);
    return dirs;
  }

  /* 单胞网格（胞局部坐标，z 从 0 起，底面在 z=0；调用方整体抬高 t）。
     返回 {verts, polys}；polys 是顶点序号环（三角形或四边形）。 */
  function meshCell(K, b, h, pitch, opts) {
    opts = opts || {};
    var N = opts.azimuth || 32;          /* 曲线足迹的方位角数 */
    var M = opts.rings || defaultRings(K);   /* 剖面径向环数：平面侧面不分环 */
    var dirs = sampleDirs(K, N);
    var prof = PROFILES[K.profile];
    var k = Math.max(0, Math.min(0.95, opts.topRatio || 0));
    var geo = K.profile === 'sphere' ? sphereGeom(b, h) : { R: 0, b: b, h: h };
    var verts = [], polys = [];
    var nD = dirs.length, i, j;

    function push(x, y, z) { verts.push([x, y, z]); return verts.length - 1; }

    /* 每个方向上的半径：足迹（曲线为常数 b，面型为支撑函数） */
    var rFoot = [], rTile = [];
    for (i = 0; i < nD; i++) {
      rFoot.push(footSupport(K, b, dirs[i][0], dirs[i][1]));
      rTile.push(tileSupport(K, pitch, dirs[i][0], dirs[i][1]));
    }

    var hasLand = false;
    for (i = 0; i < nD; i++) if (rTile[i] - rFoot[i] > 1e-9) hasLand = true;

    /* ---- 平台环：胞边界 → 足迹边界（同一方向上一一对应，四/六边形） ---- */
    var landOuter = [], landInner = [];
    if (hasLand) {
      for (i = 0; i < nD; i++) {
        landOuter.push(push(dirs[i][0] * rTile[i], dirs[i][1] * rTile[i], 0));
        landInner.push(push(dirs[i][0] * rFoot[i], dirs[i][1] * rFoot[i], 0));
      }
      for (i = 0; i < nD; i++) {
        var i2 = (i + 1) % nD;
        polys.push([landOuter[i], landOuter[i2], landInner[i2], landInner[i]]);
      }
    }

    /* ---- 顶面：径向环带 + 平顶面（台锥）或顶点 ----
       尖顶形状（u = 0 处所有方向都收敛到中心一点）不建退化环：
       直接从 u = 1/M 开始建环，最后用三角形收到一个顶点上。 */
    var isFlatTop = K.profile === 'frustum' && k > 1e-9;
    var uStart = isFlatTop ? k : 0;
    var rings = [], u, ring, p;
    for (j = (isFlatTop ? 0 : 1); j <= M; j++) {
      u = uStart + (1 - uStart) * (j / M);
      ring = [];
      for (i = 0; i < nD; i++) {
        p = dirs[i];
        var r = rFoot[i] * u;
        ring.push(push(p[0] * r, p[1] * r, h * prof.g(u, k, geo)));
      }
      rings.push(ring);
    }
    /* 绕向：沿方位角正序走「上一环 → 下一环 → 下一环的下一个方向 →
       上一环的下一个方向」，叉积才指向外。反过来写（两环各自正序）
       得到的法线是朝内的 —— 预览看不出，但 STEP 的壳会整体翻面、
       CAD 里算出负体积。 */
    for (j = 0; j + 1 < rings.length; j++) {
      for (i = 0; i < nD; i++) {
        var a2 = (i + 1) % nD;
        polys.push([rings[j][i], rings[j + 1][i], rings[j + 1][a2], rings[j][a2]]);
      }
    }
    if (isFlatTop) {
      /* 平顶：rings[0] 就是顶面多边形本身（u = k 处 g = 1，高度 h） */
      polys.push(rings[0].slice());
    } else {
      var apex = push(0, 0, h * prof.g(uStart, k, geo));
      for (i = 0; i < nD; i++) {
        var b2 = (i + 1) % nD;
        polys.push([rings[0][i], rings[0][b2], apex]);
      }
    }

    return { verts: verts, polys: polys, nDirs: nD, rings: M };
  }

  /* 单胞网格的三角形数（唯一计数点：读数必须与 meshCell 实际压入的一致）。
     四边形计 2 个三角形，多边形计 n−2 个。 */
  function triCountCell(K, b, h, pitch, opts) {
    var m = meshCell(K, b, h, pitch, opts);
    return polysToTriCount(m.polys);
  }
  function polysToTriCount(polys) {
    var n = 0;
    for (var i = 0; i < polys.length; i++) n += Math.max(0, polys[i].length - 2);
    return n;
  }

  /* ------------------------------------------------------------
   * 板的底面轮廓（胞并集的外边界）
   * ------------------------------------------------------------ */
  /* 做法：把每个胞的多边形边都收集起来，按「无向边」抵消出现两次的内部边，
     剩下的边首尾相接成环。方形格得到的就是矩形（与外轮廓一致），
     蜂窝格得到锯齿形外轮廓 —— 两者用同一段代码，不会各写一遍。 */
  function plateOutline(K, pitch, nx, ny) {
    var polyOf = K.lattice === 'hex' ? hexTile(pitch) : squareTile(pitch);
    var centers = latticeCenters(K, pitch, nx, ny);
    var edges = {}, i, c, k, n;
    function key(a, bb) { return a + '|' + bb; }
    for (i = 0; i < centers.length; i++) {
      c = centers[i];
      n = polyOf.length;
      for (k = 0; k < n; k++) {
        var pa = polyOf[k], pb = polyOf[(k + 1) % n];
        var ax = +(pa[0] + c.x).toFixed(9), ay = +(pa[1] + c.y).toFixed(9);
        var bx = +(pb[0] + c.x).toFixed(9), by = +(pb[1] + c.y).toFixed(9);
        var ka = ax + ',' + ay, kb = bx + ',' + by;
        var kk = ka < kb ? key(ka, kb) : key(kb, ka);
        if (edges[kk]) edges[kk].n++; else edges[kk] = { a: ka, b: kb, n: 1 };
      }
    }
    /* 只保留出现一次的边（外边界），再连成环 */
    var segs = [], kk2;
    for (kk2 in edges) if (edges[kk2].n === 1) segs.push(edges[kk2]);
    var from = {}, s;
    for (i = 0; i < segs.length; i++) {
      (from[segs[i].a] = from[segs[i].a] || []).push(i);
      (from[segs[i].b] = from[segs[i].b] || []).push(i);
    }
    var loop = [], used = {}, cur = segs.length ? 0 : -1, startNode = segs.length ? segs[0].a : null;
    if (cur < 0) return [];
    var node = startNode;
    while (true) {
      var cand = from[node] || [], next = -1;
      for (i = 0; i < cand.length; i++) if (!used[cand[i]]) { next = cand[i]; break; }
      if (next < 0) break;
      used[next] = 1;
      s = segs[next];
      var other = (s.a === node) ? s.b : s.a;
      var pt = other.split(',');
      loop.push([parseFloat(pt[0]), parseFloat(pt[1])]);
      node = other;
      if (node === startNode) break;
    }
    return loop;
  }
  function squareTile(p) {
    var h = p / 2;
    return [[-h, -h], [h, -h], [h, h], [-h, h]];
  }
  function hexTile(p) {
    var r = p / SQRT3;                  /* 内切圆半径 p/2 → 外接半径 p/√3 */
    var out = [];
    for (var i = 0; i < 6; i++) {
      var a = (30 + i * 60) * Math.PI / 180;
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return out;
  }

  /* ------------------------------------------------------------
   * 整板组装：单胞网格铺到晶格上 + 焊接 + 补基底
   * ------------------------------------------------------------ */
  /* 顶点必须焊接 —— 相邻胞的公共棱要变成同一个顶点，STEP 的壳才闭得住
     （不焊接时每条公共棱只被一个面引用，CAD 里算出 1e+102 的垃圾体积）。
     焊接键取到 1e-6 mm（1 nm）：板尺寸在几十 mm 量级，同一物理点由不同
     胞算出时只差 1e-15 量级，量化到 nm 必然落进同一格。

     基底的做法：先取顶面的边界环，再沿环往下长出侧壁、最后封底。
     这样蜂窝晶格的锯齿外轮廓与方形晶格的矩形外轮廓用的是同一段代码，
     不会各写一遍后漂移。 */
  function assemblePlate(K, opt) {
    var b = opt.b, h = opt.h, pitch = opt.pitch, nx = opt.nx, ny = opt.ny, t = opt.base || 0;
    var ts = opt.tess || { azimuth: normOfCircleName(K), rings: defaultRings(K) };
    var topRatio = opt.topRatio || 0;

    var verts = [], polys = [], wmap = Object.create(null), i, j, q;
    function weld(x, y, z) {
      var key = Math.round(x * 1e6) + ',' + Math.round(y * 1e6) + ',' + Math.round(z * 1e6);
      var idx = wmap[key];
      if (idx !== undefined) return idx;
      idx = verts.length;
      verts.push([x, y, z]);
      wmap[key] = idx;
      return idx;
    }

    var centers = latticeCenters(K, pitch, nx, ny);
    var cellPolys = 0;
    for (i = 0; i < centers.length; i++) {
      var c = centers[i];
      var m = meshCell(K, b, h, pitch,
        { azimuth: ts.azimuth, rings: ts.rings, topRatio: topRatio });
      var remap = new Array(m.verts.length);
      for (j = 0; j < m.verts.length; j++) {
        var v = m.verts[j];
        remap[j] = weld(c.x + v[0], c.y + v[1], t + v[2]);
      }
      for (j = 0; j < m.polys.length; j++) {
        var poly = m.polys[j], outp = [];
        for (q = 0; q < poly.length; q++) {
          var gi = remap[poly[q]];
          /* 焊接会把重合的顶点并成一个（b → 0 时整圈环都塌到中心），
             于是多边形里会出现连续重复序号 —— 不去掉就会建出零长度边。 */
          if (outp.length && outp[outp.length - 1] === gi) continue;
          outp.push(gi);
        }
        if (outp.length > 2 && outp[outp.length - 1] === outp[0]) outp.pop();
        if (outp.length >= 3) polys.push(outp);
      }
      cellPolys = m.polys.length;
    }

    var loops = boundaryLoops(polys);
    var slabTris = 0;
    for (i = 0; i < loops.length; i++) {
      var loop = loops[i], n = loop.length;
      if (n < 3) continue;
      var bot = new Array(n);
      for (j = 0; j < n; j++) {
        var pv = verts[loop[j]];
        bot[j] = weld(pv[0], pv[1], 0);
      }
      /* 基底厚 t = 0 时侧壁高度为 0，建出来是退化面（上下顶点被焊成
         同一个），反而把壳弄坏 —— 此时只封底就够了：顶面边界环与底面
         边界环本就是同一条环。 */
      if (t > 1e-9) {
        for (j = 0; j < n; j++) {
          var j2 = (j + 1) % n;
          /* 绕向 [上, 下, 下, 上]：叉积才指向板外 */
          polys.push([loop[j], bot[j], bot[j2], loop[j2]]);
          slabTris += 2;
        }
      }
      polys.push(bot.slice().reverse());          // 反向 → 法线朝 −z
      slabTris += Math.max(0, n - 2);
    }

    return {
      verts: verts, polys: polys, cellPolys: cellPolys,
      slabTris: slabTris, loops: loops, loopCount: loops.length
    };
  }
  function normOfCircleName(K) { return K.norm === 'circle' ? 32 : (K.norm === 'hex' ? 6 : 4); }

  /* 有向边的边界环提取：内部边的反向必然也出现，故只留"单向边" */
  function boundaryLoops(polys) {
    var dir = Object.create(null), keys = [], i, q;
    for (i = 0; i < polys.length; i++) {
      var poly = polys[i], m = poly.length;
      for (q = 0; q < m; q++) {
        var a = poly[q], b = poly[(q + 1) % m];
        var k = a + '_' + b;
        if (dir[k] === undefined) { dir[k] = 1; keys.push(k); }
        else dir[k]++;
      }
    }
    var next = Object.create(null), starts = [];
    for (i = 0; i < keys.length; i++) {
      var sp = keys[i].split('_');
      var a2 = +sp[0], b2 = +sp[1];
      if (dir[b2 + '_' + a2] !== undefined) continue;   // 内部边
      if (next[a2] === undefined) next[a2] = [];
      next[a2].push(b2);
      starts.push(a2);
    }
    var loops = [], seen = Object.create(null);
    for (i = 0; i < starts.length; i++) {
      var s0 = starts[i];
      if (seen['s' + s0]) continue;
      var loop = [], cur = s0, guard = 0;
      while (guard++ <= keys.length + 8) {
        loop.push(cur);
        var cand = next[cur];
        if (!cand || !cand.length) break;
        var nb = cand.shift();
        if (nb === s0) break;
        cur = nb;
      }
      if (loop.length >= 3) loops.push(loop);
      for (q = 0; q < loop.length; q++) seen['s' + loop[q]] = 1;
    }
    return loops;
  }

  /* 整板壳的水密性自检：每条无向边恰好被 2 个面引用，且欧拉示性数 = 2。
     这是唯一能防住"预览看着对、导出的 STEP 闭不上"的检查 ——
     两者用的是同一份顶点/面，但焊接一失效就只有这里会报。 */
  function shellReport(plate) {
    var cnt = Object.create(null), i, q;
    for (i = 0; i < plate.polys.length; i++) {
      var poly = plate.polys[i], m = poly.length;
      for (q = 0; q < m; q++) {
        var a = poly[q], b = poly[(q + 1) % m];
        var k = a < b ? (a + '_' + b) : (b + '_' + a);
        cnt[k] = (cnt[k] || 0) + 1;
      }
    }
    var once = 0, twice = 0, more = 0, E = 0;
    for (var k2 in cnt) {
      E++;
      if (cnt[k2] === 1) once++;
      else if (cnt[k2] === 2) twice++;
      else more++;
    }
    var V = plate.verts.length, F = plate.polys.length;
    return { V: V, E: E, F: F, once: once, twice: twice, more: more,
             euler: V - E + F, closed: (once === 0 && more === 0 && (V - E + F) === 2) };
  }

  /* ------------------------------------------------------------
   * 简单多边形三角化（耳切法）
   * ------------------------------------------------------------ */
  /* 为什么自己写而不是用 THREE.ShapeUtils：底面板在蜂窝晶格下是**非凸**的
     锯齿六边形，扇形三角化会画到板外去；而导出（STEP/STL）与预览必须
     用同一份三角形，才不会出现"预览看不出、导出去才发现"。
     耳切法对简单多边形（无自交）总收敛，输入正是胞并集的边界环。 */
  function triangulate(pts) {
    var n = pts.length, i;
    if (n < 3) return [];
    var idx = [];
    for (i = 0; i < n; i++) idx.push(i);
    /* 统一成逆时针（面积 > 0），耳切的凸凹判据才成立 */
    var ar = 0;
    for (i = 0; i < n; i++) {
      var q = (i + 1) % n;
      ar += pts[i][0] * pts[q][1] - pts[q][0] * pts[i][1];
    }
    if (ar < 0) idx.reverse();

    function cross3(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    function pointInTri(p, a, b, c) {
      var d1 = cross3(a, b, p), d2 = cross3(b, c, p), d3 = cross3(c, a, p);
      var neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      var pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      return !(neg && pos);
    }

    var out = [], guard = 0;
    while (idx.length > 3 && guard++ < n * n + 64) {
      var clipped = false, m = idx.length;
      for (i = 0; i < m; i++) {
        var i0 = idx[(i + m - 1) % m], i1 = idx[i], i2 = idx[(i + 1) % m];
        var A = pts[i0], B = pts[i1], C = pts[i2];
        if (cross3(A, B, C) <= 1e-12) continue;         /* 凹角，不能切 */
        var ok = true, k;
        for (k = 0; k < m; k++) {
          var jv = idx[k];
          if (jv === i0 || jv === i1 || jv === i2) continue;
          if (pointInTri(pts[jv], A, B, C)) { ok = false; break; }
        }
        if (!ok) continue;
        out.push([i0, i1, i2]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break;    /* 退化输入：剩下的交给调用方判断 */
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }

  /* ------------------------------------------------------------
   * 曲线足迹在胞内的等分方位角（供预览与导出使用）
   * ------------------------------------------------------------ */
  function azimuthCount(K, nx, ny) {
    if (K.norm !== 'circle') return K.norm === 'hex' ? 6 : 4;
    var cells = nx * ny;
    if (cells > 400) return 16;
    if (cells > 100) return 24;
    return 32;
  }

  var API = {
    list: ORDER.map(function (id) { return KERNELS[id]; }),
    get: function (id) { return KERNELS[id] || KERNELS.pyramid; },
    ids: ORDER.slice(),
    halfBase: halfBase,
    footprintArea: footprintArea,
    cellArea: cellArea,
    fillOf: fillOf,
    volumeOf: volumeOf,
    makeSurface: makeSurface,
    lateralFeature: lateralFeature,
    reduce: reduce,
    footRadius: footRadius,
    defaultRings: defaultRings,
    tessFor: tessFor,
    cellPolys: cellPolys,
    hexOffset: hexOffset,
    rowPitch: rowPitch,
    latticeCenters: latticeCenters,
    boundsOf: boundsOf,
    tileSupport: tileSupport,
    footSupport: footSupport,
    sampleDirs: sampleDirs,
    meshCell: meshCell,
    triCountCell: triCountCell,
    polysToTriCount: polysToTriCount,
    plateOutline: plateOutline,
    assemblePlate: assemblePlate,
    boundaryLoops: boundaryLoops,
    shellReport: shellReport,
    triangulate: triangulate,
    sphereGeom: sphereGeom,
    azimuthCount: azimuthCount,
    normOf: normOf,
    _internals: { PROFILES: PROFILES, KERNELS: KERNELS, hexTile: hexTile, squareTile: squareTile }
  };

  global.PrismShapes = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : this);
