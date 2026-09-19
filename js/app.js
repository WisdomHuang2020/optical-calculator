/* ============================================================
 * app.js — 界面逻辑与渲染
 * ============================================================ */
(function () {
  'use strict';

  var O = window.Optics;
  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel) { return document.querySelector(sel); };

  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : NaN; }
  function radioVal(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  /* ---------- 数字格式 ---------- */
  function fnum(v, d) {
    if (!isFinite(v)) return '—';
    if (d === undefined) {
      var a = Math.abs(v);
      d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
    }
    return v.toFixed(d);
  }
  function fint(v) { return isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—'; }
  function fpct(v, d) { return isFinite(v) ? (v * 100).toFixed(d === undefined ? 1 : d) + '%' : '—'; }
  function fdeg(rad, d) { return fnum(rad * O.RAD, d === undefined ? 2 : d); }

  function setText(id, txt) { var e = $(id); if (e) e.textContent = txt; }

  /* =========================================================
   * 一、照度计算
   * ========================================================= */

  function readInputs() {
    // 光束角按行业惯例接收「半光强全角 2θ½」（数据手册上的写法），
    // 内部统一换算为半角 θ½ 参与计算。
    // 字段分工：beam 存全角（用于回显用户原输入），gammaHalfDeg 存半角（计算用）。
    var beamFull = num('beam');
    var gh = beamFull / 2;
    var itxt = $('imax').value.trim();
    return {
      model: $('model').value,
      flux: num('flux'),
      centerIntensity: itxt === '' ? null : parseFloat(itxt),
      beam: beamFull,
      gammaHalfDeg: gh,
      h: num('height'),
      shapeType: radioVal('shape'),
      R: num('radius'),
      L: num('len'),
      W: num('wid')
    };
  }

  /* ---- 被照面半径 R：默认跟随半光强光斑半径 h·tan θ½ ----
     用户要求改 h 就自动联动，不必再点一次「按半光强光斑填充」。
     但若用户手动改过 R，就不能悄悄覆盖他的输入 —— 用「当前值是否仍等于
     上次自动算出的值」判定他有没有动过。点「恢复默认」回到跟随态。 */
  var lastAutoR = null;
  function syncRadiusFromSpot() {
    var h = num('height'), beam = num('beam');
    if (!(h > 0) || !(beam > 0)) return;
    var R = O.spotRadius(h, (beam / 2) * O.DEG);
    if (!isFinite(R) || R <= 0) return;
    var cur = parseFloat($('radius').value);
    // 容差取半个末位（写回时 toFixed(3) 会截断）
    var untouched = (lastAutoR === null) || Math.abs(cur - lastAutoR) < 5e-4;
    if (untouched) {
      lastAutoR = R;
      $('radius').value = R.toFixed(3);
    }
  }

  var curModel = null;
  var renderErrors = [];

  /* 单个渲染环节失败不应中断整条链路（历史缺陷：色标渐变越界抛错，
     连带把后面的剖面表一起吞掉）。这里逐段隔离，失败也要留下可见痕迹。 */
  function safeRender(name, fn) {
    try { fn(); }
    catch (e) {
      renderErrors.push(name + '：' + (e && e.message ? e.message : String(e)));
      if (window.console && console.error) console.error('[光学工具] ' + name + ' 渲染失败：', e);
    }
  }

  function recompute() {
    // 先同步被照面半径（改 h 或光束角时自动跟随半光强光斑半径），再读输入 ——
    // 否则本轮算的还是同步前的旧 R
    syncRadiusFromSpot();
    var inp = readInputs();
    renderErrors = [];

    // 等价半角实时显示（放在校验之前，输入过程中也能看到），
    // 让用户拿数据手册一眼对上是全角还是半角口径
    var g = inp.gammaHalfDeg;
    setText('beam-full', isFinite(g) && g > 0 ? g.toFixed(1) + '°' : '—');

    /* --- 校验 --- */
    var warn = [];
    if (!(inp.flux > 0)) warn.push('光通量需大于 0');
    if (!(inp.gammaHalfDeg > 0.5) || !(inp.gammaHalfDeg < 89.5)) warn.push('光束角 2θ½ 需在 1° ~ 179°');
    if (!(inp.h > 0)) warn.push('垂直距离需大于 0');
    if (inp.shapeType === 'circle' && !(inp.R > 0)) warn.push('半径需大于 0');
    if (inp.shapeType === 'rect' && (!(inp.L > 0) || !(inp.W > 0))) warn.push('矩形长宽需大于 0');
    if (warn.length) {
      $('calc-warn').innerHTML = '⚠ ' + warn.join('；');
      $('calc-warn').classList.remove('hidden');
      return;
    }
    $('calc-warn').classList.add('hidden');

    /* --- 建模型 --- */
    var m = O.buildModel({
      model: inp.model,
      flux: inp.flux,
      gammaHalfRad: inp.gammaHalfDeg * O.DEG,
      centerIntensity: inp.centerIntensity
    });
    curModel = m;

    var shape = inp.shapeType === 'rect'
      ? { type: 'rect', L: inp.L, W: inp.W }
      : { type: 'circle', R: inp.R };

    var res = O.analyze(m, inp.h, shape);

    /* --- 光斑半径 --- */
    var R50 = O.spotRadius(inp.h, m.gammaHalfRad);
    var R10;
    if (m.model === 'cosN') {
      R10 = O.spotRadius(inp.h, O.angleAtFraction(m.n, 0.10));
    } else {
      R10 = R50;   // 均匀锥配光：锥外无光，50% 边界即截止边界
    }

    /* ================= 统计卡片 ================= */
    setText('st-emax-v', fint(res.Emax));
    setText('st-emin-v', fint(res.Emin));
    setText('st-eavg-v', fint(res.Eavg));
    setText('st-uavg-v', fpct(res.Uavg, 1));
    setText('st-umax-v', fpct(res.Umax, 1));
    setText('st-util-v', fpct(res.utilization, 1));
    setText('st-emin-s', '距光轴 ' + fnum(res.rFar, 2) + ' m 处（最近点）');
    setText('st-eavg-s', '面域 ' + fnum(res.area, 3) + ' m² 上的平均');

    /* ================= 参数摘要 ================= */
    setText('sum-model', m.model === 'cosN' ? 'cosⁿ 余弦幂' : '均匀锥配光');
    setText('sum-n', m.model === 'cosN' ? fnum(m.n, 2) : '—');
    setText('sum-imax', fint(m.Imax));
    setText('sum-imaxsrc', m.ImaxSource === 'given' ? '用户输入' : '由 Φ 推导');

    var omHalf = m.omegaHalf;
    setText('sum-omega', fnum(omHalf, 4) + ' sr');
    setText('sum-omegapct', fpct(omHalf / O.FULL_SPHERE, 2) + ' × 4π');
    setText('sum-r50', fnum(R50, 3) + ' m');
    setText('sum-r10', fnum(R10, 3) + ' m');
    // 摘要标签为「半光强全角 2θ½」，故回显 2×半角
    setText('sum-ghalf', fnum(inp.gammaHalfDeg * 2, 2) + '°');

    // 光通量一致性
    var dev = m.ImaxSource === 'given' ? (m.fluxImplied / inp.flux - 1) : 0;
    setText('sum-fluxcheck', fint(m.fluxImplied) + ' lm');
    var chk = $('sum-fluxcheck');
    chk.style.color = Math.abs(dev) > 0.02 ? '#f87171' : '';   // 深色底上提亮

    var note = $('calc-note');
    if (m.ImaxSource === 'given' && Math.abs(dev) > 0.02) {
      note.className = 'note warn';
      note.innerHTML = '<b>参数自相矛盾：</b>你输入的中心光强 I₀ = ' + fint(m.Imax) +
        ' cd，与「光通量 ' + fint(inp.flux) + ' lm + 光束角 ' + fnum(inp.beam, 1) +
        '°」在 ' + (m.model === 'cosN' ? 'cosⁿ 配光' : '均匀锥配光') + ' 模型下的理论值 ' +
        fint(m.ImaxDerived) + ' cd 相差 <b>' + fpct(Math.abs(m.ImaxDerived / m.Imax - 1), 1) +
        '</b>。上表照度按你输入的光强计算；等效总光通量为 ' + fint(m.fluxImplied) + ' lm。' +
        '建议核对灯具实际配光数据。';
    } else if (m.model === 'cosN') {
      note.className = 'note info';
      note.innerHTML = '<b>关于「I = Φ/Ω」：</b>用总光通量除以半光强锥立体角，得到的是 ' +
        fint(m.ImaxConeAverage) + ' cd，比峰值光强 ' + fint(m.Imax) + ' cd 高 <b>' +
        fpct(m.ImaxConeAverage / m.Imax - 1, 1) + '</b>。' +
        '这个数隐含"总光通量全部落在半光强锥内"的假设，而 cosⁿ 配光实际只有 ' +
        fpct(m.fluxInHalfCone / m.flux, 1) + ' 落在这个锥内，另外 ' +
        fpct(1 - m.fluxInHalfCone / m.flux, 1) + ' 分布在锥外。' +
        '该锥内的真实平均光强只有 ' + fint(m.coneAverageIntensity) + ' cd。' +
        '本工具按 cosⁿ 配光在全半球的积分求峰值（∫I dΩ 回算恰等于输入的 Φ），更接近实际。';
    } else {
      note.className = 'note warn';
      note.innerHTML = '<b>均匀锥配光是理想化模型</b>：锥内光强处处相等、锥外光通量为 0。' +
        '此时 I₀ = Φ/Ω（即参考图中的算法）严格成立，但它没有物理灯具符合——' +
        '真实配光在 50% 边界处是连续下降的。切到「cosⁿ 余弦幂」更接近实测。';
    }

    /* ================= 曲线 ================= */
    var chartRMax = Math.max(res.rFar, R50 * 1.4) * 1.12;
    var prof = O.makeProfile(m, inp.h, chartRMax, 320);
    var pts = prof.E.map(function (E, i) { return { r: prof.rMax * i / prof.N, E: E }; });

    safeRender('照度曲线', function () {
      window.Charts.drawCurve($('canvas-curve'), {
        pts: pts,
        rMax: chartRMax,
        Emax: res.Emax,
        Eavg: res.Eavg,
        Emin: res.Emin,
        rMin: res.rFar,
        r50: R50,
        r10: R10
      });
    });

    /* ================= 伪彩分布 ================= */
    safeRender('照度分布图', function () {
      window.Charts.drawHeatmap($('canvas-heat'), {
        model: m,
        h: inp.h,
        shape: shape,
        Emax: res.Emax,
        r50: R50,
        profile: null
      });
    });

    /* ================= 剖面表 ================= */
    safeRender('剖面数据表', function () {
      var rows = 11;
      var html = '';
      for (var i = 0; i <= rows; i++) {
        var r = res.rFar * i / rows;
        var d = Math.sqrt(inp.h * inp.h + r * r);
        var cosg = inp.h / d;
        var g = Math.acos(cosg);
        var I = O.intensity(m, g);
        var E = O.illuminance(m, inp.h, r);
        var Es = O.illuminanceNoCos(m, inp.h, r);
        var isRim = (i === rows);
        html += '<tr class="' + (isRim ? 'hl' : '') + '">' +
          '<td>' + fnum(r, 3) + '</td>' +
          '<td>' + fdeg(g, 2) + '</td>' +
          '<td>' + fnum(d, 3) + '</td>' +
          '<td>' + fint(I) + '</td>' +
          '<td>' + fint(E) + '</td>' +
          '<td class="muted">' + fint(Es) + '</td>' +
          '<td>' + fpct(E / res.Emax, 1) + '</td>' +
          '</tr>';
      }
      $('tbody-profile').innerHTML = html;
    });

    setText('curve-caption',
      '径向剖面：h = ' + fnum(inp.h, 2) + ' m，半光强光斑 R½ = ' + fnum(R50, 3) +
      ' m，10% 光斑 R₁₀ = ' + fnum(R10, 3) + ' m。曲线已含 cosⁿ 配光衰减与距离平方反比。');

    /* 渲染异常汇总 */
    var rw = $('render-warn');
    if (renderErrors.length) {
      rw.className = 'note warn';
      rw.innerHTML = '<b>部分图形渲染失败</b>（数据表仍按严格式输出，可继续参考）：' +
        renderErrors.join('；');
    } else {
      rw.className = 'note warn hidden';
      rw.innerHTML = '';
    }
  }

  /* =========================================================
   * 二、立体角可视化
   * ========================================================= */

  var viz = null;
  var planarKey = null;   // 平面轴截面图的重绘缓存键

  function initSolid() {
    viz = new window.SolidAngleViz($('sa-canvas'), updateSolidReadout);
    window.__viz = viz;   // 调试句柄：便于在控制台/无头环境检查 W、H、yaw、show 等状态
    updateSolidReadout(viz);

    /* 滑块 */
    function bindSlider(id, valId, key, fmtFn) {
      var el = $(id), out = $(valId);
      function upd() {
        var v = parseFloat(el.value);
        viz.set(key, v * O.DEG);
        out.textContent = fmtFn ? fmtFn(v) : v + '°';
        var pct = (v - parseFloat(el.min)) / (parseFloat(el.max) - parseFloat(el.min)) * 100;
        el.style.setProperty('--pct', pct + '%');
        updateSolidReadout(viz);
      }
      el.addEventListener('input', upd);
      upd();
    }
    bindSlider('sa-theta', 'sa-theta-val', 'theta');
    bindSlider('sa-ring', 'sa-ring-val', 'ringAlpha');
    bindSlider('sa-ringw', 'sa-ringw-val', 'ringWidth',
      function (v) { return v.toFixed(1) + '°'; });
    bindSlider('sa-phi', 'sa-phi-val', 'phi0');
    bindSlider('sa-dphi', 'sa-dphi-val', 'dPhi');

    /* 开关 */
    function bindToggle(id, key) {
      var el = $(id);
      el.addEventListener('click', function () {
        var on = !el.classList.contains('on');
        el.classList.toggle('on', on);
        viz.set(key, on);
      });
      el.classList.toggle('on', viz.show.hasOwnProperty(key) ? viz.show[key] : viz.autoRotate);
    }
    bindToggle('tg-cap', 'cap');
    bindToggle('tg-ring', 'ring');
    bindToggle('tg-patch', 'patch');
    bindToggle('tg-cone', 'cone');
    bindToggle('tg-sphere', 'sphere');
    var rot = $('tg-rotate');
    rot.classList.add('on');
    rot.addEventListener('click', function () {
      var on = !rot.classList.contains('on');
      rot.classList.toggle('on', on);
      viz.set('autoRotate', on);
    });

    $('btn-sa-reset').addEventListener('click', function () {
      viz.yaw = -0.75; viz.pitch = -0.30;
    });

    $('btn-sa-sync').addEventListener('click', function () {
      var inp = readInputs();
      var gh = Math.max(0.5, Math.min(89, inp.gammaHalfDeg));
      $('sa-theta').value = gh;
      $('sa-theta').dispatchEvent(new Event('input'));
      // 环带放在球冠内部（0.55θ）、环宽取 θ 的 10%——与原文件 solid_angle_3d.html
      // 的 a1 = th*0.55 耦合一致，保证"球冠 = 若干环带拼成"在任何光束角下都成立
      var ring = Math.max(1, Math.min(89, gh * 0.55));
      var rw = Math.max(0.5, Math.min(20, gh * 0.10));
      $('sa-ring').value = ring.toFixed(1);
      $('sa-ring').dispatchEvent(new Event('input'));
      $('sa-ringw').value = rw.toFixed(1);
      $('sa-ringw').dispatchEvent(new Event('input'));
    });

    $('sa-flux').addEventListener('input', function () { updateSolidReadout(viz); });
  }

  function updateSolidReadout() {
    if (!viz) return;
    var th = viz.theta;
    var om = O.solidAngle(th);
    var pct = om / O.FULL_SPHERE;

    setText('sa-omega-v', om.toFixed(4));
    setText('sa-pct-v', (pct * 100).toFixed(2) + '%');
    var bar = $('sa-bar');
    if (bar) bar.style.width = Math.max(0.6, pct * 100) + '%';

    var flux = parseFloat($('sa-flux').value);
    if (!isFinite(flux) || flux <= 0) flux = 0;
    setText('sa-imax-v', flux > 0 ? fint(flux / om) : '—');
    setText('sa-theta-deg', (th * O.RAD).toFixed(1) + '°');
    setText('sa-alpha-deg', (viz.ringAlpha * O.RAD).toFixed(1) + '°');
    setText('sa-dalpha-deg', (viz.ringWidth * O.RAD).toFixed(1) + '°');

    // 微圆环自身的立体角（用于验证 dΩ = 2π sinα dα）
    var a0 = viz.ringAlpha, w = viz.ringWidth;
    var dOmegaExact = O.solidAngle(a0 + w / 2) - O.solidAngle(Math.max(0, a0 - w / 2));
    var dOmegaApprox = 2 * Math.PI * Math.sin(a0) * w;
    setText('sa-domega-exact', dOmegaExact.toFixed(5));
    setText('sa-domega-approx', dOmegaApprox.toFixed(5));
    setText('sa-domega-err', dOmegaExact > 0
      ? ((dOmegaApprox / dOmegaExact - 1) * 100).toFixed(2) + '%' : '—');

    /* ---- 推导过程的实时数值 ---- */
    var sinA = Math.sin(a0);
    setText('dv-sin', sinA.toFixed(4));
    setText('dv-circ', (2 * Math.PI * sinA).toFixed(4));
    setText('dv-da', w.toFixed(4));
    setText('dv-dA', (2 * Math.PI * sinA * w).toFixed(5));      // r = 1 归一化
    setText('dv-dOm', (2 * Math.PI * sinA * w).toFixed(5));
    setText('dv-theta', (th * O.RAD).toFixed(1));
    setText('dv-omega', om.toFixed(5));
    setText('dv-pct', (pct * 100).toFixed(2) + '%');
    setText('dv-exact', dOmegaExact.toFixed(5));
    setText('dv-approx', dOmegaApprox.toFixed(5));
    setText('dv-err', dOmegaExact > 0
      ? ((dOmegaApprox / dOmegaExact - 1) * 100).toFixed(2) + '%' : '—');

    /* ---- 推导过程 · 球面微元二重积分 的实时数值 ---- */
    var dp = viz.dPhi, p0 = viz.phi0;
    var dTheta = w;                       // dθ = dα

    // 微元的真实角跨度（与 solidangle.js 的 _drawPatch 保持一致：以 α 为中心，
    // 靠极点时会被裁到 0）。裁剪后区间中点不再是 α，故一律用真实中点。
    var t1 = Math.max(0, a0 - dTheta / 2);
    var t2 = Math.min(Math.PI, a0 + dTheta / 2);
    var aMid = (t1 + t2) / 2;
    var sinMid = Math.sin(aMid);
    var dThetaReal = t2 - t1;

    // 精确闭式：Ω = Δφ·(cosθ₁ − cosθ₂)
    var dOmPatchExact = (Math.cos(t1) - Math.cos(t2)) * dp;
    // 微分近似：sinθ·dθ·dφ，θ 取区间中点 → 二阶精度
    var dOmPatchApprox = sinMid * dThetaReal * dp;

    // 注意：这里的 cos 是「锥半顶角 θₘ」的余弦，供 Ω = 2π(1 − cosθₘ) 使用，
    // 与微元所在极角 α 无关。早先把二者混用导致算式自相矛盾。
    var cosTh = Math.cos(th);

    setText('dq-sin', sinMid.toFixed(4));
    setText('dq-a', dThetaReal.toFixed(4));                     // R=1 归一化
    setText('dq-b', (sinMid * dp).toFixed(4));
    setText('dq-dA', dOmPatchApprox.toFixed(6));
    setText('dq-dOm', dOmPatchApprox.toFixed(6));
    setText('dq-dOm2', dOmPatchApprox.toFixed(6));
    setText('dq-exact', dOmPatchExact.toFixed(6));
    setText('dq-err', dOmPatchExact > 0
      ? ((dOmPatchApprox / dOmPatchExact - 1) * 100).toFixed(2) + '%' : '—');
    setText('dq-theta', (th * O.RAD).toFixed(1));
    setText('dq-cos', cosTh.toFixed(5));
    setText('dq-cos2', cosTh.toFixed(5));
    setText('dq-omega', om.toFixed(5));
    setText('dq-pct', (pct * 100).toFixed(2) + '%');

    /* 微元放大图：图中微元有最小可辨识尺寸的下限，数值仍按真实 dθ 计算，
       两者不一致时必须明说，不能让图与数打架 */
    var dtDraw = Math.max(w, 5 * O.DEG);
    var dpDraw = Math.max(dp, 10 * O.DEG);
    setText('patch-caption',
      (dtDraw > w + 1e-9 || dpDraw > dp + 1e-9)
        ? '⚠ 当前 dθ / dφ 过小，图中微元已放大到最小可辨识尺寸显示；'
          + '上方所有数值仍按真实 dθ = ' + (w * O.RAD).toFixed(1) + '°、dφ = '
          + (dp * O.RAD).toFixed(1) + '° 计算。'
        : '');

    /* ---- 微元方块放大图 + 平面轴截面图：仅在参数变化时重绘 ---- */
    if (window.Planar) {
      var key = th.toFixed(6) + '|' + a0.toFixed(6) + '|' + w.toFixed(6) +
                '|' + p0.toFixed(6) + '|' + dp.toFixed(6);
      if (key !== planarKey) {
        var ok1 = window.Planar.drawCrossSection($('planar-canvas'), {
          theta: th, alpha: a0, dAlpha: w, omega: om, dOmega: dOmegaExact
        });
        var ok2 = window.Planar.drawPatchZoom($('patch-canvas'), {
          alpha: a0, phi0: p0, dAlpha: w, dPhi: dp
        });
        // 画布隐藏（尺寸为 0）时不更新缓存，切回来会重画
        if (ok1 && ok2) planarKey = key;
      }
    }
  }

  /* =========================================================
   * 三、交互绑定
   * ========================================================= */

  function bindCalc() {
    var auto = ['model', 'flux', 'imax', 'beam', 'height', 'radius', 'len', 'wid'];
    auto.forEach(function (id) {
      $(id).addEventListener('input', recompute);
      $(id).addEventListener('change', recompute);
    });
    document.querySelectorAll('input[name="shape"]').forEach(function (el) {
      el.addEventListener('change', function () {
        $('field-R').classList.toggle('hidden', radioVal('shape') !== 'circle');
        $('field-rect').classList.toggle('hidden', radioVal('shape') !== 'rect');
        recompute();
      });
    });

    // 原先的「按半光强光斑填充」按钮已移除：半径 R 现在由 syncRadiusFromSpot()
    // 在每次重算时自动跟随 h 与光束角（见该函数注释）。

    $('btn-reset-calc').addEventListener('click', function (e) {
      e.preventDefault();
      $('model').value = 'cosN';
      $('flux').value = 9000;
      $('imax').value = '';
      $('beam').value = 38;          // 半光强全角 2θ½（等价半角 θ½ = 19°）
      $('height').value = 3;
      document.querySelector('input[name="shape"][value="circle"]').checked = true;
      lastAutoR = null;              // 回到自动跟随态
      $('radius').value = '';        // 留空，交给 syncRadiusFromSpot() 重算
      $('len').value = '1.2';
      $('wid').value = '0.6';
      $('field-R').classList.remove('hidden');
      $('field-rect').classList.add('hidden');
      recompute();
    });
  }

  function activateTab(name) {
    var t = document.querySelector('.tab[data-tab="' + name + '"]');
    if (!t) return false;
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
    document.querySelectorAll('.view').forEach(function (x) { x.classList.remove('active'); });
    t.classList.add('active');
    var v = $('view-' + name);
    if (v) v.classList.add('active');
    /* 页脚按当前页切换内容。原来只有一份全局文案（光度学公式 + DIALux 复核），
       在棱镜三页上完全不适用 —— 同一份备注不该照搬到讲棱镜的页面上。 */
    document.querySelectorAll('.footer .fset').forEach(function (f) {
      var list = (f.getAttribute('data-for') || '').split(/\s+/);
      f.classList.toggle('active', list.indexOf(name) >= 0);
    });
    if (name === 'prism' && window.Prism) {
      // 棱镜视图的 WebGL 必须在容器可见且有尺寸后再初始化：
      // 首次进入时 init()，之后只是 resize + 重绘。
      // 原 MLA_Prism.html 在容器未布局时初始化，实测画布高度停在 20px。
      window.Prism.init();
      window.Prism.resize();
      /* 光学性能预估（重计算，故只算一次，之后由用户点按钮更新） */
      if (window.PrismPerf) window.PrismPerf.init();
    }
    if (name === 'solid' && viz) {
      // 同步重绘，不只依赖 rAF（rAF 在后台标签/无头环境会被节流，
      // 会出现切回立体角页却看到空白画布）
      viz.resize();
      viz.draw();
      planarKey = null;          // 平面图在隐藏时尺寸为 0，切回来强制重画
      updateSolidReadout(viz);
    }
    /* 棱镜知识页（第 5 / 6 个 tab）：三个光线追迹演示都是 2D canvas。
       同样必须在容器可见后再绘制 —— 隐藏时量到的画布尺寸是 0，
       画出来的内容会全部错位。首次进入时初始化，之后每次进入重绘
       （「材料与参考」的校核清单要读棱镜工具的最新参数）。 */
    if ((name === 'know' || name === 'mats') && window.PrismKnowledge) {
      window.PrismKnowledge.init();
      window.PrismKnowledge.resize();
    }
    return true;
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        activateTab(t.dataset.tab);
        if (window.history && history.replaceState) {
          history.replaceState(null, '', '#' + t.dataset.tab);
        }
      });
    });
  }

  /** 支持深链：#calc / #solid / #theory / #prism / #know / #mats */
  function applyHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    if (h === 'calc' || h === 'solid' || h === 'theory' || h === 'prism' ||
        h === 'know' || h === 'mats') activateTab(h);
  }

  /* =========================================================
   * 启动
   * ========================================================= */
  function boot() {
    // 版本号由 js/version.js 单一来源注入。
    // 用 class 钩子而非 id：页面上有多个显示点（页头徽标 + 页脚），
    // 写死 id 只能注入一处，将来再加一处又会漏。
    var verTxt = window.APP_VERSION || 'v—';
    document.querySelectorAll('.app-version').forEach(function (el) {
      el.textContent = verTxt;
    });
    bindTabs();
    bindCalc();
    initSolid();
    $('sa-flux').value = 9000;
    recompute();
    updateSolidReadout(viz);
    applyHash();

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        recompute();
        if (window.Prism) window.Prism.resize();
      }, 160);
    });
    window.addEventListener('hashchange', applyHash);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
