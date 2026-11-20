/**
 * Frontmatter 解析 —— 只认一个**故意做小**的 YAML 子集。
 *
 * 为什么不引 js-yaml：资产文件是**人和 RSI 都要写**的东西，语法面越小，RSI 生成
 * 的补丁越不容易在解析层就失败。这里只支持四种形态：
 *
 * ```yaml
 * name: repo-triage          # 标量（行尾 # 之后是注释）
 * version: 3                 # 数字按字符串收（版本号不需要算术）
 * tools: [read_file, grep]   # 行内数组
 * tags:
 *   - a                      # 块数组
 *   - b
 * ```
 *
 * **支持行尾注释**：`#` 前面是空白或行首才算注释（YAML 的规则）。不支持它的代价很实在
 * —— 资产是给人写的，而人在 `tools: [x]` 后面一定会加一句说明；若那会让解析直接失败，
 * 人就会学会「不要写注释」，然后几个月后没人记得某个字段为什么在那儿。
 *
 * 其余一切（嵌套对象、多行字符串、锚点）**不支持且不静默忽略** —— 遇到不认识的
 * 行直接抛，避免「写了一个字段以为生效了，其实被丢掉」这类最难查的错。
 */
export interface Frontmatter {
  readonly data: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
  /** frontmatter 在文件里占的行数（供报错定位） */
  readonly headerLines: number;
}

const DELIM = '---';

export function parseFrontmatter(text: string, source: string): Frontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIM) {
    return { data: {}, body: text, headerLines: 0 };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === DELIM);
  if (end === -1) {
    throw new Error(`${source}: frontmatter 缺少收尾的 "${DELIM}"`);
  }

  const data: Record<string, string | readonly string[]> = {};
  let openArrayKey: string | undefined;

  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? '';
    const line = stripComment(raw).trim();
    if (line === '') continue;

    if (line.startsWith('- ')) {
      if (openArrayKey === undefined) {
        throw new Error(`${source}:${i + 1}: 列表项没有归属的键（上一行应写成 "key:"）`);
      }
      const prev = data[openArrayKey];
      const arr = Array.isArray(prev) ? [...prev] : [];
      arr.push(unquote(line.slice(2).trim()));
      data[openArrayKey] = arr;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`${source}:${i + 1}: 无法解析的行 "${line}"（只支持 "key: value"）`);
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (key === '') throw new Error(`${source}:${i + 1}: 键名不能为空`);

    if (rest === '') {
      openArrayKey = key;
      data[key] = [];
      continue;
    }
    openArrayKey = undefined;
    data[key] = rest.startsWith('[') ? parseInlineArray(rest, source, i + 1) : unquote(rest);
  }

  return {
    data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n/, ''),
    headerLines: end + 1,
  };
}

/**
 * 去掉行尾注释。
 *
 * 只认「`#` 前是空白或行首」这一种（YAML 规则）—— 否则 `url: https://x/#frag` 里的
 * `#` 会被当成注释起点，那是一个比不支持注释更难查的坑。
 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseInlineArray(raw: string, source: string, lineNo: number): readonly string[] {
  if (!raw.endsWith(']')) {
    throw new Error(`${source}:${lineNo}: 行内数组缺少 "]"`);
  }
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((s) => unquote(s.trim()));
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** 取标量字段；给了数组就是配置错误（防止 "tools" 被当字符串用） */
export function scalar(fm: Frontmatter, key: string, source: string): string | undefined {
  const v = fm.data[key];
  if (v === undefined) return undefined;
  if (isListValue(v)) {
    throw new Error(`${source}: 字段 "${key}" 应为标量，收到数组`);
  }
  return v;
}

/** 取数组字段；写成标量时按单元素处理（"tools: grep" 是合理的简写） */
export function list(fm: Frontmatter, key: string): readonly string[] {
  const v = fm.data[key];
  if (v === undefined) return [];
  return isListValue(v) ? v : [v];
}

/** `Array.isArray` 对 `readonly string[]` 不窄化，故自己判 */
function isListValue(v: string | readonly string[]): v is readonly string[] {
  return typeof v !== 'string';
}
