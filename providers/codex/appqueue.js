import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Codex 的实时注入走一个共享队列：`codex queue` 往 ~/.codex/queue_1.sqlite 的 queued_items
// 插一条，触发器把 queued_thread_revisions 的 revision +1；**正加载着该 thread 的 App**
// 发现 revision 变了就取走并跑一轮 —— 所以 App 里是实时的。
//
// 硬约束（实测）：只有 App 正加载着那个 thread 时才有人消费。没加载时消息会**滞留**在
// queued_items 里，等哪天你打开它才补跑。所以走这条路必须先探测，没反应就把自己那条撤掉。
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const QUEUE_DB = join(CODEX_HOME, 'queue_1.sqlite');

/** 投递一条消息，返回 queued item 的 id（失败就抛） */
export function queueMessage(codexBin, threadId, text) {
  const out = execFileSync(codexBin, ['queue', '--thread', threadId, '--message', text], {
    encoding: 'utf8',
  });
  const m = out.match(/Queued message (\S+) for thread/);
  if (!m) throw new Error(`queue 输出无法解析：${out.trim().slice(0, 200)}`);
  return m[1];
}

/** 撤回自己投的那条（探测失败、决定走 codex exec 时用） */
export function dropQueuedItem(itemId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(itemId))) throw new Error(`可疑的 id：${itemId}`);
  execFileSync('sqlite3', [QUEUE_DB, `delete from queued_items where id='${itemId}';`]);
}

/** 从 offset 往后读完整的 JSONL 记录；末尾半行留着下次 */
export function readRolloutDelta(path, offset) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], offset };
  }
  if (size <= offset) return { records: [], offset, size };

  const len = size - offset;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  let read = 0;
  try {
    read = readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }

  const lines = buf.subarray(0, read).toString('utf8').split('\n');
  const tail = lines.pop() ?? '';
  const consumed = read - Buffer.byteLength(tail, 'utf8');

  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* 坏行跳过 */
    }
  }
  return { records, offset: offset + consumed, size };
}

/** 从一条 rollout 记录里取"能给人看的助手正文"，取不到返回 null */
export function extractAssistantText(rec) {
  if (rec?.type !== 'response_item') return null;
  const p = rec.payload ?? {};
  if (p.type !== 'message' || p.role !== 'assistant') return null;
  const parts = [];
  if (Array.isArray(p.content)) {
    for (const c of p.content) if (c?.type === 'output_text' && c.text) parts.push(c.text);
  }
  const text = parts.join('\n').trim();
  return text || null;
}

/** 这个记录是不是"这一轮结束了" */
export function isTurnDone(rec) {
  return rec?.type === 'event_msg' && rec.payload?.type === 'task_complete';
}
