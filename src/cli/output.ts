/** 输出走这两个函数，便于测试时替换（也让「JSON 模式只输出一行 JSON」这件事有一个开关） */
export function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
