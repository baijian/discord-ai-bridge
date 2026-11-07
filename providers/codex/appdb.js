import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const DB = join(CODEX_HOME, 'state_5.sqlite');
const SEP = '\u001f'; // 用控制字符分隔，免得标题里的 | 把字段切错

function sql(query) {
  return execFileSync('sqlite3', ['-separator', SEP, DB, query], { encoding: 'utf8' });
}

/**
 * Codex App 的会话列表读的是 state_5.sqlite 的 threads 表（不是 session_index.jsonl）。
 * 而 `codex exec` 建出来的会话被打上 originator='codex_exec'，App 会把它们**藏起来** ——
 * 所以 CLI 建的对话在 App 里看不到。改成像 App 自己建的即可（实测有效，2026-10-13）。
 *
 * 注意：codex CLI 写 threads 表用的是 upsert，冲突时 `source = excluded.source`
 * （originator 则是 COALESCE，不会被覆盖）。也就是**每次 codex exec / exec resume 跑完，
 * source 都会被打回 'exec'**。所以必须每轮结束都调用一次，不能只在新建时调用。
 */
export function markSessionVisible(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error(`可疑的会话 id：${id}`);
  if (!existsSync(DB)) throw new Error(`找不到 ${DB}`);
  sql(`update threads set source='vscode', originator='Codex Desktop' where id='${id}';`);
  return DB;
}

/** 读 App 真实的会话列表；默认把 CLI 建的（`codex_exec`）也带上，因为桥接器建的会被标成可见 */
export function listThreads() {
  if (!existsSync(DB)) return [];
  const out = sql(
    "select id, coalesce(title,''), coalesce(rollout_path,''), coalesce(updated_at,0), " +
      "coalesce(archived,0), coalesce(cwd,''), coalesce(originator,'') from threads order by updated_at desc;"
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, title, rollout, updated, archived, cwd, originator] = line.split(SEP);
      return {
        id,
        title: title || null,
        rollout: rollout || null,
        updatedAt: Number(updated) * 1000 || 0,
        archived: archived === '1',
        cwd: cwd || null,
        originator,
      };
    });
}
