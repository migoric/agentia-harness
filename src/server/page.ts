/**
 * 只读看板的单页 HTML。
 *
 * 为什么内联成 TS 字符串而不是 `assets/` 里的 .html：
 *
 * 1. **构建不做静态拷贝**。`tsc` 只产 `.js`，`dist/` 里不会有 sibling 的 `.html`；
 *    要拷就得加一步构建脚本，而那一步漏掉时的表现是「开发环境好使、装出来的包
 *    首页 404」—— 这类 bug 排查成本远高于它省下的那点可读性。
 * 2. **它没有独立演化的需求**。看板与 `/api/*` 是同一份契约的两端，同步改动本来就是
 *    常态；拆成两个文件只会让「改了 API 忘了改页面」变成更可能的事。
 *
 * 三条约束写在代码里：
 *
 * - **零外链**。没有 CDN、没有字体、没有图标库 —— 内网部署时外链要么拖慢首屏，
 *   要么在断网时让整页空白。
 * - **纯读**。页面只发 GET，唯一的写操作是 `sessionStorage` 存 key。
 * - **数据一律走 `textContent`**。报告名、失败用例原文、账本正文都来自工作区，
 *   用 `innerHTML` 拼接等于把「谁能在 evals/ 里写文件」变成「谁能在这个域里执行脚本」。
 */
