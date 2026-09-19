/* 最优设计方法 测试套件（第 13 个套件）
 * 覆盖：模型单调性/校准/可行性（Node 直跑）+ 页面结构（读文件断言）。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OD = require(path.join(ROOT, 'js/optimal-design.js'));
const PS = require(path.join(ROOT, 'js', 'prism-shapes.js'));
OD.bindShapes();

let pass = 0, fail = 0, fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); }
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  ' + extra : ''));
}
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

console.log('== 模型：校准与单调性 ==');
const s = OD.prismSurrogate('pyramid', 45);
ok('金字塔 α=45 萃取效率 ≈ perf MC 0.594（±0.06）', Math.abs(s.etax - 0.594) < 0.06, 'etax=' + s.etax.toFixed(3));
ok('β 在合理范围 (30–55°)', s.beta > 30 && s.beta < 55, 'β=' + s.beta.toFixed(1));
ok('U 随 Hd 升高', OD.evaluate({Td:0.9,Hd:0.2},{shape:'pyramid',alpha:45},35).U <
   OD.evaluate({Td:0.9,Hd:0.8},{shape:'pyramid',alpha:45},35).U);
ok('η_out 随 Td 升高', OD.evaluate({Td:0.82,Hd:0.5},{shape:'pyramid',alpha:45},35).etaOut <
   OD.evaluate({Td:0.97,Hd:0.5},{shape:'pyramid',alpha:45},35).etaOut);
ok('α 增 → η_out 增', OD.evaluate({Td:0.92,Hd:0.4},{shape:'pyramid',alpha:35},35).etaOut <
   OD.evaluate({Td:0.92,Hd:0.4},{shape:'pyramid',alpha:55},35).etaOut);
ok('权衡：Hd 增 → η_out 降', OD.evaluate({Td:0.95,Hd:0.2},{shape:'pyramid',alpha:50},35).etaOut >
   OD.evaluate({Td:0.95,Hd:0.9},{shape:'pyramid',alpha:50},35).etaOut);
ok('球冠萃取 < 四棱锥（回转面偏扩散）', OD.prismSurrogate('sphere',45).etax < OD.prismSurrogate('pyramid',45).etax);

console.log('== 优化器可行性 ==');
const o1 = OD.optimize(0.72, 0.72, 35);
ok('默认目标 (U72/η72) 可满足', o1.feasible, '可行 ' + o1.feasibleCount);
ok('  选中解满足双约束', o1.chosen && o1.chosen.U >= 0.72 - 1e-9 && o1.chosen.eta >= 0.72 - 1e-9,
   o1.chosen ? ('U=' + o1.chosen.U.toFixed(3) + ' η=' + o1.chosen.eta.toFixed(3)) : '无');
ok('  选中解含选材初判', o1.chosen && typeof o1.chosen.material === 'string' && o1.chosen.material.length > 0);
const o2 = OD.optimize(0.99, 0.99, 35);
ok('极苛刻目标不可满足 → 回退最近点', !o2.feasible && o2.chosen,
   o2.chosen ? ('U=' + o2.chosen.U.toFixed(3) + ' η=' + o2.chosen.eta.toFixed(3)) : '无');
ok('候选总数 = 7560（18×10×6×7）', o1.totalCount === 7560, '总数 ' + o1.totalCount);

console.log('== 页面结构 ==');
ok('tab 按钮 data-tab="opt" 存在', /data-tab="opt"/.test(html));
ok('view-opt 视图存在', /id="view-opt"/.test(html));
ok('目标滑块 od_u/od_e/od_tv 存在', /id="od_u"/.test(html) && /id="od_e"/.test(html) && /id="od_tv"/.test(html));
ok('计算按钮 od_btn 存在', /id="od_btn"/.test(html));
ok('散点画布 od_canvas 存在', /id="od_canvas"/.test(html));
ok('结果表 id 齐全', ['od_mat','od_td','od_hd','od_shape','od_alpha','od_u_r','od_e_r','od_verdict']
   .every(function (id) { return new RegExp('id="' + id + '"').test(html); }));
ok('页脚 fset data-for="opt" 存在', /class="fset" data-for="opt"/.test(html));
ok('脚本 optimal-design.js 已引入', /src="js\/optimal-design\.js"/.test(html));
ok('脚本 optimal-design-ui.js 已引入', /src="js\/optimal-design-ui\.js"/.test(html));
ok('app.js：activateTab 处理 opt', /name === 'opt' && window\.OptimalDesignUI/.test(appjs));
ok('app.js：深链白名单含 opt', /h === 'mats' \|\| h === 'opt'/.test(appjs));
ok('styles.css：#view-opt 样式存在', /#view-opt \.opt-ctl/.test(css));
ok('页脚未照搬前 3 页（opt 文案含「扩散板」而非 DIALux）',
   /data-for="opt"[\s\S]*?扩散板/.test(html) && !/data-for="opt"[\s\S]*?DIALux/.test(html));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) console.log('失败项:\n - ' + fails.join('\n - '));
process.exit(fail ? 1 : 0);
