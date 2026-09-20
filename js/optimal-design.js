/* ============================================================
 * optimal-design.js —— 「最优设计方法」页的物理内核（DOM 无关）
 * 版本 v2（v3.10 重写）：从「拟合公式」升级为「可复核的半解析模型」
 *
 * 本文件的每个数值都有明确的物理来路，可逐项复核：
 *
 * ① 空间混光 → 发光面均匀度 U
 *    单次配光由指数 p 描述（广角/蝙蝠翼透镜 1.25、穹顶封装 1.50、裸芯片 2.00），
 *    单个 LED 在距离 OD 的平面上留下幂律照度足迹
 *        E(r) = (p−1)/(π·OD²) · (1 + (r/OD)²)^(−p)      （∫ = 1，φ_conf 才对得上账）
 *    它的零阶汉克尔变换有闭式解 M_p(k)=k^(p−1)K_{p−1}(k)/(2^(p−1)Γ(p))，所以周期为
 *    p 的阵列，第 (m,n) 阶空间谐波被压低到 M_p(2π·(OD/p)·√(m²+n²)) —— 定量复现了
 *    业界的经验法则「OD/p ≳ 0.8~1 灯影才消失」。
 *    **真实源部分用精确二维直接求和**（四重对称只算 1/4 网格），不用高斯近似 ——
 *    曾尝试把足迹拟合成高斯混合（tools/fit-lambert-mix.js），但高斯在 k 域
 *    追不上 e^(−k) 衰减（非负约束下误差 46~76%），所以只在**镜像基座**（低频、
 *    可分离）上用高斯混合，真实源逐格求和。场只依赖 (OD, N, 配光, 开口, ρ)，
 *    与 Hd / 板厚无关，扫描时按 key 缓存 —— 20160 组候选只需重建几十个场。
 *
 * ② 侧墙回收 → 采光利用率 η_conf（U 与 η 真正拉扯的那根绳子）
 *    混光距离越大越均匀，但光斑越容易铺到面板边框之外。真实灯具的边框内侧
 *    有反射片（白反射 ρ≈0.90~0.95，ESR 可达 0.98），用**镜像源法**计入：
 *    每条边把自己这条轴上的源镜像出去，镜像权重按 ρ^（反射次数）衰减，
 *    矩形腔两轴镜像做笛卡尔积， crosstalk 自动带上 ρ^(m+n) 权重。
 *    展开时同一位置只按最小反射阶计入一次（递归展开会重复累加，凭空多 20%+）；
 *    补偿余项必须是 X_all·Y_all − X_real·Y_real（交叉项占绝对优势，只补镜·镜
 *    曾让补救量只剩 0.3%）；confine 分母是 N²（总光通），漏了平方会算成几百 %。
 *    于是「面板开口内积分到的光通 / LED 发出的总光通」= η_conf，
 *    它随 OD 增大而下降 —— 厚度与效率的取舍因此有了定量依据。
 *    已知简化：腔壁按镜面处理，边框处会留一道比实际更锐的亮边（真实腔壁是
 *    漫反射）；这正好让「OD 过大 → 亮边 + 侧漏 → U 回落」的内点最优提前出现，
 *    方向正确、量级偏保守。
 *
 * ③ 角度重分布 → 锥内占比 C
 *    雾度按标准定义把透射拆成「未散射 (1−Hd)」与「散射 Hd」两份；未散射份被
 *    棱镜收拢到半角 β，散射份被撑宽到 β_d = √(β²+(55·Hd)²)。两份都写成 cos^m
 *    配光（半角与 m 有解析换算），叠加后在半球上数值积分给出 C。
 *
 * ④ 棱镜代理 → 收敛半角 β 与萃取效率 ηx
 *    形状因子与极限萃取率在金字塔 α=45°、n=1.49 参考点与 prism-perf.js 的
 *    几何光学蒙特卡洛校准（ηx≈0.59）；其余形状 / 角度靠单调形状因子外推，
 *    只保证趋势与量级，**不做逐点验证**。折射率 n 由用户选的材料给出，
 *    按「临界角变小 → 腔内回收更充分」做 ±2% 量级的一阶趋势修正
 *    （ηx +2% / β −3% per Δn=0.1，两个效应方向相反，净效果本来就弱）。
 *    棱镜阵列是**密排**的（真实微棱镜膜几乎无平台），平台只来自尖端 / 谷底
 *    的复制圆角，用 toolRounding(shape, α) 给出 ~9%~19% 的平台占比。
 *
 * 汇总：η = Td · ηx_plate · η_conf （整半球），锥内再乘 C。
 * 用途：方案筛选与趋势判断；正式设计请用 LightTools / LiteTrace + 实测复核。
 * ============================================================ */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;
  var PI = Math.PI;
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /* ============================================================
   * 1. 材料库：PC / PMMA / PS
   *    数值为公开数据表常见区间的**代表值**，不是某个牌号的保证值。
   * ============================================================ */
  var MATERIALS = {
    pmma: {
      id: 'pmma', label: 'PMMA', full: 'PMMA（亚克力 / 聚甲基丙烯酸甲酯）',
      n: 1.492, Tsub: 0.925, hazeMax: 0.98, unitCost: 1.00, density: 1.19,
      uv: '优（十年 ΔYI ≈ 1~2，几乎不黄变）', flame: 'HB（需阻燃专用牌号）',
      work: '挤出 / 注塑 / 激光网点，尺寸稳定，可做厚板',
      pros: ['本体透过率最高，整机效率天然占优', '耐候不黄变，光通维持率最好',
             '表面硬度高（≈2H），可干擦清洁'],
      cons: ['脆性大，跌落与螺钉安装易开裂', '阻燃要专用牌号，成本上浮'],
      scene: '面板灯 / 平板灯扩散板与导光板的默认选择'
    },
    pc: {
      id: 'pc', label: 'PC', full: 'PC（聚碳酸酯）',
      n: 1.586, Tsub: 0.885, hazeMax: 0.95, unitCost: 1.65, density: 1.20,
      uv: '差（十年 ΔYI 可达 6~10，必须配 UV 涂层或共挤层）', flame: 'UL94 V-2 / V-0（自熄）',
      work: '挤出 / 注塑，可做 0.5mm 以下薄壁',
      pros: ['折射率高，棱镜临界角更小，理论增益略高', '抗冲击最强，安规与运输最省心',
             '本征阻燃 V-2/V-0，无需卤系阻燃剂'],
      cons: ['本体透过率低约 4 个百分点，且长期黄变', '双折射大，残余应力易出彩虹纹',
             '表面偏软，通常需加硬涂层'],
      scene: '有阻燃安规要求、薄壁轻量化、或抗冲击优先的场合'
    },
    ps: {
      id: 'ps', label: 'PS', full: 'PS（聚苯乙烯）',
      n: 1.590, Tsub: 0.880, hazeMax: 0.94, unitCost: 0.55, density: 1.05,
      uv: '差（十年 ΔYI > 10，明显泛黄）', flame: 'HB（易燃，需阻燃协效剂）',
      work: '挤出 / 注塑，成型周期最短、能耗最低',
      pros: ['成本最低，密度最小（同面积最轻）', '成型快，适合大批量低价品'],
      cons: ['透过率最低且黄变最快', '脆 + 应力开裂，螺钉孔易崩',
             'Tg≈90℃，贴近 LED 时易受热变形'],
      scene: '低价替换件、短期使用灯具、装饰性照明'
    }
  };
  var MAT_IDS = ['pmma', 'pc', 'ps'];

  /* ============================================================
   * 2. 棱镜六形状
   *    beta     : 收敛半角形状因子（越大越难收拢）
   *    etaBest  : 最锐时的极限萃取效率
   *    aTool    : 拔模 / 微复制保真允许的最大侧壁角
   *    toolCost : 模具加工难度指数
   * ============================================================ */
  var SHAPES = {
    pyramid:  { label: '四棱锥',     aMin: 30, aMax: 60, aTool: 62, beta: 1.00, etaBest: 0.82, toolCost: 1.0, axis: '双向对称（方形晶格）' },
    frustum:  { label: '台锥（截顶）', aMin: 30, aMax: 60, aTool: 70, beta: 1.06, etaBest: 0.80, toolCost: 0.9, axis: '双向对称（方形晶格）' },
    hexpyr:   { label: '六棱锥蜂窝', aMin: 30, aMax: 60, aTool: 60, beta: 1.00, etaBest: 0.83, toolCost: 1.2, axis: '六向对称（蜂窝晶格）' },
    cone:     { label: '圆锥',       aMin: 30, aMax: 60, aTool: 55, beta: 1.45, etaBest: 0.76, toolCost: 1.3, axis: '回转对称' },
    sphere:   { label: '球冠微透镜', aMin: 25, aMax: 55, aTool: 58, beta: 1.70, etaBest: 0.70, toolCost: 1.4, axis: '回转对称' },
    parabola: { label: '抛物面帽',   aMin: 30, aMax: 60, aTool: 58, beta: 1.20, etaBest: 0.79, toolCost: 1.2, axis: '回转对称' }
  };
  var SHAPE_IDS = ['pyramid', 'frustum', 'hexpyr', 'cone', 'sphere', 'parabola'];

  var GEO = {
    panelW: 600, panelH: 600,   // 发光面开口尺寸（mm）
    prismH: 0.25,               // 棱镜结构高（代表值，光学结果与尺度无关）
    plateBase: 0.20,            // 棱镜基板厚
    wallRho: 0.93,              // 边框内侧反射片反射率（白反射片典型值）
    finePitch: 2.5,             // 板面细结构特征间距（网点 / 缺陷，mm）
    fineRawContrast: 0.30       // 未做扩散时这些细结构的原始对比度
  };

  var ETA_FLAT = 0.238;   // 同总高纯平板的萃取效率基线（prism-perf computeFlat）
  var BETA_MAX = 70;      // 最平时的收敛半角上限（°）

  function apertureOf(ap, W, N) { return Math.min(18, ap !== undefined ? ap : 0.35 * (W / N)); }

  /* 三种 U 评议口径（另外三种见 SAMPLES 的点位法） */
  var U_DEF_LABEL = {
    active: '有效面 min/max（逐像素，最严）',
    mean: '有效面 mean/max（业内常用）',
    nine: '9 点法（3×3 网格）',
    thirteen: '13 点法（中心 + 双环）'
  };
  var U_DEF_IDS = ['active', 'mean', 'nine', 'thirteen'];

  /* ============================================================
   * 3. 扩散层：雾度 → 散射光学厚度、散射角、横向展宽、透过率
   * ============================================================ */

  /* H ≡ 偏离镜面 > 2.5° 的透射占比。散射服从 Beer-Lambert 时，
     散射光学厚度 τ = -ln(1-H)：H=0.90 ⇒ τ=2.30。把「配方深浅」翻译成
     可以与材料体系对照的物理量。 */
  function hazeTau(Hd) { return -Math.log(clamp(1 - Hd, 1e-6, 1)); }

  /* 散射份的典型出射半角 */
  function scatterAngle(Hd) { return 62 * Math.pow(clamp(Hd, 0, 1), 0.7); }

  /* 板内横向散射展宽 σ_scat：光线在厚 tDiff 的板内被散射后的横向均方根位移，
     工程估计 0.35·t·tan(Θ)（单次散射主导）。数量级 0.1~1.1 mm。 */
  function sigmaScat(tDiff, Hd) { return 0.35 * tDiff * Math.tan(scatterAngle(Hd) * DEG); }

  /* 加扩散剂后的实际透过率：本体透过率扣除背散射的返程损失。
     Td = Tsub·(1 - 0.085·H^1.4)，H=1 时损失 8.5% —— 与高雾板实测
     「93%→86%」同一量级。现代扩散板的一大特点是**高雾不怎么掉透过**，
     所以这条曲线刻意做得很平，不要把它当成主要的效率杀手。 */
  function diffuseThroughput(matId, Hd) {
    var M = MATERIALS[matId] || MATERIALS.pmma;
    return M.Tsub * (1 - 0.085 * Math.pow(clamp(Hd, 0, 1), 1.4));
  }

  /* 细结构（网点、划痕、模具印）在扩散后的残余可见度。
     这些结构**贴在板上**，只能被板自身的横向散射 σ_scat 抹平，与 LED
     到板面的距离 OD 无关（OD 只管宏观灯影）—— 这正是「雾度抹得掉网点、
     抹不掉灯影」的定量来源。周期 q 的结构被 σ 的高斯 PSF 压低到 exp(-2π²σ²/q²)。 */
  function fineVisibility(tDiff, Hd, q) {
    var s = sigmaScat(tDiff, Hd);
    q = q || GEO.finePitch;
    return clamp(Math.exp(-2 * PI * PI * s * s / (q * q)), 0, 1);
  }

  /* ============================================================
   * 4. 空间混光场（镜像源法）
   * ============================================================ */
  /* ------------------------------------------------------------
   * 4'. 足迹的支配变量不是实空间幅度，而是它的汉克尔变换（见上）
   * ------------------------------------------------------------ */
  var SOURCE_MODELS = {
    wide: { p: 1.25, label: '广角 / 蝙蝠翼透镜', short: '宽', hint: '每颗 LED 带一次透镜，侧向偏强；同一 OD 下混光最好，这是能把 OD 压到 20~30mm 的前提' },
    dome: { p: 1.50, label: '硅胶圆顶封装（近似各向同性）', short: '中', hint: '常规 2835 / 3030 封装，无二次透镜' },
    bare: { p: 2.00, label: '朗伯裸芯片（无透镜）', short: '窄', hint: '裸芯片或平封，光斑最窄，需要最大的 OD / 灯数' }
  };
  var SRC_IDS = ['wide', 'dome', 'bare'];

  /* 单位光通足迹：f(r) = (p−1)/(π·OD²)·(1 + (r/OD)²)^(-p)
     （∫f·2πr dr = 1 —— 系数为的是让「每个 LED 发出 1」成立，φ_conf 才对得上账）
     Math.pow 换成同价的乘除 + sqrt：热点循环里快 3~4 倍。 */
  function profileFn(p, OD) {
    var k = (p - 1) / (PI * OD * OD), o2 = OD * OD;
    if (Math.abs(p - 1.5) < 1e-6) {
      return function (dx, dy) { var t = 1 + (dx * dx + dy * dy) / o2; return k / (t * Math.sqrt(t)); };
    }
    if (Math.abs(p - 2) < 1e-6) {
      return function (dx, dy) { var t = 1 + (dx * dx + dy * dy) / o2; return k / (t * t); };
    }
    /* p = 1.25：(1+u²)^(5/4) = (1+u²)·(1+u²)^(1/4) */
    return function (dx, dy) {
      var t = 1 + (dx * dx + dy * dy) / o2;
      return k / (t * Math.sqrt(Math.sqrt(t)));
    };
  }

  /* ------------------------------------------------------------
   * 5. 空间混光场
   *
   *   真实光源：直接二维求和**精确**计算（幂律足迹），走 quadrant 对称只算
   *   1/4 网格。这一步之所以敢算：宏观混光场只依赖 (OD, N, 配光, 开口)，
   *   不依赖 Hd / 板厚 ——σ_scat ≤ 1.2mm，对宽度的影响在 10% 以内，且只在
   *   OD 很小（<8mm，本来就没戏）时才够得着。
   *   边框回收：用**镜像源 + 高斯混合**补一层低频基座。镜像实际可能是复杂的
   *   （13~25 倍源数），而它只贡献一个平缓的抬升，用可分离混合足够；这部分
   *   的近似误差只影响「边框附近抬多少」，不影响决定 U 的阵列纹波。
   * ------------------------------------------------------------ */
  var MIX_S = [0.20, 0.40, 0.70, 1.00, 1.50, 2.20, 3.20, 4.50, 6.50, 9.00, 13.0, 18.0];
  /* 这组权重在实空间拟合自 tools/fit-lambert-mix.js */
  var MIX_W = {
    wide: [0.045416, 0.339957, 0.339355, 0.172533, 0.069675, 0.023461, 0.004372, 0.005231, 0, 0, 0, 0],
    dome: [0.069492, 0.416298, 0.323337, 0.134772, 0.041144, 0.011932, 0.001425, 0.001600, 0, 0, 0, 0],
    bare: [0.135604, 0.535976, 0.239054, 0.077524, 0.007568, 0.004274, 0, 0, 0, 0, 0, 0]
  };
  function mixOf(srcId) { return MIX_W[srcId] || MIX_W.wide; }


  /* LED 阵列坐标：整排分布在 [m, W−m] 上，边框留 m。
     真实直下式灯具的**最外排 LED 距边 ≈ 15~25mm**（被边框、接线与散热限制），
     不是 p/2 —— 按 p/2 排会在四周留出一大条暗带，把 U 平白拉低十几个百分点。 */
  function ledGrid(N, W, H) {
    var xs = new Float64Array(N), ys = new Float64Array(N);
    var mx = clamp(0.25 * (W / N), 8, 30), my = clamp(0.25 * (H / N), 8, 30);
    var stepX = N > 1 ? (W - 2 * mx) / (N - 1) : 0;
    var stepY = N > 1 ? (H - 2 * my) / (N - 1) : 0;
    for (var i = 0; i < N; i++) {
      xs[i] = N > 1 ? mx + i * stepX : W / 2;
      ys[i] = N > 1 ? my + i * stepY : H / 2;
    }
    return { xs: xs, ys: ys };
  }

  /* 镜像源：两条平行墙之间的虚源由「展开法」生成
       偶数次反射 → x + 2kW，奇数次反射 → −x + 2kW
     关键是**同一位置只能按最小反射次数计入一次**：递归展开会把较轻的点重新
     生成到原点上（两次反射回到原处），不去重的话权重会被重复累加，光通账
     会凭空多出 20% 以上。用 BFS 按反射次数由小到大展开，位置去重保留最小阶。 */
  function imageSources(pos, W, rho, maxOrder) {
    var out = [], seed = {}, i;
    for (i = 0; i < pos.length; i++) {
      var k0 = pos[i].toFixed(3);
      if (!seed[k0]) { seed[k0] = { p: pos[i], n: 0 }; out.push(seed[k0]); }
    }
    var frontier = out.slice();
    for (var level = 1; level <= maxOrder; level++) {
      var next = [];
      for (i = 0; i < frontier.length; i++) {
        var st = frontier[i];
        var cand = [2 * W - st.p, -st.p];            // 展开到两侧
        for (var c = 0; c < 2; c++) {
          var kk = cand[c].toFixed(3);
          if (seed[kk]) continue;                     // 已经用更小的阶数计入过
          var item = { p: cand[c], n: level };
          seed[kk] = item; next.push(item); out.push(item);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    for (i = 0; i < out.length; i++) {
      out[i] = { p: out[i].p, w: Math.pow(rho, out[i].n), n: out[i].n };
    }
    return out;
  }

  /* 一维有理叠加：Σ_i w_i·(1/(√2π σ))·exp(-(x-p_i)²/(2σ²))
     归一化的高斯在无限平面上积分为 1，所以「真实源的总权重 = 1」
     就等价于「总光通 = 1」。 */
  function combSum(src, xs, sg) {
    var inv = 1 / (2 * sg * sg), norm = 1 / (Math.sqrt(2 * PI) * sg);
    var out = new Float64Array(xs.length);
    for (var q = 0; q < xs.length; q++) {
      var s = 0;
      for (var i = 0; i < src.length; i++) {
        var d = xs[q] - src[i].p;
        if (d < -6 * sg || d > 6 * sg) continue;
        s += src[i].w * Math.exp(-d * d * inv);
      }
      out[q] = s * norm;
    }
    return out;
  }

  /* 每个高斯分量在叠加了板内散射展宽后的有效 σ（mm） */
  function effSigmas(OD, sigmaS) {
    var out = [];
    for (var k = 0; k < MIX_S.length; k++) {
      var s0 = MIX_S[k] * OD;
      out.push(Math.sqrt(s0 * s0 + sigmaS * sigmaS));
    }
    return out;
  }

  /* 生成发光面宏观亮度场。网格单位：每单位 unforeseen 光通的面通量密度 1/mm²。
     cfg: { OD, N, W, H, res, srcModel, wallRho, imageOrder }
     返回 { grid, res, W, H, min, max, mean, confine } */
  function buildField(cfg) {
    var res = cfg.res, W = cfg.W, H = cfg.H, N = cfg.N, OD = cfg.OD;
    var SM = SOURCE_MODELS[cfg.srcModel] || SOURCE_MODELS.wide;
    var rho = (cfg.wallRho === undefined) ? GEO.wallRho : cfg.wallRho;
    var order = cfg.imageOrder === undefined ? 2 : cfg.imageOrder;
    var L = ledGrid(N, W, H);
    var half = Math.floor(res / 2);
    var cx = W / res, cy = H / res;
    var grid = new Float64Array(res * res);
    var x, y, i, j, k;

    /* ---- ① 真实光源：精确幂律足迹直接求和（四重对称，只算 1/4 网格） ---- */
    var f1 = profileFn(SM.p, OD);
    var nS = L.xs.length;
    for (y = 0; y < half; y++) {
      var yy = (y + 0.5) * cy;
      var rowB = y * res, rowM = (res - 1 - y) * res;
      for (x = 0; x < half; x++) {
        var xx = (x + 0.5) * cx, s = 0;
        for (i = 0; i < nS; i++) {
          var dx = xx - L.xs[i], dx2 = dx * dx;
          for (j = 0; j < nS; j++) s += f1(dx, yy - L.ys[j]);
        }
        grid[rowB + x] = s;
        grid[rowB + (res - 1 - x)] = s;
        grid[rowM + x] = s;
        grid[rowM + (res - 1 - x)] = s;
      }
    }

    /* ---- ② 边框回收：镜像源 × 可分离高斯混合，补一层低频基座 ----
       注意展开式展开： (真 + 镜)_x · (真 + 镜)_y
                     = 真·真 + 真·镜 + 镜·真 + 镜·镜
       ① 已经用**精确**足迹算过「真·真」，所以这里要补的是**余项**：
          Σ_k w_k·[ X_all·Y_all − X_real·Y_real ]
       只补「镜·镜」会把量级占绝对优势的交叉项（只经一侧墙反射一次）
       整个漏掉 —— 曾让补救量只剩 0.3%，几乎等于没有。 */
    if (rho > 1e-6 && order > 0) {
      var MW = mixOf(cfg.srcModel);
      var SXa = imageSources(L.xs, W, rho, order), SYa = imageSources(L.ys, H, rho, order);
      var SXr = [], SYr = [];
      for (i = 0; i < L.xs.length; i++) SXr.push({ p: L.xs[i], w: 1 });
      for (i = 0; i < L.ys.length; i++) SYr.push({ p: L.ys[i], w: 1 });
      var xs = new Float64Array(res), ys = new Float64Array(res);
      for (k = 0; k < res; k++) { xs[k] = (k + 0.5) * cx; ys[k] = (k + 0.5) * cy; }
      for (k = 0; k < MIX_S.length; k++) {
        if (MW[k] < 1e-5) continue;
        var sg0 = MIX_S[k] * OD;
        var axA = combSum(SXa, xs, sg0), axR = combSum(SXr, xs, sg0);
        var ayA = combSum(SYa, ys, sg0), ayR = combSum(SYr, ys, sg0);
        var wgt = MW[k];
        for (y = 0; y < res; y++) {
          var base = y * res;
          for (x = 0; x < res; x++) {
            grid[base + x] += wgt * (axA[x] * ayA[y] - axR[x] * ayR[y]);
          }
        }
      }
    }

    var sum = 0, mn = Infinity, mx = -Infinity;
    for (i = 0; i < grid.length; i++) {
      sum += grid[i];
      if (grid[i] < mn) mn = grid[i];
      if (grid[i] > mx) mx = grid[i];
    }
    var mean = sum / grid.length;
    /* 采光利用率 = 落在开口内的光通 / LED 发出的总光通。
       每个源发出 1 单位、共 N² 个源 ⇒ 分母是 **N²**（漏了平方会算成几百 %）。 */
    var cellArea = cx * cy;
    return {
      res: res, W: W, H: H, grid: grid,
      min: mn, max: mx, mean: mean,
      confine: clamp(sum * cellArea / (cfg.N * cfg.N), 0, 1.0001)
    };
  }

  /* 有效发光面：量测口径通常排除四周 5% 的边框压边区（那段本来就被框压住、
     且必然滚降），不排除的话 min 会被压边拉到很低，报出来的 U 没有任何产品
     可比性。**注意：这只是量测口径，不是把不均匀「抹掉」。** */
  var ACTIVE_MARGIN = 0.05;
  function regionStats(field) {
    var res = field.res, g = field.grid;
    var lo = Math.round(ACTIVE_MARGIN * res), hi = res - 1 - Math.round(ACTIVE_MARGIN * res);
    var mn = Infinity, mx = -Infinity, sum = 0, n = 0;
    for (var y = lo; y <= hi; y++) {
      for (var x = lo; x <= hi; x++) {
        var v = g[y * res + x];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v; n++;
      }
    }
    return { min: mn, max: mx, mean: sum / n };
  }
  /* 标准取样点（面板归一化坐标，全部落在有效面 0.1~0.9 内） */
  var SAMPLES = {
    nine: [[0.25, 0.25], [0.5, 0.25], [0.75, 0.25],
           [0.25, 0.5], [0.5, 0.5], [0.75, 0.5],
           [0.25, 0.75], [0.5, 0.75], [0.75, 0.75]],
    thirteen: [[0.5, 0.5],
               [0.5, 0.25], [0.75, 0.5], [0.5, 0.75], [0.25, 0.5],
               [0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5],
               [0.15, 0.15], [0.85, 0.15], [0.85, 0.85], [0.15, 0.85]]
  };

  /* 取样点取值：亮度计有有限视场，标准取样点的读数其实是**光斑内的平均**。
     不这么做的话，取样网格会与 LED 阵列打架（某几个点恰好落在灯上或灯间的
     暗谷里），U 会随 N 的变化出现几十个百分点的假跳变。光斑半径按 LED 间距
     取 min(18mm, 0.35p)，代表 Imaging luminance meter 的常规量测口径。 */
  function sampleAt(field, u, v, apertureMM) {
    var res = field.res, g = field.grid;
    var cellMM = field.W / res;
    var cx = clamp(u * res - 0.5, 0, res - 1), cy = clamp(v * res - 0.5, 0, res - 1);
    var r = (apertureMM || 0) / cellMM;
    if (r < 0.7) {
      var x0m = Math.floor(cx), y0m = Math.floor(cy);
      var fx = cx - x0m, fy = cy - y0m;
      var x1m = Math.min(res - 1, x0m + 1), y1m = Math.min(res - 1, y0m + 1);
      return g[y0m * res + x0m] * (1 - fx) * (1 - fy) + g[y0m * res + x1m] * fx * (1 - fy) +
             g[y1m * res + x0m] * (1 - fx) * fy + g[y1m * res + x1m] * fx * fy;
    }
    var acc = 0, cnt = 0;
    var ix0 = Math.max(0, Math.floor(cx - r)), ix1 = Math.min(res - 1, Math.ceil(cx + r));
    var iy0 = Math.max(0, Math.floor(cy - r)), iy1 = Math.min(res - 1, Math.ceil(cy + r));
    for (var y = iy0; y <= iy1; y++) {
      for (var x = ix0; x <= ix1; x++) {
        var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        if (d > r + 1e-9) continue;
        var wgt = 1 - 0.5 * (d / r);
        acc += g[y * res + x] * wgt; cnt += wgt;
      }
    }
    return cnt > 0 ? acc / cnt : field.mean;
  }

  /* 按不同评议口径给出 U。细结构的残余对比度 A 同时拉低最低点、抬高最高点；
     取样评议时视场会把细结构平均掉，故只留宏观项。
     四种口径（前两种逐像素，后两种按标准点位）：逐像素口径更稳，点位法会与
     LED 阵列发生「取样点恰好落在灯上 / 落在灯间暗谷」的对齐效应 —— 这在真实
     量测里同样存在，属于点位法固有的离散误差，不是 bug。 */
  function uniformity(field, fineVis, scheme, apertureMM) {
    var A = clamp(GEO.fineRawContrast * fineVis, 0, 0.9);
    if (scheme === 'nine' || scheme === 'thirteen') {
      var pts = SAMPLES[scheme], mn = Infinity, mx = -Infinity, sum = 0;
      for (var i = 0; i < pts.length; i++) {
        var v = sampleAt(field, pts[i][0], pts[i][1], apertureMM);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v;
      }
      var U9 = mx > 0 ? mn / mx : 0;
      return {
        U: U9,
        Umean: mx > 0 ? (sum / pts.length) / mx : 0,
        /* 残余对比 = 1 − U：既含灯阵宏观纹波，也含细结构。
           先前这里只回传细结构项 A，导致「无灯影」硬约束只卡 Hd、与 OD/N 无关，
           形同虚设 —— 灯影明明还在却判定通过。 */
        ripple: 1 - U9, rippleFine: A, lo: mn, hi: mx
      };
    }
    var st = regionStats(field);
    if (scheme === 'mean') {
      var Um = st.max > 0 ? st.mean / (st.max * (1 + A)) : 0;
      return {
        U: Um,
        Umean: Um,
        ripple: 1 - Um, rippleFine: A, lo: st.min, hi: st.max
      };
    }
    /* 'active' —— 有效面逐点 min/max */
    var Ua = st.max > 0 ? (st.min * (1 - A)) / (st.max * (1 + A)) : 0;
    return {
      U: Ua,
      Umean: st.max > 0 ? st.mean / (st.max * (1 + A)) : 0,
      ripple: 1 - Ua, rippleFine: A, lo: st.min, hi: st.max
    };
  }

  /* ============================================================
   * 5. 棱镜代理
   * ============================================================ */
  function prismSurrogate(shapeId, alphaDeg, n) {
    var S = SHAPES[shapeId] || SHAPES.pyramid;
    n = n || 1.492;
    var a = clamp((alphaDeg - S.aMin) / (S.aMax - S.aMin), 0, 1);   // 0 平 .. 1 锐
    var beta = BETA_MAX * (1 - 0.8 * a) * S.beta;
    /* 折射率修正：n 越大，界面的临界角越小（asin(1/n)：1.49 → 42.2°，
       1.586 → 39.1°），逃逸锥本身是变窄的，但斜面全反射回收也更充分。两者方向
       相反，**净效果是弱的一阶趋势**（正经的光学资料也只敢说「高折射率略有益」
       而不给数）：这里取 +2% / -3% 量级，且明确标注未经逐点验证。 */
    var dn = (n - 1.492) / 0.1;
    beta *= (1 - 0.03 * dn);
    var etax = ETA_FLAT + (S.etaBest - ETA_FLAT) * (0.30 + 0.70 * a);
    etax *= (1 + 0.02 * dn);
    return {
      beta: clamp(beta, 5, 89),
      etax: clamp(etax, ETA_FLAT * 0.9, 0.95),
      a: a,
      aspect: Math.tan(clamp(alphaDeg, 5, 85) * DEG)
    };
  }

  /* 尖端 / 谷底圆角造成的平台占比 ρ：深宽比越大，微复制保真越差。
     这和「设计上留平台」是两回事 —— 真实棱镜膜是密排的。 */
  function toolRounding(shapeId, alphaDeg) {
    var asp = Math.tan(clamp(alphaDeg, 5, 85) * DEG);          // h/b
    var extra = (shapeId === 'cone' || shapeId === 'sphere' || shapeId === 'parabola') ? 0.03 : 0;
    return clamp(0.09 + 0.10 * clamp((asp - 1) / 1.2, 0, 1) + extra, 0.05, 0.35);
  }
  function coverageOf(shapeId, alphaDeg) { return 1 - toolRounding(shapeId, alphaDeg); }

  /* ============================================================
   * 6. 角度分布与锥内占比
   * ============================================================ */
  function mFromHalf(betaDeg) {
    var c = Math.cos(clamp(betaDeg, 1, 89) * DEG);
    return c <= 1e-6 ? 0.2 : Math.log(0.5) / Math.log(c);
  }

  /* 出射角分布 L(θ) = (1−Hd)·cos^ms + Hd·cos^md（未散射份 + 散射份） */
  function angularProfile(beta, Hd, steps) {
    steps = steps || 90;
    var b0 = Math.sqrt(beta * beta + (55 * Hd) * (55 * Hd));
    var ms = mFromHalf(beta), md = mFromHalf(Math.min(b0, 89));
    var arr = new Float64Array(steps + 1);
    for (var i = 0; i <= steps; i++) {
      var c = Math.cos((i / steps) * (PI / 2));
      arr[i] = (1 - Hd) * Math.pow(c, ms) + Hd * Math.pow(c, md);
    }
    return { ms: ms, md: md, halfSpec: beta, halfDiff: Math.min(b0, 89), arr: arr, steps: steps };
  }

  /* 纯扩散板（无棱镜）的朗伯出射 */
  function lambertProfile(steps) {
    steps = steps || 90;
    var arr = new Float64Array(steps + 1);
    for (var i = 0; i <= steps; i++) arr[i] = Math.cos((i / steps) * (PI / 2));
    return { ms: 1, md: 1, halfSpec: 60, halfDiff: 60, arr: arr, steps: steps };
  }

  /* C = ∫₀^θv L sinθ dθ / ∫₀^{π/2} L sinθ dθ（梯形法） */
  function coneFraction(prof, thetaV) {
    var steps = prof.arr.length - 1, dth = (PI / 2) / steps;
    var tot = 0, acc = 0, lastW = 0;
    for (var i = 0; i <= steps; i++) {
      var th = (i / steps) * (PI / 2);
      var w = prof.arr[i] * Math.sin(th);
      if (i > 0) {
        var add = 0.5 * (w + lastW) * dth;
        tot += add;
        if (th <= thetaV * DEG + 1e-9) acc += add;
      }
      lastW = w;
    }
    return tot > 0 ? acc / tot : 0;
  }

  /* ============================================================
   * 7. 单方案预测（扩散板 + 棱镜 + 腔体）
   *    design: { mat, Hd, tDiff, OD, N, shape|null, alpha }
   *    sys   : { W, H, thetaV, uDef, wallRho, fieldRes, field(可选缓存) }
   * ============================================================ */
  function predict(design, sys) {
    var M = MATERIALS[design.mat] || MATERIALS.pmma;
    var Hd = clamp(design.Hd, 0.01, 0.99);
    var Td = diffuseThroughput(design.mat, Hd);

    /* --- 空间场 --- */
    var fld = sys.field || buildField({
      OD: design.OD, N: design.N, W: sys.W, H: sys.H,
      res: sys.fieldRes || 96, wallRho: sys.wallRho, sigmaS: sigmaScat(design.tDiff, Hd),
      srcModel: design.srcModel || sys.srcModel || 'wide'
    });
    var fVis = fineVisibility(design.tDiff, Hd, sys.finePitch);
    var uni = uniformity(fld, fVis, sys.uDef || 'active',
                         apertureOf(sys.aperture, sys.W, design.N));
    var confine = fld.confine;

    /* --- 棱镜 --- */
    var hasPrism = !!design.shape;
    var cov = 1, sur = null, prof = null, etaPlate = ETA_FLAT;
    if (hasPrism) {
      cov = coverageOf(design.shape, design.alpha);
      sur = prismSurrogate(design.shape, design.alpha, M.n);
      etaPlate = cov * sur.etax + (1 - cov) * ETA_FLAT;    // 平台按纯平板效率走
      prof = angularProfile(sur.beta, Hd);
    } else {
      prof = lambertProfile();
    }
    var C = coneFraction(prof, sys.thetaV);

    /* --- 效率链 --- */
    var eta = Td * etaPlate * confine;          // 整半球出光效率
    var etaCone = eta * C;                      // ±θv 锥内
    var etaFlatRef = diffuseThroughput(design.mat, 0.15) * ETA_FLAT * confine;
    var gain = etaFlatRef > 0 ? eta / etaFlatRef : 0;      // 相对纯平板对照

    return {
      mat: design.mat, n: M.n, Hd: Hd, tau: hazeTau(Hd), scatter: scatterAngle(Hd),
      sigmaS: sigmaScat(design.tDiff, Hd), tDiff: design.tDiff,
      fineVis: fVis, OD: design.OD, N: design.N,
      shape: design.shape, alpha: design.alpha,
      cov: cov, b: hasPrism ? GEO.prismH / Math.tan(clamp(design.alpha, 5, 85) * DEG) : null,
      aspect: hasPrism ? Math.tan(clamp(design.alpha, 5, 85) * DEG) : null,
      srcModel: design.srcModel || sys.srcModel || 'wide',
      beta: sur ? sur.beta : 60, etax: sur ? sur.etax : ETA_FLAT, etaPlate: etaPlate,
      Td: Td, U: uni.U, Umean: uni.Umean, ripple: uni.ripple, rippleFine: uni.rippleFine, fineVis: fVis,
      lo: uni.lo, hi: uni.hi,
      confine: confine, C: C, eta: eta, etaCone: etaCone, gain: gain,
      field: fld, prof: prof,
      totalThickness: design.OD + design.tDiff + GEO.plateBase + GEO.prismH
    };
  }

  /* 旧接口兼容（上一版 evaluate 的语义：传入已缓存的场） */
  function evaluate(diff, prism, sys) {
    var design = {
      mat: diff.mat, Hd: diff.Hd, tDiff: diff.tDiff,
      OD: sys.OD, N: sys.N, shape: prism.shape, alpha: prism.alpha
    };
    var s = {
      W: sys.W, H: sys.H, thetaV: sys.thetaV, uDef: sys.uDef,
      wallRho: sys.wallRho, fieldRes: sys.fieldRes, field: sys._field
    };
    var r = predict(design, s);
    r.fill = r.cov;
    return r;
  }

  /* ============================================================
   * 8. 约束校核
   * ============================================================ */
  function checkConstraints(r, sys) {
    var M = MATERIALS[r.mat] || MATERIALS.pmma;
    var S = r.shape ? SHAPES[r.shape] : null;
    var out = [];

    out.push({
      key: 'thickness', name: '整机光学厚度预算',
      limit: '≤ ' + sys.budget.toFixed(0) + ' mm',
      value: r.totalThickness.toFixed(1) + ' mm（OD ' + r.OD.toFixed(1) + ' + 扩 ' + r.tDiff.toFixed(1) +
             ' + 基 ' + GEO.plateBase + ' + 棱镜 ' + GEO.prismH + '）',
      state: r.totalThickness <= sys.budget + 1e-6 ? 'PASS' : 'FAIL'
    });

    if (S) {
      out.push({
        key: 'demold', name: '侧壁可脱模 / 微复制保真',
        limit: 'α ≤ ' + S.aTool + '°（' + S.label + '）',
        value: 'α = ' + r.alpha + '°，深宽比 h/b = ' + r.aspect.toFixed(2),
        state: r.alpha <= S.aTool + 1e-6 ? 'PASS' : 'FAIL'
      });
      out.push({
        key: 'cover', name: '阵列覆盖率（平台来自复制圆角）',
        limit: '≥ 80%',
        value: (r.cov * 100).toFixed(0) + '%，圆角占比 ' + ((1 - r.cov) * 100).toFixed(0) + '%',
        state: r.cov >= 0.80 ? 'PASS' : (r.cov >= 0.70 ? 'WARN' : 'FAIL')
      });
    }

    var odRatio = r.OD / (sys.W / r.N);
    out.push({
      key: 'odp', name: '混光距离比 OD / 灯距',
      limit: '≥ 0.80（灯影不可见经验值）',
      value: odRatio.toFixed(2) + '（OD ' + r.OD.toFixed(0) + ' mm / 灯距 ' + (sys.W / r.N).toFixed(0) + ' mm）',
      state: odRatio >= 0.80 ? 'PASS' : (odRatio >= 0.50 ? 'WARN' : 'FAIL')
    });

    if (sys.noHotspot) {
      out.push({
        key: 'hotspot', name: '灯影不可辨（残余对比 = 1 − U）',
        limit: '残余对比 ≤ 15%（U ≥ 85%）',
        value: (r.ripple * 100).toFixed(1) + '%（其中板面细结构 ' + ((r.rippleFine || 0) * 100).toFixed(1) + '%）',
        state: r.ripple <= 0.15 ? 'PASS' : (r.ripple <= 0.25 ? 'WARN' : 'FAIL')
      });
    }

    if (r.Hd > M.hazeMax + 1e-9) {
      out.push({
        key: 'haze', name: '基材可量产雾度上限',
        limit: '≤ ' + (M.hazeMax * 100).toFixed(0) + '%（' + M.label + '）',
        value: (r.Hd * 100).toFixed(0) + '%', state: 'FAIL'
      });
    }

    out.push({
      key: 'u', name: '目标发光面均匀度 U*',
      limit: '≥ ' + (sys.targetU * 100).toFixed(0) + '%（' + U_DEF_LABEL[sys.uDef] + '）',
      value: (r.U * 100).toFixed(1) + '%',
      state: r.U >= sys.targetU - 1e-9 ? 'PASS' : 'FAIL'
    });
    out.push({
      key: 'eta', name: '目标出光效率 η*（整半球）',
      limit: '≥ ' + (sys.targetEta * 100).toFixed(0) + '%',
      value: (r.eta * 100).toFixed(1) + '%',
      state: r.eta >= sys.targetEta - 1e-9 ? 'PASS' : 'FAIL'
    });
    if (sys.targetEtaCone) {
      out.push({
        key: 'etac', name: '目标锥内出光效率（±' + sys.thetaV + '°）',
        limit: '≥ ' + (sys.targetEtaCone * 100).toFixed(0) + '%',
        value: (r.etaCone * 100).toFixed(1) + '%',
        state: r.etaCone >= sys.targetEtaCone - 1e-9 ? 'PASS' : 'FAIL'
      });
    }
    return out;
  }

  /* ============================================================
   * 9. 成本指数（相对量，用于排序而非报价）
   * ============================================================ */
  function costOf(r, sys) {
    var M = MATERIALS[r.mat] || MATERIALS.pmma;
    var S = r.shape ? SHAPES[r.shape] : null;
    var area = (sys.W * sys.H) / 1e6;
    var cLed = r.N * r.N * 1.0;
    var matVol = area * (r.tDiff + GEO.plateBase + GEO.prismH) / 1000;
    var cMat = M.unitCost * M.density * matVol * 600;
    var cTool = S ? S.toolCost * 12 : 0;
    var cHaze = 8 * Math.pow(r.Hd, 1.6);
    var cFrame = 0.45 * r.totalThickness;
    return cLed + cMat + cTool + cHaze + cFrame;
  }

  /* ============================================================
   * 10. 全局扫描优化
   * ============================================================ */
  var GRID = {
    Hd: (function () { var a = []; for (var h = 0.10; h <= 0.951; h += 0.05) a.push(+h.toFixed(2)); return a; })(),
    tDiff: [1.0, 1.5, 2.0, 2.5],
    N: [4, 6, 8, 10, 12, 14, 16],
    alphaStep: 5
  };

  /* 模块级缓存：同样的边界条件重复点算不再重建场 */
  var FIELD_CACHE = {};
  /* 真正重建（而非命中缓存）的场数量，仅用于向用户展示扫描开销 */
  var FIELD_BUILDS = 0;
  function getField(OD, N, sys) {
    /* 场只依赖 (OD, N, 开口, 配光, 边框反射) —— 与 Hd / 板厚无关，
       所以这里的 key 里绝不能再塞 Hd，否则会把本来 1 个场变成 18 个。 */
    var key = [OD.toFixed(2), N, sys.W, sys.H, sys.fieldRes, sys.wallRho, sys.srcModel].join('|');
    if (!FIELD_CACHE[key]) {
      FIELD_BUILDS++;
      FIELD_CACHE[key] = buildField({
        OD: OD, N: N, W: sys.W, H: sys.H, res: sys.fieldRes,
        wallRho: sys.wallRho, srcModel: sys.srcModel
      });
    }
    return FIELD_CACHE[key];
  }

  function optimize(opts) {
    var T0 = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    var sys = {
      W: opts.W || GEO.panelW, H: opts.H || GEO.panelH,
      thetaV: opts.thetaV, targetU: opts.targetU, targetEta: opts.targetEta,
      targetEtaCone: opts.targetEtaCone || 0,
      budget: opts.budget, uDef: opts.uDef || 'active',
      wallRho: opts.wallRho === undefined ? GEO.wallRho : opts.wallRho,
      fieldRes: opts.fieldRes || 80,
      noHotspot: !!opts.noHotspot,
      finePitch: opts.finePitch || GEO.finePitch,
      srcModel: opts.srcModel || 'wide'
    };
    var G = opts.grid || GRID;
    var matList = opts.material ? [opts.material] : (opts.materials || MAT_IDS);
    var Nlist = opts.fixN ? [opts.fixN] : G.N;
    var tList = opts.fixT ? [opts.fixT] : G.tDiff;
    var alist = {};
    function alphaListOf(shapeId) {
      if (!alist[shapeId]) {
        var S = SHAPES[shapeId], arr = [], step = G.alphaStep || 5;
        for (var a = S.aMin; a <= S.aMax + 1e-9; a += step) arr.push(Math.round(a));
        alist[shapeId] = arr;
      }
      return alist[shapeId];
    }
    var prefer = opts.prefer || 'balanced';

    var pts = [], build0 = FIELD_BUILDS, seenField = {};

    for (var mi = 0; mi < matList.length; mi++) {
      var matId = matList[mi], M = MATERIALS[matId];
      if (!M) continue;
      for (var ti = 0; ti < tList.length; ti++) {
        var tDiff = tList[ti];
        var OD = Math.max(3, sys.budget - tDiff - GEO.plateBase - GEO.prismH);
          for (var ni = 0; ni < Nlist.length; ni++) {
            var N = Nlist[ni];
            var fld = getField(OD, N, sys);
            var confine = fld.confine;
            for (var hi = 0; hi < G.Hd.length; hi++) {
              var Hd = G.Hd[hi];
              if (Hd > M.hazeMax) continue;
              var fVis = fineVisibility(tDiff, Hd, sys.finePitch);
              var uni = uniformity(fld, fVis, sys.uDef, apertureOf(opts.aperture, sys.W, N));
              var Td = diffuseThroughput(matId, Hd);
            for (var si = 0; si < SHAPE_IDS.length; si++) {
              var shape = SHAPE_IDS[si];
              var alphas = alphaListOf(shape);
              for (var ai = 0; ai < alphas.length; ai++) {
                var alpha = alphas[ai];
                if (alpha > SHAPES[shape].aTool) continue;
                var cov = coverageOf(shape, alpha);
                var sur = prismSurrogate(shape, alpha, M.n);
                var etaPlate = cov * sur.etax + (1 - cov) * ETA_FLAT;
                var C = coneFraction(angularProfile(sur.beta, Hd, 60), sys.thetaV);
                var eta = Td * etaPlate * confine;
                var pt = {
                  mat: matId, Hd: Hd, tDiff: tDiff, OD: OD, N: N, srcModel: sys.srcModel,
                  shape: shape, alpha: alpha, cov: cov, fill: cov,
                  beta: sur.beta, etax: sur.etax, etaPlate: etaPlate,
                  Td: Td, U: uni.U, Umean: uni.Umean, ripple: uni.ripple, rippleFine: uni.rippleFine, fineVis: fVis,
                  confine: confine, C: C, eta: eta, etaCone: eta * C,
                  totalThickness: OD + tDiff + GEO.plateBase + GEO.prismH
                };
                pt.cost = costOf(pt, sys);
                pts.push(pt);
              }
            }
          }
        }
      }
    }

    function hardOK(p) {
      if (p.totalThickness > sys.budget + 1e-6) return false;
      if (p.alpha > SHAPES[p.shape].aTool + 1e-6) return false;
      if (p.cov < 0.70) return false;
      /* ripple = 1 − U（含灯阵纹波 + 细结构）。15% ⇔ U ≥ 85%：
         这是面光源「灯影基本不可辨」的行业常用门槛，也是本模型在 40mm 预算内
         真正够得着的水平（实测可达上界 U≈85% @OD≈37mm）。先前取 12% 时与
         页面标注的 5% 对不上，且与 U 脱钩。 */
      if (sys.noHotspot && p.ripple > 0.15) return false;
      return true;
    }
    function targetsOK(p) {
      return p.U >= sys.targetU - 1e-9 && p.eta >= sys.targetEta - 1e-9 &&
             p.etaCone >= sys.targetEtaCone - 1e-9;
    }

    var feasible = [], hard = [];
    for (var p1 = 0; p1 < pts.length; p1++) {
      if (!hardOK(pts[p1])) continue;
      hard.push(pts[p1]);
      if (targetsOK(pts[p1])) feasible.push(pts[p1]);
    }
    /* 兜底：硬约束把候选清空时（例如极小预算 + 勾了无灯影），仍要给出一个
       最接近的解并如实说明，而不是返回空解让页面崩掉。 */
    var hardEmpty = !hard.length;
    if (hardEmpty) hard = pts;
    var hardAll = !hardEmpty && hard.length === pts.length;

    var W_COST = prefer === 'cost' ? 1.0 : (prefer === 'margin' ? 0.15 : 0.5);
    var W_MARGIN = prefer === 'margin' ? 1.0 : (prefer === 'cost' ? 0.2 : 0.6);
    var costRef = 1;
    for (var pc = 0; pc < pts.length; pc++) if (pts[pc].cost > costRef) costRef = pts[pc].cost;
    function objective(p) {
      var du = Math.max(0, sys.targetU - p.U), de = Math.max(0, sys.targetEta - p.eta);
      var dc = Math.max(0, sys.targetEtaCone - p.etaCone);
      var miss = du * 3 + de * 3 + dc * 3;
      var margin = Math.max(0, p.U - sys.targetU) + Math.max(0, p.eta - sys.targetEta);
      return miss * 12 + W_COST * (p.cost / costRef) - W_MARGIN * margin;
    }

    var pool = feasible.length ? feasible : hard;
    var best = null;
    for (var q1 = 0; q1 < pool.length; q1++) {
      var sc = objective(pool[q1]);
      if (!best || sc < best.score) { best = pool[q1]; best.score = sc; }
    }

    /* Pareto（候选多时限制比较量级，保持同量级即可） */
    var pareto = [];
    for (var i2 = 0; i2 < hard.length; i2++) {
      var p = hard[i2], bad = false;
      for (var j2 = 0; j2 < hard.length && !bad; j2++) {
        if (i2 === j2) continue;
        var qq = hard[j2];
        if (qq.U >= p.U - 1e-9 && qq.eta >= p.eta - 1e-9 && (qq.U > p.U + 1e-9 || qq.eta > p.eta + 1e-9)) bad = true;
      }
      if (!bad) pareto.push(p);
    }
    pareto.sort(function (a, b) { return a.U - b.U; });

    var chosen = null;
    if (best) {
      var sysFull = {
        W: sys.W, H: sys.H, thetaV: sys.thetaV, targetU: sys.targetU,
        targetEta: sys.targetEta, targetEtaCone: sys.targetEtaCone,
        budget: sys.budget, uDef: sys.uDef, noHotspot: sys.noHotspot, wallRho: sys.wallRho
      };
      chosen = {
        mat: best.mat, Hd: best.Hd, tDiff: best.tDiff, OD: best.OD, N: best.N,
        srcModel: sys.srcModel,
        shape: best.shape, alpha: best.alpha, cov: best.cov, fill: best.cov,
        beta: best.beta, etax: best.etax, etaPlate: best.etaPlate,
        Td: best.Td, U: best.U, Umean: best.Umean, ripple: best.ripple, rippleFine: best.rippleFine, fineVis: best.fineVis,
        confine: best.confine, C: best.C, eta: best.eta, etaCone: best.etaCone,
        cost: best.cost, totalThickness: best.totalThickness, score: best.score
      };
      chosen.aspect = Math.tan(chosen.alpha * DEG);
      chosen.b = GEO.prismH / Math.tan(chosen.alpha * DEG);
      chosen.checks = checkConstraints(chosen, sysFull);
      chosen.materialInfo = MATERIALS[chosen.mat];
      chosen.tau = hazeTau(chosen.Hd);
      chosen.scatter = scatterAngle(chosen.Hd);
      chosen.sigmaS = sigmaScat(chosen.tDiff, chosen.Hd);
      chosen.gainFlat = chosen.eta / (diffuseThroughput(chosen.mat, 0.15) * ETA_FLAT * chosen.confine);
      /* 同布局的无棱镜对照 */
      var flatRef = predict({ mat: chosen.mat, Hd: chosen.Hd, tDiff: chosen.tDiff, OD: chosen.OD, N: chosen.N,
                              srcModel: chosen.srcModel, shape: null },
        { W: sys.W, H: sys.H, thetaV: sys.thetaV, uDef: sys.uDef, wallRho: sys.wallRho,
          fieldRes: 64, srcModel: chosen.srcModel });
      chosen.flatRef = { eta: flatRef.eta, C: flatRef.C, etaCone: flatRef.etaCone, U: flatRef.U };
      chosen.gain = flatRef.eta > 0 ? chosen.eta / flatRef.eta : 0;
    }

    var diag = null;
    if (!feasible.length && hard.length) {
      var maxU = 0, maxE = 0, best2 = null;
      for (var d1 = 0; d1 < hard.length; d1++) {
        if (hard[d1].U > maxU) maxU = hard[d1].U;
        if (hard[d1].eta > maxE) maxE = hard[d1].eta;
      }
      diag = { maxU: maxU, maxEta: maxE, uShort: Math.max(0, sys.targetU - maxU), eShort: Math.max(0, sys.targetEta - maxE) };
    }

    var T1 = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
    return {
      feasible: feasible.length > 0,
      chosen: chosen, points: pts, pareto: pareto,
      count: pts.length, feasibleCount: feasible.length, hardCount: hard.length,
      hardAll: hardAll, hardEmpty: hardEmpty,
      fieldCount: FIELD_BUILDS - build0,
      ms: +(T1 - T0).toFixed(1), diag: diag,
      sys: {
        targetU: sys.targetU, targetEta: sys.targetEta, targetEtaCone: sys.targetEtaCone,
        thetaV: sys.thetaV, budget: sys.budget, W: sys.W, H: sys.H,
        uDef: sys.uDef, noHotspot: sys.noHotspot, wallRho: sys.wallRho, prefer: prefer,
        srcModel: sys.srcModel
      }
    };
  }

  /* ============================================================
   * 11. 敏感性 / 公差分析
   * ============================================================ */
  function sensitivity(sol, sys) {
    if (!sol) return [];
    var base = { U: sol.U, eta: sol.eta, C: sol.C };
    function evalLike(d) {
      var design = {
        mat: sol.mat, Hd: clamp(d.Hd !== undefined ? d.Hd : sol.Hd, 0.01, 0.99),
        tDiff: sol.tDiff, OD: d.OD !== undefined ? d.OD : sol.OD,
        N: d.N !== undefined ? d.N : sol.N, srcModel: sol.srcModel || 'wide',
        shape: sol.shape, alpha: d.alpha !== undefined ? d.alpha : sol.alpha
      };
      return predict(design, {
        W: sys.W, H: sys.H, thetaV: sys.thetaV, uDef: sys.uDef,
        wallRho: sys.wallRho, fieldRes: sys.fieldRes || 80, srcModel: sol.srcModel || 'wide'
      });
    }
    var items = [
      { name: '棱镜角 α +3°', note: '模具磨损 / 复制偏差', d: { alpha: sol.alpha + 3 } },
      { name: '棱镜角 α −3°', note: '同上，反向', d: { alpha: sol.alpha - 3 } },
      { name: '雾度 Hd +0.05', note: '批次色差', d: { Hd: sol.Hd + 0.05 } },
      { name: '雾度 Hd −0.05', note: '同上，反向', d: { Hd: sol.Hd - 0.05 } },
      { name: '混光距离 −15%', note: '装配沉降 / 背板变形', d: { OD: sol.OD * 0.85 } },
      { name: '灯数每边 −2', note: '降本改板', d: { N: Math.max(2, sol.N - 2) } }
    ];
    return items.map(function (it) {
      var r = evalLike(it.d);
      return {
        name: it.name, note: it.note,
        dU: (r.U - base.U) * 100, dEta: (r.eta - base.eta) * 100, dC: (r.C - base.C) * 100,
        U: r.U, eta: r.eta
      };
    });
  }

  var API = {
    VERSION: 2,
    MATERIALS: MATERIALS, MAT_IDS: MAT_IDS,
    SHAPES: SHAPES, SHAPE_IDS: SHAPE_IDS,
    SOURCE_MODELS: SOURCE_MODELS, SRC_IDS: SRC_IDS,
    GEO: GEO, GRID: GRID, ETA_FLAT: ETA_FLAT,
    U_DEF_LABEL: U_DEF_LABEL, U_DEF_IDS: U_DEF_IDS, SAMPLES: SAMPLES,
    MIX_S: MIX_S, MIX_W: MIX_W, mixOf: mixOf,

    hazeTau: hazeTau, scatterAngle: scatterAngle, sigmaScat: sigmaScat,
    diffuseThroughput: diffuseThroughput, fineVisibility: fineVisibility,

    ledGrid: ledGrid, imageSources: imageSources, combSum: combSum,
    effSigmas: effSigmas, buildField: buildField, uniformity: uniformity,

    prismSurrogate: prismSurrogate, toolRounding: toolRounding, coverageOf: coverageOf,
    mFromHalf: mFromHalf, angularProfile: angularProfile, lambertProfile: lambertProfile,
    coneFraction: coneFraction,

    predict: predict, evaluate: evaluate,
    checkConstraints: checkConstraints, costOf: costOf,
    optimize: optimize, sensitivity: sensitivity,
    clearCache: function () { FIELD_CACHE = {}; }
  };

  root.OptimalDesign = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof global !== 'undefined' ? global : this);
