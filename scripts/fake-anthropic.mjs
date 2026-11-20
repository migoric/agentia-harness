#!/usr/bin/env node
/**
 * 本地 Anthropic Messages 协议的假端点 —— 让**真实 HTTP 客户端**能在没有凭据的情况下跑通。
 *
 * 为什么需要它：`harness` 的 `run` / `eval` / `rsi` 缺省走 `createAnthropicClient()`，
 * 而单元测试一律注入 `scriptedClient`。两者之间隔着一整层真实代码：fetch、SSE 拼装、
 * 重试退避、usage → 成本的换算。那一层此前**没有任何测试**，因为它需要网络与凭据。
 *
 * 这个服务补的正是那一段，但必须说清它**不是什么**：它不产生真实模型输出，
 * 所以「提示词写得好不好」这类问题它答不了。它能答的是「线协议这一段有没有接错」。
 *
 * 用法：
 *   node scripts/fake-anthropic.mjs --port 8787
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=fake harness run "..."
 *
 * 故障注入（验证重试 / 超时 / 截断这些分支，否则它们永远只在读代码时「看起来对」）：
 *   --fail-first 2        前 2 个请求回 500（客户端该退避重试）
 *   --rate-limit-first 1  前 1 个请求回 429 + retry-after: 0
 *   --truncate            发完 text_delta 就断开，不发 message_stop
 *   --slow 500            每个请求先睡 500ms（配合 --timeout 验证超时）
 *   --no-usage            不报 usage（客户端应标成「未上报」而不是 0）
 */
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const port = Number(flag('port', '8787'));
const failFirst = Number(flag('fail-first', '0'));
const rateLimitFirst = Number(flag('rate-limit-first', '0'));
const slowMs = Number(flag('slow', '0'));
const truncate = has('truncate');
const noUsage = has('no-usage');

/** 请求计数 —— 故障注入按「第几个请求」而非「第几次会话」计，重试才测得到 */
let served = 0;
const log = (line) => process.stderr.write(`[fake-anthropic] ${line}\n`);

// —— SSE 组装 ——

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 把一份「回复」写成 SSE 流。
 *
 * 分片发而不是整段发：客户端的 `text_delta` 累积逻辑只有多片时才被真正执行过
 * （单片时「拼起来等于原文」恒成立，测不出拼接 bug）。
 */
