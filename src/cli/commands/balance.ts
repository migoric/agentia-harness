import { DEFAULT_PER_USD } from '../../config-balance.js';
import { HarnessError } from '../../errors.js';
import { balanceUrlOf, readBalance } from '../../run/balance.js';
import type { CliContext } from '../context.js';
import { json, say } from '../output.js';

/**
 * `harness balance` —— 账户里还有多少钱。
 *
 * 为什么值得一条命令：这个数在别处只有**间接**读法。`rsi` 的报告里有 `billed`，
 * 但那是「跑完之后扣了多少」，回答不了「现在还能不能开始跑」。而「开始跑之前先看
 * 一眼余额」恰恰是人最常做、也最该做的事 —— 尤其是账户只剩几块钱的时候。
 *
 * 退出码沿用全局口径：`2` = 端点不支持 / 没 key / 接口不通（配置或环境问题），
 * `1` 不出现在这里（「余额少」不是失败，那是一个需要人来判断的事实）。
 */
export async function balanceCommand(ctx: CliContext): Promise<number> {
  const url = balanceUrlOf(ctx.config);
  if (url === undefined) {
    // 报错里必须给出**怎么开**，否则这就是一句「不支持」—— 而用户此刻正需要它
    throw new HarnessError(
      'config.invalid',
      '这个端点没有余额接口（当前不是 DeepSeek，也没有配 balance.url）。\n' +
        '  想启用：在 harness.config.json 加一段\n' +
        '    "balance": { "url": "https://api.deepseek.com/user/balance" }\n' +
        '  （已在用 DeepSeek 却看到这句，说明 endpoint.baseURL 没写，或者写成了别的域名）',
    );
  }

  const probe = await readBalance(ctx.config);
  if (!probe.ok) {
    throw new HarnessError('config.invalid', `读不到余额：${probe.reason}`);
  }

  const s = probe.snapshot;
  const perUsd = ctx.config.balance?.perUsd ?? DEFAULT_PER_USD;
  const rows = s.entries.map((e) => ({
    currency: e.currency,
    total: e.total,
    granted: e.granted,
    toppedUp: e.toppedUp,
    // 收到 6 位：折算值给机器读时不该带一长串浮点尾巴（`--json` 是给脚本用的）
    usd: Number((e.currency === 'USD' ? e.total : e.total / perUsd).toFixed(6)),
  }));

  if (ctx.flags.json === true) {
    json({
      ok: true,
      at: new Date(s.at).toISOString(),
      url: s.url,
      available: s.available,
      perUsd,
      balances: rows,
    });
    return 0;
  }

  say(`余额（${s.url}）`);
  for (const r of rows) {
    const sym = symbolOf(r.currency);
    say(
      `  ${r.currency}  ${sym}${r.total.toFixed(2)}   赠送 ${sym}${r.granted.toFixed(2)} + 充值 ${sym}${r.toppedUp.toFixed(2)}`,
    );
    if (r.currency !== 'USD') {
      // 折算值单独一行并标出汇率来源，免得它被当成账户里真实存在的美元
      say(`        约 $${r.usd.toFixed(4)}（按 1 USD = ${perUsd} ${r.currency} 折算）`);
    }
  }
  say(`  可调用  ${s.available ? '是' : '否 —— 余额不足，任何调用都会失败'}`);
  return 0;
}

function symbolOf(currency: string): string {
  if (currency === 'USD') return '$';
  if (currency === 'CNY') return '¥';
  return `${currency} `;
}