export const BOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness · 只读看板</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #ffffff; --line: #e4e2dc; --text: #1b1a17;
    --muted: #6f6b63; --accent: #2f6f4f; --warn: #9a5b12; --bad: #9c2b2b;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15151a; --panel: #1d1d23; --line: #2d2d36; --text: #e9e9ec;
      --muted: #9b9ba6; --accent: #6cc49a; --warn: #d8a05a; --bad: #e07b7b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; }
  header { padding: 18px 24px 0; }
  h1 { margin: 0 0 2px; font-size: 17px; font-weight: 600; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 14px 24px 0; flex-wrap: wrap; }
  nav button { background: none; border: 1px solid transparent; color: var(--muted);
    padding: 5px 11px; border-radius: 7px; font: inherit; font-size: 13px; cursor: pointer; }
  nav button:hover { color: var(--text); }
  nav button[aria-current="page"] { background: var(--panel); border-color: var(--line); color: var(--text); }
  main { padding: 16px 24px 40px; max-width: 1080px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .card .v { font-size: 19px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .card .v.mono { font-family: var(--mono); font-size: 13px; word-break: break-all; }
  .ok { color: var(--accent); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: 0; }
  td.mono, .mono { font-family: var(--mono); font-size: 12px; }
  tbody tr[data-name] { cursor: pointer; }
  tbody tr[data-name]:hover { background: color-mix(in oklab, var(--accent) 7%, transparent); }
  pre { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px 14px; overflow: auto; max-height: 60vh; font-family: var(--mono); font-size: 12px; }
  .hint { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
  .empty { color: var(--muted); padding: 18px 0; }
  form { display: flex; gap: 8px; align-items: center; margin: 10px 0; }
  input[type=password] { background: var(--panel); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 6px 10px; font: inherit; min-width: 240px; }
  button.primary { background: var(--accent); color: #fff; border: 0; border-radius: 8px;
    padding: 7px 13px; font: inherit; cursor: pointer; }
  code { font-family: var(--mono); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>harness · 只读看板</h1>
  <div class="sub">只读：写工作区（evals / assets / journal）只在 CLI 与 <code>rsi --watch</code> 里</div>
</header>
<nav id="nav"></nav>
<main id="main"><div class="empty">载入中…</div></main>
<script>
(function () {
  var TABS = [
    { id: 'overview', label: '概览' },
    { id: 'reports', label: '报告' },
    { id: 'cycles', label: '轮次' },
    { id: 'journal', label: '账本' }
  ];
  var main = document.getElementById('main');
  var nav = document.getElementById('nav');
  var current = 'overview';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function key() { return sessionStorage.getItem('harness-key') || ''; }
  function api(path) {
    var headers = {};
    var k = key();
    if (k) headers.authorization = 'Bearer ' + k;
    return fetch(path, { headers: headers }).then(function (r) {
      if (r.status === 401) throw new Error('unauthorized');
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 200)); });
      return r.json();
    });
  }
  function askKey() {
    main.textContent = '';
    main.appendChild(el('p', 'hint', '这个服务配了鉴权。key 只存在本标签页的 sessionStorage 里，不会发到别处。'));
    var f = el('form');
    var input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'authorization: Bearer …';
    var btn = el('button', 'primary', '载入');
    btn.type = 'submit';
    f.appendChild(input); f.appendChild(btn);
    f.onsubmit = function (e) {
      e.preventDefault();
      sessionStorage.setItem('harness-key', input.value.trim());
      render(current);
    };
    main.appendChild(f);
    input.focus();
  }
  function guard(p) {
    return p.catch(function (e) {
      if (String(e.message) === 'unauthorized') { askKey(); return new Promise(function () {}); }
      throw e;
    });
  }
  function table(headers, rows) {
    var t = el('table');
    var thead = el('thead');
    var tr = el('tr');
    headers.forEach(function (h) { tr.appendChild(el('th', '', h)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (cells) {
      var r = el('tr');
      cells.forEach(function (c) {
        var td = el('td', c && c.cls ? c.cls : '', c && c.text !== undefined ? c.text : c);
        r.appendChild(td);
      });
      if (cells.attrs) Object.keys(cells.attrs).forEach(function (a) { r.setAttribute(a, cells.attrs[a]); });
      tb.appendChild(r);
    });
    t.appendChild(tb);
    return t;
  }
  function pct(n) { return (n * 100).toFixed(1) + '%'; }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }

  function viewOverview() {
    return guard(api('/api/workspace')).then(function (w) {
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
      main.appendChild(el('p', 'hint',
        '工作区 ' + w.workspaceDir + ' · worker：' + w.worker.reason + ' · 读数 ' + when(w.at)));
    });
  }

  function viewReports() {
    return guard(api('/api/reports')).then(function (d) {
      main.textContent = '';
      if (!d.reports.length) {
        main.appendChild(el('div', 'empty', '还没有报告。跑一次并指定目录：harness eval --save .workspace/reports/' + new Date().toISOString().slice(0, 10) + '.json'));
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
        var name = tr.getAttribute('data-name');
        guard(api('/api/reports/' + encodeURIComponent(name))).then(function (one) {
          main.textContent = '';
          var back = el('button', '', '← 返回列表');
          back.onclick = function () { render('reports'); };
          main.appendChild(back);
          main.appendChild(el('p', 'hint', name + ' · ' + when(one.mtime) + ' · ' + one.sizeBytes + ' 字节'));
          main.appendChild(el('pre', '', JSON.stringify(one.raw, null, 2)));
        });
      });
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

  function viewJournal() {
    return guard(api('/api/rsi/journal?limit=100')).then(function (d) {
      main.textContent = '';
      if (!d.entries.length) {
        main.appendChild(el('div', 'empty', '账本是空的（还没采纳过任何改动）。'));
        return;
      }
      main.appendChild(el('p', 'hint', '共 ' + d.total + ' 条，这里显示最近 ' + d.entries.length + ' 条（append-only，回滚依据）'));
      main.appendChild(el('pre', '', d.entries.map(function (x) { return JSON.stringify(x); }).join('\\n')));
    });
  }

  var VIEWS = { overview: viewOverview, reports: viewReports, cycles: viewCycles, journal: viewJournal };

  function render(id) {
    current = id;
    nav.textContent = '';
    TABS.forEach(function (t) {
      var b = el('button', '', t.label);
      if (t.id === id) b.setAttribute('aria-current', 'page');
      b.onclick = function () { render(t.id); };
      nav.appendChild(b);
    });
    main.textContent = '';
    main.appendChild(el('div', 'empty', '载入中…'));
    VIEWS[id]().catch(function (e) {
      main.textContent = '';
      main.appendChild(el('p', 'bad', '载入失败：' + e.message));
    });
  }

  render('overview');
})();
</script>
</body>
</html>
`;
