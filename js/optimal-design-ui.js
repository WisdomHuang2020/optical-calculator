/* ============================================================
 * optimal-design-ui.js —— 「最优设计方法」页的交互与绘图
 * 依赖：js/optimal-design.js（模型内核，先于本文件加载）
 * 本文件只做 DOM 与 Canvas 渲染，物理全在内核里。
 * ============================================================ */
(function () {
  'use strict';
  var D = window.OptimalDesign;
  if (!D) return;

  var $ = function (id) { return document.getElementById(id); };
  var COLORS = {
    pyramid: '#4f8cff', frustum: '#36c2a8', hexpyr: '#9b6bff',
    cone: '#f0a23b', sphere: '#e0567a', parabola: '#5bc0eb'
  };
  function shapeColor(id) { return COLORS[id] || '#888'; }
  function shapeLabel(id) { return (D.SHAPES[id] || {}).label || id; }
  function pct(x, d) { return (100 * x).toFixed(d === undefined ? 1 : d) + '%'; }
  function css(name, dflt) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) ? v.trim() : dflt;
  }
  function setPct(el) {
    if (!el) return;
    var lo = parseFloat(el.min), hi = parseFloat(el.max), v = parseFloat(el.value);
    el.style.setProperty('--pct', ((hi > lo) ? (v - lo) / (hi - lo) * 100 : 0).toFixed(1) + '%');
  }

  /* ------------------------------------------------------------
   * 输入读取
   * ------------------------------------------------------------ */
  var state = { mat: 'pmma', fieldView: 'opt', last: null, baseline: null };

  function readOpts() {
    var N = parseInt($('od_n').value, 10);
    var T = parseFloat($('od_t').value);
    return {
      targetU: parseFloat($('od_u').value) / 100,
      targetEta: parseFloat($('od_e').value) / 100,
      thetaV: parseFloat($('od_tv').value),
      budget: parseFloat($('od_budget').value),
      uDef: $('od_udef').value,
      srcModel: $('od_src').value,
      wallRho: parseFloat($('od_rho').value) / 100,
      prefer: $('od_prefer').value,
      noHotspot: $('od_hotspot').checked,
      material: state.mat === 'auto' ? null : state.mat,
      fixN: N > 0 ? N : 0,
      fixT: T > 0 ? T : 0,
      W: D.GEO.panelW, H: D.GEO.panelH
    };
  }

  /* ------------------------------------------------------------
   * 控件初始化
   * ------------------------------------------------------------ */
  function initMatPicker() {
    var box = $('od_matpick');
    if (!box) return;
    var html = '<div class="opt-matrow">';
    html += '<button class="matcard" data-mat="auto"><span class="mc-lab">自动</span>' +
      '<span class="mc-sub">让优化器在三种材料里挑</span></button>';
    D.MAT_IDS.forEach(function (id) {
      var M = D.MATERIALS[id];
      html += '<button class="matcard" data-mat="' + id + '">' +
        '<span class="mc-lab">' + M.label + '</span>' +
        '<span class="mc-sub">n=' + M.n + ' · T<sub>sub</sub>=' + (M.Tsub * 100).toFixed(0) + '%</span>' +
        '<span class="mc-sub">雾度上限 ' + (M.hazeMax * 100).toFixed(0) + '% · 单价×' + M.unitCost.toFixed(2) + '</span>' +
        '</button>';
    });
    html += '</div>';
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.matcard'), function (btn) {
      btn.addEventListener('click', function () {
        state.mat = btn.getAttribute('data-mat');
        Array.prototype.forEach.call(box.querySelectorAll('.matcard'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        renderMatDetail();
        schedule();
      });
      if (btn.getAttribute('data-mat') === state.mat) btn.classList.add('active');
    });
  }

  function renderMatDetail() {
    var box = $('od_mat_detail');
    if (!box) return;
    if (state.mat === 'auto') {
      var rows = D.MAT_IDS.map(function (id) {
        var M = D.MATERIALS[id];
        return '<tr><td>' + M.label + '</td><td>n=' + M.n + '</td><td>T<sub>sub</sub> ' + (M.Tsub * 100).toFixed(0) +
          '%</td><td>' + M.flame + '</td><td>×' + M.unitCost.toFixed(2) + '</td></tr>';
      }).join('');
      box.innerHTML = '<p class="opt-p">三种材料的<b>代表值</b>如下（公开数据表的常见区间，非某个牌号的保证值）。' +
        '选「自动」时，优化器会在三种材料里一起扫，按效率 / 成本 / 约束挑。</p>' +
        '<table class="opt-tbl"><thead><tr><th>材料</th><th>折射率</th><th>本体透过率</th><th>阻燃</th><th>单价指数</th></tr></thead><tbody>' +
        rows + '</tbody></table>';
      return;
    }
    var M = D.MATERIALS[state.mat];
    box.innerHTML =
      '<p class="opt-p"><b>' + M.full + '</b>　n=' + M.n + '（λ=589nm）、本体透过率 T<sub>sub</sub>=' +
      (M.Tsub * 100).toFixed(1) + '%、可量产雾度上限 ' + (M.hazeMax * 100).toFixed(0) + '%、密度 ' +
      M.density + ' g/cm³、单价指数 ×' + M.unitCost.toFixed(2) + '。</p>' +
      '<p class="opt-p"><b>耐候：</b>' + M.uv + '　<b>阻燃：</b>' + M.flame + '<br><b>加工：</b>' + M.work + '</p>' +
      '<div class="opt-pros"><div><h4>优势</h4><ul>' + M.pros.map(function (s) { return '<li>' + s + '</li>'; }).join('') +
      '</ul></div><div><h4>代价</h4><ul>' + M.cons.map(function (s) { return '<li>' + s + '</li>'; }).join('') +
      '</ul></div></div>' +
      '<p class="opt-p"><b>适用：</b>' + M.scene + '</p>';
  }

  function initSelects() {
    var ud = $('od_udef');
    if (ud) {
      ud.innerHTML = Object.keys(D.U_DEF_LABEL).map(function (k) {
        return '<option value="' + k + '">' + D.U_DEF_LABEL[k] + '</option>';
      }).join('');
      ud.value = 'active';
    }
    var src = $('od_src');
    if (src) {
      src.innerHTML = D.SRC_IDS.map(function (k) {
        var S = D.SOURCE_MODELS[k];
        return '<option value="' + k + '">' + S.label + '（足迹指数 p=' + S.p + '）</option>';
      }).join('');
      src.value = 'wide';
    }
  }

  /* ------------------------------------------------------------
   * 求解与渲染
   * ------------------------------------------------------------ */
  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 260);
  }

  function run() {
    var opts = readOpts();
    var btn = $('od_btn');
    if (btn) { btn.disabled = true; btn.textContent = '求解中…'; }
    setTimeout(function () {
      var t0 = Date.now();
      var r = D.optimize(opts);
      state.last = r;
      /* 高精度场只给最终方案算一次 */
      if (r.chosen) {
        r.chosen.field = D.buildField({
          OD: r.chosen.OD, N: r.chosen.N, W: opts.W, H: opts.H,
          res: 168, wallRho: opts.wallRho, srcModel: opts.srcModel
        });
        state.baseline = baselineOf(r.chosen, opts);
      }
      render(r, opts);
      var ms = Date.now() - t0;
      var meta = $('od_meta');
      if (meta) meta.textContent = '扫描 ' + r.count + ' 组候选（重建空间场 ' + r.fieldCount +
        ' 次，其余命中缓存），耗时 ' + ms.toFixed(0) + ' ms；' + opts.W + '×' + opts.H + ' mm 发光面。';
      if (btn) { btn.disabled = false; btn.textContent = '求解最优组合'; }
    }, 30);
  }

  /* 低配基线：同厚度预算下的老做法（6×6 阵列、低雾度） */
  function baselineOf(ch, opts) {
    var N = 6;
    var OD = Math.max(3, opts.budget - ch.tDiff - D.GEO.plateBase - D.GEO.prismH);
    return D.predict({
      mat: ch.mat, Hd: 0.35, tDiff: ch.tDiff, OD: OD, N: N, srcModel: ch.srcModel,
      shape: ch.shape, alpha: ch.alpha
    }, {
      W: opts.W, H: opts.H, thetaV: opts.thetaV, uDef: opts.uDef,
      wallRho: opts.wallRho, fieldRes: 168, srcModel: ch.srcModel
    });
  }

  function render(r, opts) {
    renderVerdict(r, opts);
    renderResultTable(r, opts);
    renderField(r, opts);
    renderSlice(r, opts);
    renderAngular(r, opts);
    renderScatter(r, opts);
    renderChecks(r, opts);
    renderMatCompare(opts);
    renderSensitivity(r, opts);
  }

  function renderVerdict(r, opts) {
    var v = $('od_verdict');
    if (!v) return;
    if (!r.chosen) {
      v.textContent = '当前约束下没有任何候选可用（连硬约束都过不了）。放宽厚度预算或降低目标再试。';
      v.className = 'perf-verdict warn';
      return;
    }
    if (r.feasible) {
      /* 硬约束在常规预算下几乎全部通过（超预算 / 超刀具角 / 低填充 / 雾度超基材
         上限这几条本来就筛不掉多少），此时说「过硬约束 N 组」等于没说，改成
         如实描述筛了什么。 */
      var poolTxt;
      if (r.hardEmpty) {
        poolTxt = '<b>没有任何候选能过硬约束</b>（已放宽到全部 ' + r.count + ' 组里取最接近的，' +
                  '下方约束表会标红具体哪一条不满足）';
      } else if (r.hardAll) {
        poolTxt = '扫过 ' + r.count + ' 组候选（已剔除超预算、超刀具角、填充率<70%、雾度超基材上限的组合）';
      } else {
        poolTxt = '过硬约束的组合 ' + r.hardCount + ' / ' + r.count + ' 组';
      }
      v.innerHTML = '✅ <b>双目标可同时满足</b>：' + poolTxt + '，其中双目标达标 ' +
        r.feasibleCount + ' 组；已按「' + preferName(opts.prefer) + '」选出最优组合。';
      v.className = 'perf-verdict ok';
    } else {
      var d = r.diag || {};
      var hint = [];
      if (d.uShort > 0.005) hint.push('U 最多还差 ' + (d.uShort * 100).toFixed(1) + ' 个百分点 → 加厚度（换 OD）或加密 LED 阵列');
      if (d.eShort > 0.005) hint.push('η 最多还差 ' + (d.eShort * 100).toFixed(1) + ' 个百分点 → 提覆盖率 / 把 α 做锐 / 换更高本体透过率的材料');
      v.innerHTML = '⚠️ <b>双目标在当前预算下不可同时满足</b>（可达上界 U≤' + pct(d.maxU || 0) +
        '、η≤' + pct(d.maxEta || 0) + '）。已退到 Pareto 最近点。<br>' +
        (hint.length ? hint.join('；<br>') : '放宽目标或厚度预算。');
      v.className = 'perf-verdict warn';
    }
  }
  function preferName(p) {
    return p === 'cost' ? '成本优先' : (p === 'margin' ? '性能余量优先' : '均衡');
  }

  function renderResultTable(r, opts) {
    var tb = $('od_out_tbl');
    if (!tb) return;
    var c = r.chosen;
    var body = tb.querySelector('tbody');
    if (!c) { body.innerHTML = '<tr><td colspan="3">无可用方案</td></tr>'; return; }
    var M = D.MATERIALS[c.mat];
    var rows = [
      ['扩散板材料', M.full, 'n=' + M.n + '，本体透过率 ' + (M.Tsub * 100).toFixed(1) + '%，' + M.flame],
      ['透过率 T<sub>d</sub>', pct(c.Td), 'T<sub>sub</sub>·(1−0.085·H<sub>d</sub><sup>1.4</sup>)，高雾基本不掉透过'],
      ['雾度 H<sub>d</sub>', pct(c.Hd, 0), '散射光学厚度 τ = −ln(1−H<sub>d</sub>) = ' + c.tau.toFixed(2) +
        '，散射半角 ' + c.scatter.toFixed(0) + '°，板内横向展宽 ' + c.sigmaS.toFixed(2) + ' mm'],
      ['扩散板厚度 t', c.tDiff.toFixed(1) + ' mm', '越厚越能压细结构，但挤占 OD'],
      ['棱镜形状', shapeLabel(c.shape) + '（' + c.shape + '）', D.SHAPES[c.shape].axis],
      ['关键角度 α', c.alpha + '°', '深宽比 h/b = ' + c.aspect.toFixed(2) + '，收敛半角 β ≈ ' + c.beta.toFixed(0) + '°'],
      ['阵列覆盖率', pct(c.cov, 0), '平台（尖端/谷底复制圆角）' + pct(1 - c.cov, 0) + '，是漏光通道'],
      ['LED 阵列', c.N + ' × ' + c.N + '（' + (c.N * c.N) + ' 颗）', '灯距 ' + (opts.W / c.N).toFixed(0) + ' mm，OD/p = ' +
        (c.OD / (opts.W / c.N)).toFixed(2)],
      ['混光距离 OD', c.OD.toFixed(1) + ' mm', '= 预算 ' + opts.budget.toFixed(0) + ' − 扩 ' + c.tDiff.toFixed(1) +
        ' − 基 ' + D.GEO.plateBase + ' − 棱镜 ' + D.GEO.prismH],
      ['整机光学厚度', c.totalThickness.toFixed(1) + ' mm', '预算 ' + opts.budget.toFixed(0) + ' mm'],
      ['发光面均匀度 U', pct(c.U), '口径：' + D.U_DEF_LABEL[opts.uDef] + '；残余对比 ' + pct(c.ripple) +
        '（其中板面细结构 ' + pct(c.rippleFine || 0) + '，余量即灯阵纹波）'],
      ['出光效率 η', pct(c.eta), '= T<sub>d</sub> ' + pct(c.Td) + ' × η<sub>plate</sub> ' + pct(c.etaPlate) +
        ' × φ<sub>conf</sub> ' + pct(c.confine)],
      ['锥内占比 C', pct(c.C), '±' + opts.thetaV + '° 锥内 / 半球'],
      ['锥内出光效率', pct(c.etaCone), 'η × C，按观看锥考核时用这个'],
      ['对照：无棱镜', pct(c.flatRef.eta), '同雾度纯扩散板；<b>棱镜增益 ×' + c.gain.toFixed(2) + '</b>'],
      ['成本指数', c.cost.toFixed(0), '相对量，含 LED 数 / 材料 / 模具 / 雾度配方 / 厚度']
    ];
    body.innerHTML = rows.map(function (row) {
      return '<tr><td>' + row[0] + '</td><td class="od-val">' + row[1] + '</td><td>' + row[2] + '</td></tr>';
    }).join('');
  }

  /* ------------------------------------------------------------
   * 发光面伪彩图
   * ------------------------------------------------------------ */
  var CMAP = [
    [0.00, 10, 8, 34], [0.14, 38, 20, 92], [0.29, 92, 30, 118],
    [0.44, 158, 48, 100], [0.59, 214, 92, 58], [0.74, 244, 164, 52],
    [0.89, 252, 224, 138], [1.00, 255, 255, 236]
  ];
  function cmap(t) {
    t = Math.max(0, Math.min(1, t));
    for (var i = 1; i < CMAP.length; i++) {
      if (t <= CMAP[i][0]) {
        var a = CMAP[i - 1], b = CMAP[i];
        var f = (t - a[0]) / (b[0] - a[0]);
        return [Math.round(a[1] + f * (b[1] - a[1])),
                Math.round(a[2] + f * (b[2] - a[2])),
                Math.round(a[3] + f * (b[3] - a[3]))];
      }
    }
    return [255, 255, 236];
  }

  var offCv = null;
  function renderField(r, opts) {
    var cv = $('od_field');
    if (!cv || !r.chosen) return;
    var useBase = state.fieldView === 'base';
    var src = useBase ? state.baseline : r.chosen;
    if (!src) return;
    var fld = src.field;
    var res = fld.res;
    if (!offCv || offCv.width !== res) {
      offCv = document.createElement('canvas');
      offCv.width = res; offCv.height = res;
    }
    var octx = offCv.getContext('2d');
    var img = octx.createImageData(res, res);
    /* 归一化到「相对均值的倍数」，色标上限 2.2×（再亮就裁掉，人眼对高光不敏感） */
    var st = D.uniformity(fld, src.fineVis || 0, opts.uDef, Math.min(18, 0.35 * (opts.W / src.N)));
    var mx = fld.max / fld.mean, mn = fld.min / fld.mean;
    var hi = 2.2;
    for (var i = 0; i < res * res; i++) {
      var t = (fld.grid[i] / fld.mean) / hi;
      var c = cmap(Math.max(0, Math.min(1, t)));
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);

    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offCv, 0, 0, W, H);

    /* 有效面（排除 5% 压边）虚线框 */
    var m = 0.05;
    ctx.strokeStyle = 'rgba(255,255,255,.65)';
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
    ctx.strokeRect(m * W, m * H, W * (1 - 2 * m), H * (1 - 2 * m));
    ctx.setLineDash([]);

    /* LED 位置 */
    var L = D.ledGrid(src.N, opts.W, opts.H);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    for (var q = 0; q < src.N; q++) {
      for (var w = 0; w < src.N; w++) {
        var px = L.xs[q] / opts.W * W, py = L.ys[w] / opts.H * H;
        ctx.beginPath(); ctx.arc(px, py, 2.1, 0, 6.283); ctx.fill();
      }
    }
    /* 取样点（点位法才画） */
    if (opts.uDef === 'nine' || opts.uDef === 'thirteen') {
      ctx.strokeStyle = 'rgba(80,255,220,.9)'; ctx.lineWidth = 1.4;
      var pts = D.SAMPLES ? D.SAMPLES[opts.uDef] : null;
      if (pts) pts.forEach(function (p) {
        ctx.strokeRect(p[0] * W - 3, p[1] * H - 3, 6, 6);
      });
    }
    var meta = $('od_field_meta');
    if (meta) {
      meta.innerHTML = (useBase ? '基线：' : '推荐：') +
        'min/mean/max = ' + mn.toFixed(2) + ' / 1.00 / ' + mx.toFixed(2) +
        '　U = ' + pct(st.U) + '　（' + src.N + '×' + src.N + '，Hd=' + src.Hd.toFixed(2) + '）';
    }
    drawBar(hi);
  }

  function drawBar(hi) {
    var cv = $('od_bar');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var g = ctx.createLinearGradient(0, H, 0, 0);
    for (var i = 0; i <= 20; i++) {
      var t = i / 20, c = cmap(t);
      g.addColorStop(t, 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')');
    }
    ctx.fillStyle = g; ctx.fillRect(0, 0, 18, H);
    ctx.fillStyle = css('--text-3', '#888');
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('2.2×均值', 22, 10);
    ctx.fillText('1.5', 22, H * 0.32);
    ctx.fillText('0.8', 22, H * 0.63);
    ctx.fillText('0.1', 22, H * 0.95);
    ctx.save();
    ctx.translate(W - 8, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText('相对峰值亮度', 0, 0);
    ctx.restore();
  }

  /* ------------------------------------------------------------
   * 中心剖面
   * ------------------------------------------------------------ */
  function renderSlice(r, opts) {
    var cv = $('od_slice');
    if (!cv || !r.chosen) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var padL = 42, padR = 12, padT = 12, padB = 26;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = css('--surface-2', '#fff'); ctx.fillRect(0, 0, W, H);
    var x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;

    var a = r.chosen.field, b = state.baseline ? state.baseline.field : null;
    var vmaxA = 0, vmaxB = 0;
    function rowOf(f) {
      var res = f.res, y = Math.floor(res / 2), out = [];
      for (var i = 0; i < res; i++) out.push(f.grid[y * res + i]);
      return out;
    }
    var ra = rowOf(a), rb = b ? rowOf(b) : null;
    ra.forEach(function (v) { if (v > vmaxA) vmaxA = v; });
    if (rb) rb.forEach(function (v) { if (v > vmaxB) vmaxB = v; });
    var hi = Math.max(vmaxA, vmaxB || 0) * 1.08;

    function py(v) { return y0 - (v / hi) * (y0 - y1); }
    function px(i, n) { return x0 + (i / (n - 1)) * (x1 - x0); }

    /* ±5% 可辨带（围绕推荐方案的均值） */
    var meanA = a.mean;
    ctx.fillStyle = 'rgba(120,140,180,.16)';
    ctx.fillRect(x0, py(meanA * 1.05), x1 - x0, Math.abs(py(meanA * 0.95) - py(meanA * 1.05)));
    ctx.strokeStyle = css('--border', '#ddd'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, py(meanA)); ctx.lineTo(x1, py(meanA)); ctx.stroke();

    /* 有效面范围 */
    ctx.strokeStyle = 'rgba(255,140,0,.45)'; ctx.setLineDash([4, 3]);
    [0.05, 0.95].forEach(function (f) {
      var x = x0 + f * (x1 - x0);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    });
    ctx.setLineDash([]);

    function drawLine(row, color, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.8;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      for (var i = 0; i < row.length; i++) {
        var X = px(i, row.length), Y = py(row[i]);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    if (rb) drawLine(rb, css('--text-3', '#999'), [5, 4]);
    drawLine(ra, css('--primary', '#2b6cff'));

    ctx.fillStyle = css('--text-3', '#888'); ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText((hi).toFixed(2), x0 - 6, y1 + 8);
    ctx.fillText('0', x0 - 6, y0);
    ctx.textAlign = 'center';
    ctx.fillText('发光面水平位置 →', (x0 + x1) / 2, H - 6);
    ctx.save(); ctx.translate(12, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('相对亮度', 0, 0); ctx.restore();

    /* 图例 */
    ctx.textAlign = 'left'; ctx.font = '10.5px sans-serif';
    ctx.fillStyle = css('--primary', '#2b6cff');
    ctx.fillText('— 推荐方案', x0 + 8, y1 + 12);
    ctx.fillStyle = css('--text-3', '#999');
    ctx.fillText('-- 基线（6×6 / Hd=0.35）', x0 + 90, y1 + 12);
  }

  /* ------------------------------------------------------------
   * 出射角分布
   * ------------------------------------------------------------ */
  function renderAngular(r, opts) {
    var cv = $('od_ang');
    if (!cv || !r.chosen) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = css('--surface-2', '#fff'); ctx.fillRect(0, 0, W, H);
    var cx = W * 0.12, cy = H - 26, R = Math.min(W * 0.74, H - 42);
    var thv = opts.thetaV * Math.PI / 180;

    /* 观看锥 */
    ctx.fillStyle = 'rgba(220,60,60,.13)';
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, -Math.PI / 2 - thv, -Math.PI / 2 + thv);
    ctx.closePath(); ctx.fill();

    /* 网格 */
    ctx.strokeStyle = css('--border', '#ddd'); ctx.lineWidth = 1;
    ctx.font = '10px sans-serif'; ctx.fillStyle = css('--text-3', '#888');
    for (var t = 0; t <= 90; t += 15) {
      var a = (-90 + t) * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(t + '°', cx + (R + 12) * Math.cos(a), cy + (R + 12) * Math.sin(a) + 3);
    }
    [0.5, 1].forEach(function (f) {
      ctx.beginPath(); ctx.arc(cx, cy, R * f, -Math.PI / 2, 0); ctx.stroke();
    });

    /* 两条分布：棱镜方案 vs 无棱镜朗伯 */
    var c = r.chosen;
    var prof = c.prof || D.angularProfile(c.beta, c.Hd, 90);
    var lam = D.lambertProfile(90);
    function maxOf(p) { var m = 0; for (var i = 0; i < p.arr.length; i++) if (p.arr[i] > m) m = p.arr[i]; return m; }
    function drawDist(p, color, dash) {
      var m = maxOf(p);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash || []);
      ctx.beginPath();
      for (var i = 0; i <= 90; i++) {
        var a = (-90 + i) * Math.PI / 180;
        var v = p.arr[i] / m;
        var x = cx + R * v * Math.cos(a), y = cy + R * v * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    drawDist(lam, css('--text-3', '#999'), [5, 4]);
    drawDist(prof, css('--primary', '#2b6cff'));

    ctx.textAlign = 'left'; ctx.font = '10.5px sans-serif';
    ctx.fillStyle = css('--primary', '#2b6cff');
    ctx.fillText('— 推荐（β≈' + c.beta.toFixed(0) + '°，C=' + pct(c.C) + '）', cx + 6, 14);
    ctx.fillStyle = css('--text-3', '#999');
    ctx.fillText('-- 无棱镜朗伯（C=' + pct(D.coneFraction(lam, opts.thetaV)) + '）', cx + 6, 28);
  }

  /* ------------------------------------------------------------
   * (U, η) 权衡散点 + Pareto
   * ------------------------------------------------------------ */
  function renderScatter(r, opts) {
    var cv = $('od_scatter');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var padL = 44, padR = 12, padT = 12, padB = 34;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = css('--surface-2', '#fff'); ctx.fillRect(0, 0, W, H);
    var x0 = padL, x1 = W - padR, y0 = H - padB, y1 = padT;
    var uLo = 0.2, uHi = 1.0, eLo = 0.05, eHi = 0.6;
    function px(u) { return x0 + (Math.max(uLo, Math.min(uHi, u)) - uLo) / (uHi - uLo) * (x1 - x0); }
    function py(e) { return y0 - (Math.max(eLo, Math.min(eHi, e)) - eLo) / (eHi - eLo) * (y0 - y1); }

    ctx.strokeStyle = css('--border', '#ddd'); ctx.lineWidth = 1;
    ctx.fillStyle = css('--text-3', '#888'); ctx.font = '10px sans-serif';
    var g;
    for (g = 20; g <= 100; g += 20) {
      var X = px(g / 100);
      ctx.beginPath(); ctx.moveTo(X, y0); ctx.lineTo(X, y1); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(g + '%', X, y0 + 13);
    }
    for (g = 10; g <= 60; g += 10) {
      var Y = py(g / 100);
      ctx.beginPath(); ctx.moveTo(x0, Y); ctx.lineTo(x1, Y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(g + '%', x0 - 5, Y + 3);
    }
    ctx.fillStyle = css('--text-2', '#555'); ctx.textAlign = 'center';
    ctx.fillText('发光面均匀度 U →', (x0 + x1) / 2, H - 5);
    ctx.save(); ctx.translate(12, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('出光效率 η →', 0, 0); ctx.restore();

    /* 目标区 */
    ctx.strokeStyle = css('--c-amber', '#e0a000'); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.strokeRect(px(opts.targetU), y1, x1 - px(opts.targetU), py(opts.targetEta) - y1);
    ctx.setLineDash([]);

    /* 候选点：抽样绘制，避免上万点把图糊死 */
    var pts = r.points, stride = Math.max(1, Math.floor(pts.length / 2600));
    for (var i = 0; i < pts.length; i += stride) {
      ctx.fillStyle = shapeColor(pts[i].shape);
      ctx.globalAlpha = 0.34;
      ctx.beginPath(); ctx.arc(px(pts[i].U), py(pts[i].eta), 2.1, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* Pareto 前沿 */
    if (r.pareto && r.pareto.length > 1) {
      ctx.strokeStyle = css('--primary', '#2b6cff'); ctx.lineWidth = 1.6;
      ctx.beginPath();
      r.pareto.forEach(function (p, k) {
        var X = px(p.U), Y = py(p.eta);
        if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      });
      ctx.stroke();
    }

    /* ★ */
    if (r.chosen) {
      var sx = px(r.chosen.U), sy = py(r.chosen.eta);
      ctx.fillStyle = css('--primary', '#2b6cff');
      ctx.font = 'bold 17px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('★', sx, sy + 6);
    }
  }

  /* ------------------------------------------------------------
   * 约束校核 + 处置建议
   * ------------------------------------------------------------ */
  var ACTION = {
    thickness: '加厚度预算，或减扩散板厚度把 OD 换出来',
    demold: '把 α 收进拔模上限；想更锐就得换更高保真的工艺（模具钢 + 慢速充填）',
    cover: '覆盖率不足 → 结构太疏或圆角太大：缩小 pitch / 提高复制保真',
    odp: 'OD/p 不足 → 加混光距离或加密 LED 阵列；换更宽的一次配光也能等效放宽',
    hotspot: '残余对比超标 → 提雾度（抹细结构）或加密阵列（抹灯影）',
    haze: '雾度超出基材可量产上限 → 换材料体系或叠一层扩散膜',
    u: 'U 不达标 → 加 OD / 加灯数 / 提雾度（按本页敏感性表挑最划算的那一项）',
    eta: 'η 不达标 → 提覆盖率、把 α 做锐、换本体透过率更高的材料、收紧边框反射',
    etac: '锥内不达标 → 降雾度（少散射）或把棱镜做锐（更小的 β）'
  };
  function renderChecks(r, opts) {
    var tb = $('od_checks');
    if (!tb || !r.chosen) return;
    var body = tb.querySelector('tbody');
    body.innerHTML = r.chosen.checks.map(function (k) {
      var cls = k.state === 'PASS' ? 'ok' : (k.state === 'WARN' ? 'warn' : 'bad');
      return '<tr><td>' + k.name + '</td><td>' + k.value + '</td><td>' + k.limit +
        '</td><td class="st ' + cls + '">' + k.state + '</td></tr>';
    }).join('');
    var why = $('od_why');
    if (why) {
      var bad = r.chosen.checks.filter(function (k) { return k.state !== 'PASS'; });
      if (!bad.length) {
        why.innerHTML = '<b>全部约束通过。</b>下一步看敏感性表：谁最敏感，谁的公差就收紧。';
      } else {
        why.innerHTML = '<b>未通过 / 需关注的约束与处置方向：</b><ul>' +
          bad.map(function (k) {
            return '<li>' + k.name + '（' + k.value + '）→ ' + (ACTION[k.key] || '调整对应设计变量') + '</li>';
          }).join('') + '</ul>';
      }
    }
  }

  /* ------------------------------------------------------------
   * 三材料对照（粗网格快速扫一遍）
   * ------------------------------------------------------------ */
  var COARSE = { Hd: [0.2, 0.35, 0.5, 0.65, 0.8, 0.9], tDiff: [1.5, 2.0], N: [6, 10, 14], alphaStep: 10 };
  function renderMatCompare(opts) {
    var tb = $('od_matcmp');
    if (!tb) return;
    var body = tb.querySelector('tbody');
    var rows = D.MAT_IDS.map(function (id) {
      var o = JSON.parse(JSON.stringify(opts));
      o.material = id; o.grid = COARSE;
      var rr = D.optimize(o);
      var c = rr.chosen;
      if (!c) return '<tr><td>' + D.MATERIALS[id].label + '</td><td colspan="6">无可用方案</td></tr>';
      var verdict = id === 'pmma'
        ? '本体透过率最高，纯看效率最好；脆、阻燃要专用牌号'
        : (id === 'pc'
          ? '折射率略增益但抵不过本体透过率损失；胜在阻燃与抗冲击'
          : '最便宜最轻，代价是透过率最低 + 黄变最快');
      return '<tr><td><b>' + D.MATERIALS[id].label + '</b></td><td>' + pct(c.eta) + '</td><td>' + pct(c.U) +
        '</td><td>' + (c.Hd * 100).toFixed(0) + '%</td><td>' + shapeLabel(c.shape) + ' / ' + c.alpha + '°</td><td>' +
        c.cost.toFixed(0) + '</td><td class="od-note">' + verdict + '</td></tr>';
    }).join('');
    body.innerHTML = rows;
  }

  /* ------------------------------------------------------------
   * 敏感性
   * ------------------------------------------------------------ */
  function renderSensitivity(r, opts) {
    var tb = $('od_sens');
    if (!tb || !r.chosen) return;
    var body = tb.querySelector('tbody');
    var rows = D.sensitivity(r.chosen, {
      W: opts.W, H: opts.H, thetaV: opts.thetaV, uDef: opts.uDef,
      wallRho: opts.wallRho, fieldRes: 96
    });
    body.innerHTML = rows.map(function (s) {
      function cls(v, sc) {
        var m = Math.abs(v) * sc;
        return m > 3 ? 'bad' : (m > 1 ? 'warn' : 'ok');
      }
      var adv = Math.abs(s.dU) + Math.abs(s.dEta) > 4
        ? '公差收紧' : (Math.abs(s.dU) + Math.abs(s.dEta) > 1.2 ? '常规管控' : '可放宽');
      return '<tr><td>' + s.name + '</td><td class="od-note">' + s.note + '</td>' +
        '<td class="st ' + cls(s.dU, 1) + '">' + (s.dU >= 0 ? '+' : '') + s.dU.toFixed(1) + ' pp</td>' +
        '<td class="st ' + cls(s.dEta, 1.6) + '">' + (s.dEta >= 0 ? '+' : '') + s.dEta.toFixed(1) + ' pp</td>' +
        '<td>' + adv + '</td></tr>';
    }).join('');
  }

  /* ------------------------------------------------------------
   * 绑定
   * ------------------------------------------------------------ */
  function init() {
    initMatPicker();
    initSelects();
    renderMatDetail();

    ['od_u', 'od_e', 'od_tv', 'od_budget', 'od_rho'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      setPct(el);
      el.addEventListener('input', function () {
        setPct(el);
        var out = $(id + '_v');
        if (out) {
          out.textContent = id === 'od_rho'
            ? (parseFloat(el.value) / 100).toFixed(2)
            : el.value + (id === 'od_tv' ? '°' : (id === 'od_budget' ? 'mm' : '%'));
        }
        schedule();
      });
    });
    ['od_udef', 'od_src', 'od_n', 'od_t', 'od_prefer', 'od_hotspot'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', schedule);
    });
    var btn = $('od_btn');
    if (btn) btn.addEventListener('click', function () { state.last = null; run(); });

    var seg = document.querySelectorAll('#view-opt .segbtn');
    Array.prototype.forEach.call(seg, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(seg, function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        state.fieldView = b.getAttribute('data-view');
        if (state.last) renderField(state.last, readOpts());
      });
    });
  }

  window.OptimalDesignUI = { init: init, run: run };
})();
