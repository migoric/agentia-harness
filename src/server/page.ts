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
import { BOARD_STYLE } from './page-style.js';
import { BOARD_VIEWS } from './page-views.js';

export const BOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness · 只读看板</title>
<style>
${BOARD_STYLE}
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
  /** 账本里的 at 是毫秒数（不是 ISO 串）；缺了就是「不知道」，不是 1970 年 */
  function whenMs(ms) {
    return typeof ms === 'number' && isFinite(ms) ? new Date(ms).toLocaleString() : '—';
  }

  /*
   * 概览页要回答的是「这台机器现在怎么样」，所以不能只有四个计数：
   * 「报告 3 份」不说明最近那份过没过，「轮次 2 轮」不说明上一轮采纳了什么。
   * 这两块摘要直接复用在别的页签用过的同一批端点，不为概览新增 API ——
   * 新端点会带来新的口径，而口径一多就会出现「概览说 60%、报告页说 66%」。
   */
${BOARD_VIEWS}
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
