import { HarnessError } from '../errors.js';

/**
 * 命令行参数解析。
 *
 * 只支持 `--flag value` 与 `--flag`（布尔）两种形式 —— 刻意不做 `--flag=value`：
 * 一个工程里两种写法并存时，「为什么 `--only=a,b` 把值当成了第二个位置参数」这类
 * 问题会反复出现，而收益只是少敲一个空格。
 *
 * 位置参数（`_`）与 flag 分开收集：`harness run "解释这个报错"` 里那段任务描述
 * 本身可能含 `--`，但它不会以 `--` 开头，所以不会被误判。
 */
export type Flags = Readonly<Record<string, string | true>>;

export interface Args {
  readonly _: readonly string[];
  readonly flags: Flags;
}

export function parseArgs(argv: readonly string[]): Args {
  const rest: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (!a.startsWith('--') || a === '--') {
      rest.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { _: rest, flags };
}

export function strFlag(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function boolFlag(flags: Flags, key: string): boolean {
  return flags[key] === true;
}

/**
 * 未知 flag 一律退出码 2。此前 `--saveh report.json` 会被当成「没传 --save」，
 * 命令还返回 0 ——  CI 以为报告存过了，事后才发现目录里什么都没有。
 *
 * 调用方传的是**本命令**的白名单（全局 flag 自行并入）。
 */
export function assertKnownFlags(flags: Flags, allowed: readonly string[], cmd: string): void {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) {
      throw new HarnessError(
        'config.invalid',
        `harness ${cmd} 不认识 --${key}（可用: ${[...allowed].sort().join(', ')}）`,
      );
    }
  }
}

export function numFlag(flags: Flags, key: string): number | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  // 非数字此前返回 undefined ⇒ `--timeout abc` 等于「不超时」，而命令还报成功。
  // 预算与超时都是安全门，写错必须响亮。
  if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(Number(raw))) {
    throw new HarnessError('config.invalid', `--${key} 需要数字（收到 ${String(raw)}）`);
  }
  return Number(raw);
}

/** 逗号分隔的列表；空串与缺席都返回 undefined（「没传」与「传了空」不是一回事） */
export function csvFlag(flags: Flags, key: string): string[] | undefined {
  const v = strFlag(flags, key);
  if (v === undefined) return undefined;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return items.length > 0 ? items : undefined;
}
