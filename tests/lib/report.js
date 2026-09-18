#!/usr/bin/env node
/* ============================================================
 * tests/lib/report.js —— 套件结果统计与「假绿灯」防护
 *
 * 为什么需要它：
 *   本项目已被同一类缺陷伤过两次，形式不同但本质一样 ——
 *   **流程"看起来成功"而实际什么都没做**：
 *     · STEP 导出：OCCT 的 ReadFile 返回 RetDone，而 TransferRoots()=0、
 *       NbShapes()=0，不报错却一个几何都没读进来。
 *     · CI/本地测试：套件"跑过一遍"，而其中某个环节被 SKIP 掉，
 *       汇总行照样打印"通过 N 项"，看起来全绿。
 *   汇总行只报"通过几项"是不够的：0 项通过 + 0 项失败 也是"全绿"。
 *   因此这里强制汇总里带上 **总断言数**，并把关键环节的 SKIP
 *   升级为失败（由调用方通过 required 标记）。
 *
 * 用法：
 *   const { createReporter } = require('./lib/report');
 *   const rep = createReporter('浏览器冒烟');
 *   rep.ok('名字', cond, '细节');       // 布尔断言
 *   rep.eq('名字', got, want);          // 等值断言
 *   rep.skip('名字', '为什么跳过');      // 计数式跳过（会写进汇总）
 *   rep.require('名字', cond, '细节');   // 关键断言：失败即整轮失败
 *   rep.finish();                       // 打印汇总并设置退出码
 * ============================================================ */
'use strict';

function fmt(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

/* 失败明细必须**短**。实测踩过：某一项的细节里带了 Chrome 完整 stderr，
   几千字的多行报错把汇总里其它失败项全挤到屏幕外 —— 失败信息本身
   把失败信息淹了。这里统一压成单行、截断到 DET_MAX。 */
const DET_MAX = 160;
function oneLine(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > DET_MAX ? t.slice(0, DET_MAX) + ' …' : t;
}

function createReporter(title) {
  const st = { pass: 0, fail: 0, skip: 0, detail: [] };
  const pad = (s, n) => String(s).padEnd(n);

  const rep = {
    ok(name, cond, extra) {
      const good = !!cond;
      good ? st.pass++ : st.fail++;
      if (!good) st.detail.push(name + (extra ? '  →  ' + oneLine(extra) : ''));
      console.log(`${good ? 'PASS' : 'FAIL'}  ${pad(name, 48)}${extra === undefined ? '' : ' ' + oneLine(extra)}`);
      return good;
    },
    eq(name, got, want) {
      const good = String(got) === String(want);
      good ? st.pass++ : st.fail++;
      if (!good) st.detail.push(name + '  →  got=' + oneLine(fmt(got)) + ' want=' + oneLine(fmt(want)));
      console.log(`${good ? 'PASS' : 'FAIL'}  ${pad(name, 48)} got=${oneLine(fmt(got))} want=${oneLine(fmt(want))}`);
      return good;
    },
    /* 明确被跳过 —— 单列一项，且会体现在汇总的「跳过 N 项」里。
       裸 console.log('跳过') 不计入任何计数，是本文件要防的假绿灯。 */
    skip(name, why) {
      st.skip++;
      console.log(`SKIP  ${pad(name, 48)} ${oneLine(why)}`);
    },
    /* 关键断言：与 ok 的区别只在于它一定会出现在失败清单里，
       且调用方可用 rep.criticalFailed() 决定是否整轮判负。 */
    require(name, cond, extra) {
      rep.ok(name, cond, extra);
      if (!cond) st.critFail = (st.critFail || 0) + 1;
    },
    get stats() { return { ...st }; },
    criticalFailed() { return (st.critFail || 0) > 0; },
    finish(extraExitCondition) {
      const total = st.pass + st.fail;
      console.log('\n' + '-'.repeat(64));
      /* 关键：汇总行必须带**总断言数**。
         "通过 0 项，失败 0 项" 曾经等于"全绿"，这正是要堵的洞。 */
      let line = `${title}：通过 ${st.pass} 项，失败 ${st.fail} 项`;
      if (st.skip) line += `，跳过 ${st.skip} 项`;
      line += `（断言总数 ${total}）`;
      console.log(line);
      if (st.skip) console.log(`       ⚠ 本轮有 ${st.skip} 项被跳过 —— 这些性质未被验证`);
      if (st.fail) {
        console.log('       失败明细：');
        for (const d of st.detail.slice(0, 20)) console.log('         · ' + d);
      }
      console.log('-'.repeat(64));
      const bad = st.fail > 0 || total === 0 || !!extraExitCondition;
      process.exit(bad ? 1 : 0);
    }
  };
  return rep;
}

module.exports = { createReporter };

