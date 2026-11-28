/**
 * 看板的四个视图。
 *
 * 与 `page.ts` 共用同一个 `<script>` 作用域（两者在同一个模板字面量里拼接），所以
 * 这里直接使用 `page.ts` 里的 `el` / `api` / `guard` / `table` 等工具函数，
 * 不重复声明 —— 重复声明会让「同一个表格渲染在概览与报告页长得不一样」。
 */
export const BOARD_VIEWS = `
  function viewOverview() {
    return guard(Promise.all([api('/api/workspace'), api('/api/reports'), api('/api/rsi/cycles')]))
      .then(function (all) {
      var w = all[0];
      var reps = all[1].reports;
      var cyc = all[2].cycles;
      main.textContent = '';
      var g = el('div', 'grid');
      function card(k, v, cls) {
        var c = el('div', 'card');
        c.appendChild(el('div', 'k', k));
        c.appendChild(el('div', 'v ' + (cls || ''), v));
        g.appendChild(c);
      }
      card('资产指纹', (w.assets || '').slice(0, 12), 'mono');
      card('磁盘指纹', w.assetsOnDisk === null ? '读不动' : w.assetsOnDisk.slice(0, 12),
        'mono ' + (w.assetDrift === null ? 'warn' : w.assetDrift ? 'bad' : 'ok'));
      card('资产漂移', w.assetDrift === null ? '未知' : w.assetDrift ? '进程是旧的' : '一致',
        w.assetDrift === null ? 'warn' : w.assetDrift ? 'bad' : 'ok');
      card('worker', w.worker.running ? '在跑' : '空闲', w.worker.running ? 'ok' : '');
      card('评测用例', w.counts.evals, '');
      card('报告', w.counts.reports, '');
      card('轮次', w.counts.cycles, '');
      card('账本条目', w.counts.journalEntries, '');
      main.appendChild(g);

      main.appendChild(el('h2', '', '最近一份报告'));
      if (!reps.length) {
        main.appendChild(el('p', 'hint', '还没有报告 —— 跑一次：harness eval --save（不带路径就写进这里）'));
      } else {
        var r = reps[0];
        var rt = table(['文件', '时间', '通过', '路由', '成本'],
          [[{ text: r.name, cls: 'mono' }, when(r.mtime),
            { text: pct(r.passRate) + ' (' + r.passed + '/' + r.total + ')',
              cls: r.passRate === 1 ? 'ok' : 'bad' },
            r.routeAccuracy === undefined ? '—' : pct(r.routeAccuracy) + ' (' + r.routeCases + ')',
            r.costKnown ? '$' + r.costUsd.toFixed(4) : '未知']]);
        // 概览也能点进去：看到 66.7% 之后，下一个问题必然是「哪条坏了」
        var rtb = rt.querySelector('tbody');
        if (rtb) {
          rtb.style.cursor = 'pointer';
          rtb.addEventListener('click', function () { void showReport(r.name, 'overview'); });
        }
        main.appendChild(rt);
      }

      main.appendChild(el('h2', '', '最近一轮 RSI'));
      if (!cyc.length) {
        main.appendChild(el('p', 'hint', '还没有轮次记录 —— 跑一次：harness rsi'));
      } else {
        var c0 = cyc[0];
        main.appendChild(table(['轮次', '时间', '验证', '采纳', '目标'],
          [[{ text: c0.cycleId, cls: 'mono' }, when(c0.at), c0.verified,
            { text: c0.accepted, cls: c0.accepted > 0 ? 'ok' : '' },
            c0.targets.join(' ') || '—']]));
      }

      main.appendChild(el('p', 'hint',
        '工作区 ' + w.workspaceDir + ' · worker：' + w.worker.reason + ' · 读数 ' + when(w.at)));
    });
  }

  function viewReports() {
    return guard(api('/api/reports')).then(function (d) {
      main.textContent = '';
      if (!d.reports.length) {
        main.appendChild(el('div', 'empty', '还没有报告。跑一次：harness eval --save（不带路径就写进这个目录）'));
      } else {
        main.appendChild(table(['文件', '时间', '通过', '路由准确率', '成本', '结构版本'],
          d.reports.map(function (r) {
            var cells = [
              { text: r.name, cls: 'mono' },
              when(r.mtime),
              pct(r.passRate) + ' (' + r.passed + '/' + r.total + ')',
              r.routeAccuracy === undefined ? '—' : pct(r.routeAccuracy) + ' (' + r.routeCases + ')',
              r.costKnown ? '$' + r.costUsd.toFixed(4) : '未知',
              'v' + r.schemaVersion
            ];
            cells.attrs = { 'data-name': r.name };
            return cells;
          })));
      }
      if (d.invalid.length) {
        main.appendChild(el('p', 'hint', '有 ' + d.invalid.length + ' 个文件读不动：' +
          d.invalid.map(function (x) { return x.name + '（' + x.reason + '）'; }).join('；')));
      }
      var t = main.querySelector('tbody');
      if (t) t.addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-name]');
        if (!tr) return;
        void showReport(tr.getAttribute('data-name'), 'reports');
      });
    });
  }

  /**
   * 报告详情。抽出来是因为有两个入口（报告列表、概览页的「最近一份报告」）——
   * 两处各写一遍的结果必然是「一个能看到失败原因、另一个只能看到 JSON」。
   */
  function showReport(name, backTo) {
    return guard(api('/api/reports/' + encodeURIComponent(name))).then(function (one) {
      main.textContent = '';
      var back = el('button', '', backTo === 'overview' ? '← 返回概览' : '← 返回列表');
      back.onclick = function () { render(backTo); };
      main.appendChild(back);
      main.appendChild(el('p', 'hint', name + ' · ' + when(one.mtime) + ' · ' + one.sizeBytes + ' 字节'));
      viewReportDetail(main, one.raw, name);
    });
  }

  function viewCycles() {
    return guard(api('/api/rsi/cycles')).then(function (d) {
      main.textContent = '';
      if (!d.cycles.length) {
        main.appendChild(el('div', 'empty', '还没有轮次记录。跑一次：harness rsi'));
        return;
      }
      main.appendChild(table(['轮次', '时间', '验证', '采纳', '目标', '试跑'],
        d.cycles.map(function (c) {
          var cells = [
            { text: c.cycleId, cls: 'mono' },
            when(c.at),
            c.verified,
            c.accepted + (c.acceptedIds.length ? '（' + c.acceptedIds.join(', ') + '）' : ''),
            c.targets.join(' ') || '—',
            c.dryRun ? '是' : '否'
          ];
          cells.attrs = { 'data-id': c.cycleId };
          return cells;
        })));
      var t = main.querySelector('tbody');
      t.addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        var id = tr.getAttribute('data-id');
        guard(api('/api/rsi/cycles/' + encodeURIComponent(id))).then(function (one) {
          main.textContent = '';
          var back = el('button', '', '← 返回列表');
          back.onclick = function () { render('cycles'); };
          main.appendChild(back);
          main.appendChild(el('pre', '', JSON.stringify(one.cycle, null, 2)));
        });
      });
    });
  }

  /*
   * 账本：每条一卡，给出「改了什么、为什么、谁批准」。
   *
   * 之前这一页是把整行 JSON 拼起来塞进 <pre>：一条记录 1500 字，人眼要在一行里找
   * before 与 after 的差别 —— 而这页存在的唯一理由就是看那个差别。所以这里
   * 做行级 diff，**原始记录仍然完整**（details 里），因为账本是审计证据，
   * 渲染层不能成为「看不到原文」的原因。
   */
  function viewJournal() {
    return guard(api('/api/rsi/journal?limit=100')).then(function (d) {
      main.textContent = '';
      if (!d.entries.length) {
        main.appendChild(el('div', 'empty', '账本是空的（还没采纳过任何改动）。'));
        return;
      }
      main.appendChild(el('p', 'hint', '共 ' + d.total + ' 条，这里显示最近 ' + d.entries.length + ' 条（append-only，回滚依据）'));
      // 文件是 append-only，所以文件顺序是旧的在前；这一页要的是「最近改了什么」
      d.entries.slice().reverse().forEach(function (x) { main.appendChild(journalCard(x)); });
    });
  }

  /*
   * 行级 diff：只找「新增的行」与「消失的行」，不做 LCS。
   *
   * 刻意不引入 diff 库，也不做真正的编辑距离：账本里改的是提示词正文，改法基本是
   * 「追加一段」或「换掉一句」。行集合差能把这两类讲清楚，而 LCS 在几十行的正文上
   * 会产出更难读的碎片。同一行重复出现时这里会漏掉一次的增删 —— 它是**显示**工具，
   * 判据永远是 before / after 原文，不是这个视图。
   */
  function lineDiff(before, after) {
    var b = before.split('\\n');
    var a = after.split('\\n');
    var inB = {}; var inA = {};
    b.forEach(function (l) { inB[l] = true; });
    a.forEach(function (l) { inA[l] = true; });
    var out = [];
    b.forEach(function (l) { if (!inA[l]) out.push({ t: '-', s: l }); });
    a.forEach(function (l) { if (!inB[l]) out.push({ t: '+', s: l }); });
    return out;
  }

  function journalCard(x) {
    var status = x.status === 'accepted' ? '已采纳' : x.status === 'reverted' ? '已回滚' : String(x.status);
    var card = el('div', 'card entry');
    var head = el('div', 'k');
    head.appendChild(document.createTextNode(status + ' · '));
    head.appendChild(el('span', 'mono', x.target || '—'));
    head.appendChild(document.createTextNode(' · ' + whenMs(x.at)));
    card.appendChild(head);
    if (x.reason) card.appendChild(el('p', 'hint', x.reason));
    var diff = el('div', 'diff');
    var lines = lineDiff(String(x.before || ''), String(x.after || ''));
    if (!lines.length) diff.appendChild(el('div', '', '（正文没有行级差异）'));
    lines.forEach(function (l) {
      diff.appendChild(el('div', l.t === '+' ? 'add' : 'del', l.t + ' ' + l.s));
    });
    card.appendChild(diff);
    var meta = [];
    if (x.proposalId) meta.push('proposal ' + x.proposalId);
    if (x.assetsAfter) meta.push('资产 ' + String(x.assetsAfter).slice(0, 12));
    if (x.kind === 'code') meta.push('代码补丁（L2）');
    if (x.reverted) meta.push('由回滚产生');
    if (meta.length) card.appendChild(el('p', 'hint', meta.join(' · ')));
    var det = el('details');
    det.appendChild(el('summary', 'hint', '原始记录'));
    det.appendChild(el('pre', '', JSON.stringify(x)));
    card.appendChild(det);
    return card;
  }

  function viewReportDetail(host, raw, name) {
    var cases = (raw && raw.cases) || [];
    if (raw && raw.routeAccuracy !== undefined) {
      host.appendChild(el('p', 'hint',
        '路由准确率 ' + pct(raw.routeAccuracy) + '（' + (raw.routeCases || 0) + ' 条用例声明了 route）'));
    }
    host.appendChild(table(['用例', '结果', 'token', '轮次', '路由', '失败原因'],
      cases.map(function (c) {
        var route = '—';
        if (c.routedTo !== undefined || c.expectRoute !== undefined) {
          route = (c.routedTo || '未知') +
            (c.expectRoute === undefined ? '' : (c.routedTo === c.expectRoute ? ' ✓' : ' ✗ 期望 ' + c.expectRoute));
        }
        return [
          { text: c.name, cls: 'mono' },
          { text: c.passed ? '通过' : '失败', cls: c.passed ? 'ok' : 'bad' },
          c.tokens,
          c.iterations,
          route,
          (c.failures || []).join('；') || '—'
        ];
      })));
    var det = el('details');
    det.appendChild(el('summary', 'hint', '原始 JSON（' + name + '）'));
    det.appendChild(el('pre', '', JSON.stringify(raw, null, 2)));
    host.appendChild(det);
  }

`;
