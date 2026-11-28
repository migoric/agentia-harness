/**
 * `remote` 段（`rsi --remote` / `eval --remote` 的接线）。
 *
 * 单独一个文件是文件长度守卫（400 行）逼出来的，但也确实该分：`config.ts` 管的是
 * 「这个工程长什么样」，这一段管的是「哪台机器上有一份活的提示词，怎么把它换掉」——
 * 它是唯一会**写到工程之外**的配置。
 */

import { isAbsolute, resolve } from 'node:path';
import { HarnessError } from './errors.js';
import { type Fail, objectAt, onlyKeys } from './util/shape.js';

const fail: Fail = (message) => {
  throw new HarnessError('config.invalid', message);
};

/**
 * 远程服务（`rsi --remote` / `eval --remote`）的接线。
 *
 * 存在的理由只有一个：**RSI 改的提示词必须就是远程真正生效的那一份**。所以这里要求
 * 显式给出「资产目标 → 服务读的那个文件」的映射，而不是去猜目录结构 —— 猜错的表现是
 * 「每轮提案都被判没改善」，而那个症状看起来像模型不行。
 */
export interface RemoteConfig {
  /** 服务根地址，如 `http://192.168.31.112:18080` */
  readonly url: string;
  /** 凭据所在的环境变量名（不读配置里的明文，避免进 shell history 与仓库） */
  readonly tokenEnv: string;
  /** 直连某个 agent（不给就走意图层，`routedTo` 才有意义） */
  readonly agent?: string;
  /**
   * `agent:<id>` → 服务读的那个提示词文件（绝对路径，解析期已相对工程根补全）。
   *
   * 只收 `agent:` 前缀：service 侧目前只把 **agent 的系统提示词**外置了。夹具里的
   * skill 目标在远程没有对应文件，静默忽略会让「改了但没生效」看起来像模型没学好。
   */
  readonly prompts: Readonly<Record<string, string>>;
  /**
   * 显式承认：验证期间这个服务**会对外提供未验证的提示词**。
   *
   * 远程只有一份活的提示词，候选必须写进去才能被看见 —— 这是机制固有的暴露面。
   * 不默认开启，是为了让「在线上服务上跑 RSI」变成一个有人签字的动作。
   */
  readonly allowStaging: boolean;
  readonly reloadPath: string;
  readonly promptsPath: string;
}

/**
 * `remote` 段。这条链上「配错」的代价特别高：它会在服务上写文件、发重载，
 * 静默错的结果是**验证了一份没生效的提示词**。所以能拦的全在解析期拦。
 */
export function readRemote(v: unknown, root: string): { remote?: RemoteConfig } {
  if (v === undefined) return {};
  const o = objectAt(v, '配置字段 "remote"', fail);
  onlyKeys(
    o,
    '配置字段 "remote"',
    ['url', 'tokenEnv', 'agent', 'prompts', 'allowStaging', 'reloadPath', 'promptsPath'],
    fail,
  );

  const url = readString(o.url, 'remote.url');
  if (url === undefined || url.trim() === '') {
    throw new HarnessError('config.invalid', '配置字段 "remote.url" 必填');
  }
  if (!/^https?:\/\//i.test(url) || /\s/.test(url)) {
    throw new HarnessError(
      'config.invalid',
      `配置字段 "remote.url" 应是 http(s) 地址（收到 "${url}"）`,
    );
  }

  const tokenEnvRaw = readString(o.tokenEnv, 'remote.tokenEnv') ?? 'HARNESS_REMOTE_TOKEN';
  const tokenEnv = envNameOf(tokenEnvRaw, 'remote.tokenEnv');

  const agent = readString(o.agent, 'remote.agent');
  if (agent !== undefined && agent.trim() === '') {
    throw new HarnessError('config.invalid', '配置字段 "remote.agent" 不能是空串');
  }

  if (o.prompts === undefined) {
    throw new HarnessError(
      'config.invalid',
      '配置字段 "remote.prompts" 必填：至少给出一个 `agent:<id>` → 提示词文件的映射，' +
        '否则远程根本看不到候选（那正是 rsi --remote 曾经结构性无效的原因）',
    );
  }
  const rawPrompts = objectAt(o.prompts, '配置字段 "remote.prompts"', fail);
  const prompts: Record<string, string> = {};
  for (const [target, value] of Object.entries(rawPrompts)) {
    if (!/^agent:[A-Za-z0-9_.-]+$/.test(target)) {
      throw new HarnessError(
        'config.invalid',
        `"remote.prompts" 的键应是 agent:<id>（收到 "${target}"）—— ` +
          'service 侧目前只外置了 agent 的系统提示词，skill 目标在远程没有对应文件',
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new HarnessError(
        'config.invalid',
        `"remote.prompts.${target}" 应是非空字符串（提示词文件路径）`,
      );
    }
    prompts[target] = isAbsolute(value) ? value : resolve(root, value);
  }
  if (Object.keys(prompts).length === 0) {
    throw new HarnessError('config.invalid', '配置字段 "remote.prompts" 不能是空对象');
  }

  const allowStaging = o.allowStaging;
  if (allowStaging !== undefined && typeof allowStaging !== 'boolean') {
    throw new HarnessError('config.invalid', '配置字段 "remote.allowStaging" 应为布尔值');
  }

  const readPath = (value: unknown, key: string, fallback: string): string => {
    const s2 = readString(value, key) ?? fallback;
    if (!s2.startsWith('/')) {
      throw new HarnessError('config.invalid', `配置字段 "${key}" 应以 / 开头（收到 "${s2}"）`);
    }
    return s2;
  };

  return {
    remote: {
      url: url.replace(/\/+$/, ''),
      tokenEnv,
      ...(agent !== undefined ? { agent: agent.trim() } : {}),
      prompts,
      allowStaging: allowStaging === true,
      reloadPath: readPath(o.reloadPath, 'remote.reloadPath', '/admin/reload'),
      promptsPath: readPath(o.promptsPath, 'remote.promptsPath', '/admin/prompts'),
    },
  };
}

function readString(v: unknown, key: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    throw new HarnessError('config.invalid', `配置字段 "${key}" 应为字符串`);
  }
  return v;
}

function envNameOf(value: string, where: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new HarnessError(
      'config.invalid',
      `配置字段 "${where}" 应填**环境变量名**（如 DEEPSEEK_API_KEY），` +
        `key 本身放 .env（收到 "${value}"）`,
    );
  }
  return value;
}