function writeStream(res, { text, toolUse, stopReason, usage }) {
  const chunks = [];
  const id = `msg_${Date.now().toString(36)}`;

  chunks.push(
    sse('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: usage.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        ...(noUsage ? {} : { usage: { input_tokens: usage.inputTokens, output_tokens: 1 } }),
      },
    }),
  );

  if (toolUse !== undefined) {
    chunks.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_${id}`, name: toolUse.name, input: {} },
      }),
    );
    // 分两片发：`input_json_delta` 的累积是「字符串拼接后再 parse」，
    // 只发一片就测不出「中间态是非法 JSON」这种情况
    const json = JSON.stringify(toolUse.input);
    const cut = Math.floor(json.length / 2);
    for (const part of [json.slice(0, cut), json.slice(cut)]) {
      chunks.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: part },
        }),
      );
    }
  } else {
    chunks.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    for (const part of splitText(text)) {
      chunks.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: part },
        }),
      );
    }
  }

  chunks.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));

  if (truncate) {
    // 只写到 block_stop：没有 message_delta / message_stop ⇒ 客户端必须判「截断」
    res.end(chunks.join(''));
    return;
  }

  chunks.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      ...(noUsage ? {} : { usage: { output_tokens: usage.outputTokens } }),
    }),
  );
  chunks.push(sse('message_stop', { type: 'message_stop' }));
  res.end(chunks.join(''));
}

/** 按句读切，保证「多片」这件事真的发生 */
function splitText(text) {
  const parts = String(text).match(/[^。！？\n]*[。！？\n]?/g) ?? [];
  return parts.filter((p) => p.length > 0);
}

// —— 「模型」——

/**
 * 决定回什么。
 *
 * 规则刻意极简（判据只看请求内容，不看会话状态），因为这里要验证的是**传输层**，
 * 一个会「记住上下文」的假模型只会引入它自己的 bug：
 *
 * 0. `system` 是提案器（含「提示词工程师」）⇒ 取当前正文、追加一行标记后原样返回
 *    —— 这是唯一能让 RSI 闭环**真的走完采纳**的办法：追加的那行会改变技能分支的判据
 * 1. 最后一条消息里有 `tool_result` ⇒ 工具已经回来了，给最终结论（结束本轮）
 * 2. `system` 是技能正文（含「摘要器」）⇒ 给技能该给的三条要点
 * 3. 其余 ⇒ 调第一个可用工具（走通 tool_use 往返）
 */
// 必须**不在**原技能正文里：`init` 的 SKILL.md 写着「输出恰好三条要点」，
// 用它当标记会让基线就已经「通过」，闭环永远走不到采纳
const MARKER = '校准标记';

function decide(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = systemText(body.system);

  if (system.includes('提示词工程师')) {
    const body0 = currentBodyOf(lastUserText(messages));
    if (body0 === null) return { text: 'NONE', stopReason: 'end_turn' };
    // 追加而不是重写：`assertSane` 会拒「没改动」与「超过 3 倍」，追加两行正好在中间
    return {
      text: `${body0}\n\n输出中必须出现「${MARKER}」这四个字。`,
      stopReason: 'end_turn',
    };
  }

  const last = messages[messages.length - 1];
  const lastHasToolResult =
    last !== undefined &&
    Array.isArray(last.content) &&
    last.content.some((b) => b?.type === 'tool_result');

  if (lastHasToolResult) {
    // 读回工具结果再总结 —— 真实模型就是这样：技能正文变了，它的输出会变，
    // 最终回答跟着变。假模型若不回读，RSI 的「改正文 → 用例变好」在端点上永远不成立
    const echoed = toolResultText(last.content);
    return {
      text: echoed.includes(MARKER)
        ? `结论：已压缩完成，三条要点如下（已带${MARKER}）。`
        : '结论：已压缩完成。要点见上，共三条，均来自原文。',
      stopReason: 'end_turn',
    };
  }

  if (system.includes('摘要器')) {
    return {
      // 技能的回答随自身正文变化 —— RSI 改了正文，这条输出就跟着变，
      // 否则「采纳 → 复跑通过」在假端点上永远不成立
      text: system.includes(MARKER)
        ? `要点一：基于类型化契约的 agent 运行时（${MARKER}）。\n要点二：提供 trace、审批与断点续跑。\n要点三：不内置编排图与向量库。`
        : '要点一：基于类型化契约的 agent 运行时。\n要点二：提供 trace、审批与断点续跑。\n要点三：不内置编排图与向量库。',
      stopReason: 'end_turn',
    };
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const first = tools[0];
  if (first !== undefined && typeof first.name === 'string') {
    return {
      toolUse: { name: first.name, input: { task: lastUserText(messages) } },
      stopReason: 'tool_use',
    };
  }

  return { text: '结论：没有可用工具，直接回答。', stopReason: 'end_turn' };
}

/**
 * `system` 有两种线上的形态：纯字符串（技能走 `runCapabilityLoop`，传的是正文原文）
 * 与块数组（`SystemPrompt` 加过 label 之后，如主 agent 与提案器）。
 * 只认字符串会让「主 agent / 提案器」一律落进兜底分支 —— 这个 bug 真的发生过。
 */
function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}

/** 把最后一条 user 消息里的 tool_result 全部拼成文本（content 可能是字符串或块数组） */
function toolResultText(content) {
  const parts = [];
  for (const block of content ?? []) {
    if (block?.type !== 'tool_result') continue;
    if (typeof block.content === 'string') parts.push(block.content);
    else if (Array.isArray(block.content)) {
      for (const b of block.content) if (typeof b?.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

/** 从提案 prompt 的 `"""` 围栏里取出当前正文（围栏有多处，取「当前正文」后面那段） */
function currentBodyOf(prompt) {
  const at = prompt.indexOf('当前正文');
  if (at === -1) return null;
  const head = prompt.indexOf('"""', at);
  if (head === -1) return null;
  const start = head + 3;
  const end = prompt.indexOf('"""', start);
  if (end === -1) return null;
  return prompt.slice(start, end).replace(/^\n/, '').replace(/\n$/, '');
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const text = (m.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) return text;
  }
  return '';
}

// —— HTTP ——

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'not_found', message: `${req.method} ${req.url}` } }));
    return;
  }

  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', async () => {
    served += 1;
    const n = served;

    let body;
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'bad json' } }));
      return;
    }

    if (n <= failFirst) {
      log(`#${n} 注入 500`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'injected 500' } }));
      return;
    }
    if (n <= rateLimitFirst) {
      log(`#${n} 注入 429`);
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '0',
      });
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'injected 429' } }));
      return;
    }

    if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));

    const reply = decide(body);
    if (process.env.FAKE_DEBUG) {
      log(
        `  reply=${JSON.stringify((reply.toolUse ? `tool:${reply.toolUse.name}` : reply.text).slice(0, 80))}`,
      );
    }
    const usage = {
      model: body.model,
      // 输入 token 按字符数粗算：数值本身不重要，重要的是「非零且随请求变化」——
      // 恒定值会让「成本算错」这类 bug 在断言里看起来也对
      inputTokens: Math.max(1, JSON.stringify(body.messages ?? []).length >> 2),
      outputTokens: Math.max(1, String(reply.text ?? '').length >> 2),
    };
    log(
      `#${n} ${reply.toolUse ? `tool_use:${reply.toolUse.name}` : 'text'} ` +
        `model=${usage.model} in=${usage.inputTokens} out=${usage.outputTokens}`,
    );

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    writeStream(res, { ...reply, usage });
  });
});

server.listen(port, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${port}`);
  // 打印一行给父进程读：调用方靠它判断「起来了」而不是 sleep 猜
  process.stdout.write(`ready ${port}\n`);
});
