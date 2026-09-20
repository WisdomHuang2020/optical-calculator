/* 独立复算外部参考文件 solid_angle_3d.html 的全部数值
 * 用法：node tests/verify-user-file.js [参考文件路径]
 * A~D 节是纯数学复算，不依赖该文件；E 节需读取文件，缺文件时自动跳过。
 */
const fs = require('fs');
const REF = process.argv[2] || '';
const D = Math.PI / 180;
let fail = 0;
function chk(name, got, want, tol) {
  tol = tol === undefined ? 1e-9 : tol;
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} got=${(+got).toPrecision(9)} want=${(+want).toPrecision(9)}`);
}
const r3 = v => Number(v.toFixed(3));
const r4 = v => Number(v.toFixed(4));

console.log('=== A. 附件 nums() 的显示值复核（默认 θ=19°, 微元 30°/8°/30°）===');
{
  const th = 19;
  const O = 2 * Math.PI * (1 - Math.cos(th * D));
  chk('Ω(19°) 显示 0.342', r3(O), 0.342);
  chk('Ω(19°) 真值', O, 0.3423168853, 1e-8);
  chk('占 4π 显示 2.72%', Number((O / (4 * Math.PI) * 100).toFixed(2)), 2.72);
  chk('Φ/Ω = 9000/Ω 显示 26 291', Math.round(9000 / O), 26291);
}
{
  const t = 30, dth = 8, dps = 30;
  const tR = t * D, dR = dth * D, pR = dps * D;
  chk('pe1 = R·dθ 显示 0.140', r3(dR), 0.140);
  chk('pe2 = R·sinθ·dφ 显示 0.262', r3(Math.sin(tR) * pR), 0.262);
  chk('pdv = sinθ·dθ·dφ 显示 0.0366', r4(Math.sin(tR) * dR * pR), 0.0366);
  chk('pdv 真值', Math.sin(tR) * dR * pR, 0.0365540904, 1e-9);
}

console.log('\n=== B. 关键：附件的 dΩ 微元取在区间「起点」，误差是一阶的 ===');
{
  // 附件：th1 = th0, th2 = th0 + dth（见 drawPatch / nums）
  // 精确立体角闭式 Ω = Δφ·(cos θ1 − cos θ2)
  const cases = [[30, 8, 30], [30, 25, 30], [30, 2, 30], [30, 8, 90], [60, 8, 30], [5, 25, 90]];
  console.log('  θ₀   dθ    dφ  |  精确闭式      附件(区间起点)  偏差     | 中点法       中点偏差');
  for (const [t0, dth, dps] of cases) {
    const t1 = t0 * D, t2 = (t0 + dth) * D, dp = dps * D;
    const exact = (Math.cos(t1) - Math.cos(t2)) * dp;
    const atStart = Math.sin(t1) * (dth * D) * dp;
    const atMid = Math.sin((t1 + t2) / 2) * (dth * D) * dp;
    console.log(
      `  ${String(t0).padStart(2)}°  ${String(dth).padStart(2)}°  ${String(dps).padStart(3)}°  |` +
      `  ${exact.toFixed(6)}   ${atStart.toFixed(6)}   ${((atStart / exact - 1) * 100).toFixed(2).padStart(6)}%  |` +
      ` ${atMid.toFixed(6)}   ${((atMid / exact - 1) * 100).toFixed(2).padStart(6)}%`);
  }
  const t1 = 30 * D, t2 = 38 * D, dp = 30 * D;
  const exact = (Math.cos(t1) - Math.cos(t2)) * dp;
  chk('附件默认算例：起点法偏差约 −10.5%',
      Math.sin(t1) * 8 * D * dp / exact - 1, -0.1051, 5e-3);
  chk('附件默认算例：中点法偏差约 +0.10%',
      Math.sin(34 * D) * 8 * D * dp / exact - 1, 0.0010, 5e-3);
}

console.log('\n=== C. 附件 2D SVG 几何自检（弦长应为 2R·sinθ）===');
{
  const OX = 130, OY = 130, RD = 110;
  const th = 30, s = Math.sin(th * D), c = Math.cos(th * D);
  const xc = OX + RD * c;
  const y1 = OY - RD * s, y2 = OY + RD * s;
  chk('p_chord 弦长 / (2R·sinθ) 应为 1', Math.abs(y2 - y1) / (2 * RD * s), 1);
  chk('p_chord 到轴的距离 / (R·cosθ) 应为 1', Math.abs(xc - OX) / (RD * c), 1);
  console.log(`  说明：θ 自水平轴量起，p_chord 是纬圈在切面中的投影弦，长 2R·sinθ —— 画法正确`);
}

console.log('\n=== D. 附件 2D SVG 圆环法环带宽度是否随 θ 变 ===');
{
  console.log(`  代码 arc2('ring', al+2.4, al-2.4)：半宽固定 2.4°，不随 θ 变化`);
  console.log(`  θ=19° 时环带角宽 4.8°（占球冠 19° 的 25%）；θ=90° 时同样 4.8°（占 5.3%）`);
}

console.log('\n=== E. 参考文件 stroke3 描边上下文 bug（静态扫描）===');
{
  if (!REF || !fs.existsSync(REF)) {
    console.log(`  跳过：未提供参考文件路径（用法：node tests/verify-user-file.js <文件路径>）`);
  } else {
    const lines = fs.readFileSync(REF, 'utf8').split('\n');
    let bad = 0, where = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*ctx\.stroke\(\);/.test(lines[i])) {
        const back = lines.slice(Math.max(0, i - 40), i).join('\n');
        if (/c2\.beginPath\(\)/.test(back) && /function stroke3/.test(back)) {
          bad++; where.push(i + 1);
        }
      }
    }
    console.log(`  stroke3 内发现 ${bad} 处 ctx.stroke()，行号：${where.join(', ')}（应为 c2.stroke()）`);
    chk('确认存在该 bug', bad >= 1 ? 1 : 0, 1, 0);
  }
}

console.log('\n' + (fail === 0 ? '全部通过 ✔' : `${fail} 项失败 ✘`));
