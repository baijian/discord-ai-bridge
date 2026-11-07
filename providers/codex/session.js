import { existsSync, statSync } from 'node:fs';
import { listThreads } from './appdb.js';

// Codex 的会话真身在 App 的数据库里（~/.codex/state_5.sqlite 的 threads 表），
// 不是 session_index.jsonl —— 后者 App 根本不读（实测：往它追加一条，App 里不会出现）。
// threads 表里有标题、rollout 路径、更新时间、归档标记，够了。

function statOf(p) {
  if (!p) return null;
  try {
    const st = statSync(p);
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function listSessions() {
  return listThreads()
    .map((t) => {
      const st = statOf(t.rollout);
      return {
        id: t.id,
        appId: null,
        kind: 'codex',
        title: t.title,
        cwd: t.cwd,
        configDir: null,
        path: t.rollout,
        exists: Boolean(st),
        archived: t.archived,
        originator: t.originator,
        mtime: st?.mtimeMs ?? t.updatedAt,
        size: st?.size ?? 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// 按 id 或唯一前缀找会话。`/list` 只展示 8 位短 id，所以必须支持前缀。
export function matchSession(sessions, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;

  const exact = sessions.find((s) => s.id === raw);
  if (exact) return exact;

  const q = raw.toLowerCase();
  if (q.length < 4) return null;
  const hits = sessions.filter((s) => s.id.toLowerCase().startsWith(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const lines = hits.slice(0, 5).map((s) => `· \`${s.id.slice(0, 8)}\` 「${s.title ?? '(无标题)'}」`);
    throw new Error(`前缀 ${raw} 匹配到 ${hits.length} 个对话，请多给几位：\n${lines.join('\n')}`);
  }
  return null;
}

export function pickSession(cfg, ref = null) {
  const all = listSessions();
  if (!all.length) throw new Error('找不到任何 Codex 会话（先在 Codex 里聊一句）');

  const wanted = ref || cfg.sessionId;
  if (wanted) {
    const hit = matchSession(all, wanted);
    if (!hit) throw new Error(`找不到 Codex 会话 ${wanted}`);
    return hit;
  }
  return all.find((s) => !s.archived) ?? all[0];
}

// 数据库里还没有（比如刚落盘的新对话）就造一个临时视图
export function sessionById(cfg, id, titleHint = null) {
  const known = listSessions().find((s) => s.id === id);
  if (known) return known;
  return {
    id,
    appId: null,
    kind: 'codex',
    title: titleHint,
    cwd: null,
    configDir: null,
    path: null,
    exists: false,
    archived: false,
    originator: null,
    mtime: Date.now(),
    size: 0,
  };
}

export function describeSession(s) {
  const ageMin = Math.round((Date.now() - s.mtime) / 60000);
  const kb = Math.round(s.size / 1024);
  const title = s.title ? `「${s.title}」` : '';
  // CLI 建的会话被打了 codex_exec 戳，App 里默认看不到 —— 标出来免得选了却找不到
  const hidden = s.originator === 'codex_exec' ? '〔App 里不可见〕' : '';
  return `${hidden}${title}${s.id.slice(0, 8)}…（${kb}KB，${ageMin} 分钟前）`;
}
