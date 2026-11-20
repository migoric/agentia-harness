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

export function numFlag(flags: Flags, key: string): number | undefined {
  const v = strFlag(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
