/* ============================================================
 * optics.js — 光度学计算核心
 * 纯函数库，无副作用。挂载到 window.Optics
 *
 * 符号约定
 *   γ      光线与灯具光轴夹角（变量）(rad)
 *   θ½     "半光强半角"：光强降至峰值 50% 处与光轴的夹角 (rad)
 *          也是圆锥的半顶角。代码内沿用 gammaHalf 命名。
 *   光束角  行业手册常指"半光强全角" = 2θ½，是 θ½ 的两倍；
 *          本工具只接收 θ½，UI 不提供全角口径以避免混淆。
 *   Φ      灯具总光通量 (lm)
 *   I(γ)   给定方向光强 (cd = lm/sr)
 *   h      灯具到被照面的垂直距离 (m)
 *   r      被照面上某点到光轴落点的水平距离 (m)
 * ============================================================ */
(function (global) {
  'use strict';

  var DEG = Math.PI / 180;
  var RAD = 180 / Math.PI;
  var TWO_PI = Math.PI * 2;
  var HALF_PI = Math.PI / 2;

  /* ---------------------------------------------------------
   * 一、立体角
   * ------------------------------------------------------- */

  /** 圆锥（半顶角 θ）对应的球冠立体角：Ω = 2π(1 − cosθ) */
  function solidAngle(thetaRad) {
    return TWO_PI * (1 - Math.cos(thetaRad));
  }

  /** 球的完整立体角 */
  var FULL_SPHERE = 4 * Math.PI;   // ≈ 12.5664 sr
  var HEMISPHERE  = 2 * Math.PI;   // ≈ 6.2832 sr

  /* ---------------------------------------------------------
   * 二、配光模型
   * ------------------------------------------------------- */

  /**
   * 由半光强半角 θ½ 求 cos^n 余弦幂配光指数
   *   I(γ) = I_max · cos^n γ ,  令 I(θ½) = 0.5·I_max
   *   ⇒ n = ln 0.5 / ln(cos θ½)
   */
  function exponentFromHalfAngle(gammaHalfRad) {
    var c = Math.cos(gammaHalfRad);
    if (!(c > 0)) return 0;              // θ½ ≥ 90° → 退化为半球均匀配光
    if (c >= 1) return 1e6;              // θ½ → 0  → 理想平行光束
    return Math.log(0.5) / Math.log(c);
  }

  /** 在 cos^n 配光下，光强降到 Imax·frac 处的夹角 */
  function angleAtFraction(n, frac) {
    if (!(n > 0)) return HALF_PI;
    var c = Math.pow(frac, 1 / n);
    if (c <= 0) return HALF_PI;
    if (c >= 1) return 0;
    return Math.acos(c);
  }

  /**
   * 构建配光模型
   * opts = {
   *   model: 'cosN' | 'uniform',
   *   flux:  number,                 // 总光通量 lm
   *   gammaHalfRad: number,          // 半光强角 rad
   *   centerIntensity: number|null   // 用户指定的中心光强 cd（可选）
   * }
   */
  function buildModel(opts) {
    var model = opts.model === 'uniform' ? 'uniform' : 'cosN';
    var gh = opts.gammaHalfRad;
    var flux = opts.flux;
    var omegaHalf = solidAngle(gh);

    var m = {
      model: model,
      flux: flux,
      gammaHalfRad: gh,
      gammaHalfDeg: gh * RAD,
      omegaHalf: omegaHalf,            // 半光强锥立体角 sr
      n: null,
      Imax: 0,
      ImaxDerived: 0,
      ImaxSource: 'derived',
      fluxImplied: 0,
      // 半光强锥内的"平均光强"（注意：不是峰值）
      ImaxConeAverage: flux / omegaHalf,
      // 峰值光强核算：锥内光通量 / 锥立体角
      coneAverageIntensity: 0
    };

    if (model === 'cosN') {
      m.n = exponentFromHalfAngle(gh);
      // Φ = ∫₀^{π/2} I_max cos^n γ · 2π sinγ dγ = 2π I_max /(n+1)
      m.ImaxDerived = flux * (m.n + 1) / TWO_PI;
    } else {
      m.ImaxDerived = flux / omegaHalf;   // 均匀锥配光：全部光通量落在锥内
    }

    var given = opts.centerIntensity;
    var useGiven = (typeof given === 'number' && isFinite(given) && given > 0);
    m.Imax = useGiven ? given : m.ImaxDerived;
    m.ImaxSource = useGiven ? 'given' : 'derived';

    // 反推：按该峰值光强，灯具实际等效总光通量
    m.fluxImplied = (model === 'cosN')
      ? TWO_PI * m.Imax / (m.n + 1)
      : m.Imax * omegaHalf;

    // 半光强锥内的光通量及其平均光强
    m.fluxInHalfCone = fluxInCone(m, gh);
    m.coneAverageIntensity = m.fluxInHalfCone / omegaHalf;

    return m;
  }

  /* ---------------------------------------------------------
   * 三、光强与光通量
   * ------------------------------------------------------- */

  /** 给定夹角方向的光强 I(γ)，cd */
  function intensity(m, gammaRad) {
    var c = Math.cos(gammaRad);
    if (c <= 0) return 0;
    if (m.model === 'cosN') return m.Imax * Math.pow(c, m.n);
    return gammaRad <= m.gammaHalfRad + 1e-12 ? m.Imax : 0;   // 均匀锥配光
  }

  /** 半顶角 gammaRad 锥内包含的光通量，lm */
  function fluxInCone(m, gammaRad) {
    if (!(gammaRad > 0)) return 0;
    var g = Math.min(gammaRad, HALF_PI);
    var c = Math.cos(g);
    if (m.model === 'cosN') {
      // ∫₀^g I_max cos^n γ · 2π sinγ dγ = 2π I_max (1 − cos^{n+1} g)/(n+1)
      return TWO_PI * m.Imax * (1 - Math.pow(c, m.n + 1)) / (m.n + 1);
    }
    return m.Imax * Math.min(solidAngle(g), m.omegaHalf);
  }

  /* ---------------------------------------------------------
   * 四、照度
   * ------------------------------------------------------- */

  /**
   * 点光源 + 距离平方反比 + 余弦定律
   *   d = √(h² + r²)，  cos γ = h/d
   *   E = I(γ)·cos γ / d²
   * cos^n 配光时代入 cos γ = h/d 可化简为
   *   E(r) = I_max · h^(n+1) / (h² + r²)^((n+3)/2)
   */
  function illuminance(m, h, r) {
    var d2 = h * h + r * r;
    var d = Math.sqrt(d2);
    var cosg = h / d;
    var g = Math.acos(cosg < -1 ? -1 : (cosg > 1 ? 1 : cosg));
    return intensity(m, g) * cosg / d2;
  }

  /** 仅用平方反比、忽略入射余弦的"简化式" E = I/d²（用于对比） */
  function illuminanceNoCos(m, h, r) {
    var d2 = h * h + r * r;
    var d = Math.sqrt(d2);
    var cosg = h / d;
    var g = Math.acos(cosg < -1 ? -1 : (cosg > 1 ? 1 : cosg));
    return intensity(m, g) / d2;
  }

  /** 严格式相对简化式的比值 = cos γ （恒 ≤ 1） */
  function cosineFactor(h, r) {
    return h / Math.sqrt(h * h + r * r);
  }

  /** 过光轴的平面内，光斑几何半径（m）：R = h·tan(γ) */
  function spotRadius(h, gammaRad) {
    return h * Math.tan(gammaRad);
  }

  /* ---------------------------------------------------------
   * 五、径向剖面（查表 + 线性插值，用于画图与快速积分）
   * ------------------------------------------------------- */

  function makeProfile(m, h, rMax, N) {
    N = N || 1200;
    var pts = new Array(N + 1);
    for (var i = 0; i <= N; i++) {
      var r = rMax * i / N;
      pts[i] = illuminance(m, h, r);
    }
    return { E: pts, rMax: rMax, N: N };
  }

  function sampleProfile(prof, r) {
    var t = Math.abs(r) / prof.rMax * prof.N;
    if (t >= prof.N) return prof.E[prof.N];
    var i = Math.floor(t);
    var f = t - i;
    return prof.E[i] * (1 - f) + prof.E[i + 1] * f;
  }

  /* ---------------------------------------------------------
   * 六、被照面分析
   * ------------------------------------------------------- */

  /** 矩形面（中心在光轴正下方）接收的光通量，数值积分 */
  function integrateRectFlux(m, h, L, W, N) {
    N = N || 200;
    var rMax = 0.75 * Math.hypot(L, W);
    if (!(rMax > 0)) return 0;
    var prof = makeProfile(m, h, rMax, 800);
    var dA = (L / N) * (W / N);
    var sum = 0;
    for (var i = 0; i < N; i++) {
      var x = -L / 2 + (i + 0.5) * (L / N);
      for (var j = 0; j < N; j++) {
        var y = -W / 2 + (j + 0.5) * (W / N);
        sum += sampleProfile(prof, Math.hypot(x, y));
      }
    }
    return sum * dA;
  }

  /**
   * 被照面统计
   * shape = { type:'circle', R } | { type:'rect', L, W }
   * 假定被照面水平、且其中心位于灯具光轴正下方（灯具垂直向下照射）
   */
  function analyze(m, h, shape) {
    var area, rFar, fluxOnArea;

    if (shape.type === 'rect') {
      area = shape.L * shape.W;
      rFar = Math.hypot(shape.L / 2, shape.W / 2);
      fluxOnArea = integrateRectFlux(m, h, shape.L, shape.W);
    } else {
      area = Math.PI * shape.R * shape.R;
      rFar = shape.R;
      // 圆盘张开的半顶角 γ_R，锥内光通量即落在圆盘上的光通量
      fluxOnArea = fluxInCone(m, Math.atan2(shape.R, h));
    }

    var Emax = illuminance(m, h, 0);
    var Emin = illuminance(m, h, rFar);      // E(r) 单调递减，最远点即最暗点
    var Eavg = fluxOnArea / area;

    return {
      area: area,
      rFar: rFar,
      gammaFar: Math.atan2(rFar, h),
      distanceFar: Math.sqrt(h * h + rFar * rFar),
      fluxOnArea: fluxOnArea,
      Emax: Emax,
      Emin: Emin,
      Eavg: Eavg,
      Umax: Emax > 0 ? Emin / Emax : 0,      // 均匀度 E_min/E_max
      Uavg: Eavg > 0 ? Emin / Eavg : 0,      // 均匀度 E_min/E_avg
      utilization: m.flux > 0 ? fluxOnArea / m.flux : 0   // 光通量利用率
    };
  }

  /* ---------------------------------------------------------
   * 七、导出
   * ------------------------------------------------------- */
  global.Optics = {
    DEG: DEG, RAD: RAD,
    FULL_SPHERE: FULL_SPHERE, HEMISPHERE: HEMISPHERE,
    solidAngle: solidAngle,
    exponentFromHalfAngle: exponentFromHalfAngle,
    angleAtFraction: angleAtFraction,
    buildModel: buildModel,
    intensity: intensity,
    fluxInCone: fluxInCone,
    illuminance: illuminance,
    illuminanceNoCos: illuminanceNoCos,
    cosineFactor: cosineFactor,
    spotRadius: spotRadius,
    makeProfile: makeProfile,
    sampleProfile: sampleProfile,
    integrateRectFlux: integrateRectFlux,
    analyze: analyze
  };

})(window);
