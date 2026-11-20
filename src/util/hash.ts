import { createHash } from 'node:crypto';

/**
 * 资产内容指纹。
 *
 * RSI 要回答的第一个问题是「这次行为变化是不是因为换了资产」，所以指纹必须
 * **覆盖正文**（改一个标点也要变），且**稳定**（同一内容任何时候算出来一样）。
 * 取 12 位前缀：足够避免碰撞，又能在 lock 文件里一眼看全。
 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}
