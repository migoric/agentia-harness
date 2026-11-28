/**
 * 看板的样式表。
 *
 * 单独一个模块的理由是文件长度守卫（400 行）：页面壳 + 四个视图已经到顶，而样式是
 * 唯一「整块搬走之后不共享任何状态」的部分。拆出去不改变加载顺序 —— 它仍被同一个
 * 模板字面量拼进 `<style>`，所以「零外链」这条约束不受影响。
 */
export const BOARD_STYLE = `
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
  h2 { margin: 20px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .06em; }
  .sub { color: var(--muted); font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 14px 24px 0; flex-wrap: wrap; }
  nav button { background: none; border: 1px solid transparent; color: var(--muted);
    padding: 5px 11px; border-radius: 7px; font: inherit; font-size: 13px; cursor: pointer; }
  nav button:hover { color: var(--text); }
  nav button[aria-current="page"] { background: var(--panel); border-color: var(--line); color: var(--text); }
  main { padding: 16px 24px 40px; max-width: 1080px; }
  /* 固定 4 列而不是 auto-fill：8 张卡片会落成 5+3，第二行右侧空一大块，
     而「一块一块对齐」正是这种卡片墙唯一的美感来源 */
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  /* 资产名区分大小写（skill:Alpha 与 skill:alpha 是两个资产），不能被标签样式改成大写 */
  .card .k .mono { text-transform: none; letter-spacing: 0; font-size: 12px; }
  .card .v { font-size: 19px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .card .v.mono { font-family: var(--mono); font-size: 13px; word-break: break-all; }
  .ok { color: var(--accent); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .card.entry { margin-bottom: 10px; }
  .diff { margin: 8px 0 2px; border-left: 2px solid var(--line); padding-left: 9px; }
  .diff div { font-family: var(--mono); font-size: 12px; white-space: pre-wrap;
    word-break: break-word; line-height: 1.5; }
  .diff .add { color: var(--accent); }
  .diff .del { color: var(--bad); }
  details summary { cursor: pointer; margin: 12px 0 6px; }
  details pre { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; letter-spacing: .05em; }
  /* 表头不做 uppercase：中英混排时 "TOKEN" 与「轮次」会变成两种调性，而这里没有
     任何「标签感」需要靠大写来建立 */
  main button { font: inherit; font-size: 13px; padding: 5px 11px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  main button:hover { border-color: var(--muted); }
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
`;
