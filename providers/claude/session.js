import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// /path/to/project -> ~/.claude/projects/-path-to-project
export function transcriptDir(cwd) {
  const slug = resolve(cwd).replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

// ── App 的会话登记簿 ────────────────────────────────────────────────
// App 有两套对话，各有一套登记簿：
//   Code tab      : Claude*/claude-code-sessions/<org>/<ws>/local_*.json
//                   transcript 在 ~/.claude/projects/<项目slug>/<cliSessionId>.jsonl
//   Cowork (agent): Claude*/local-agent-mode-sessions/<org>/<ws>/local_*.json
//                   transcript 在 <该记录 cwd>/​.claude/projects/session/<cliSessionId>.jsonl
//
// 两套记录的 cliSessionId 都是**当前**的 transcript id —— App 会给同一个对话换底层会话，
// 换掉的旧 id 沉到 priorCliSessionIds。所以不能按文件 mtime 猜"最新会话"，会写到废弃文件上。
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support');

function appSupportDirs() {
  try {
    return readdirSync(APP_SUPPORT)
      .filter((n) => n.startsWith('Claude'))
      .map((n) => join(APP_SUPPORT, n));
  } catch {
    return [];
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// 某个 App 数据目录下、某个登记簿类型的所有工作区目录
function registryDirs(sub) {
  const out = [];
  for (const base of appSupportDirs()) {
    const root = join(base, sub);
    if (!existsSync(root)) continue;
    for (const org of safeReaddir(root)) {
      for (const ws of safeReaddir(join(root, org))) {
        if (ws.includes('.bak')) continue; // 备份目录别当成工作区
        out.push(join(root, org, ws));
      }
    }
  }
  return out;
}

function statOf(path) {
  try {
    const st = statSync(path);
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

// 把一条登记簿记录翻译成统一的会话视图
function toSession(rec, kind) {
  const cliSessionId = rec.cliSessionId;
  if (!cliSessionId) return null;

  let path;
  let configDir = null;
  if (kind === 'cowork') {
    // 记录里的 cwd 是会话文件夹下的 outputs/，而 .claude 在它的上一级（会话文件夹里）
    const parent = dirname(rec.cwd ?? '');
    configDir = [join(parent, '.claude'), join(rec.cwd ?? '', '.claude')].find((p) => existsSync(p))
      ?? join(parent, '.claude');
    path = join(configDir, 'projects', 'session', `${cliSessionId}.jsonl`);
  } else {
    path = join(transcriptDir(rec.cwd ?? ''), `${cliSessionId}.jsonl`);
  }

  const st = statOf(path);
  return {
    id: cliSessionId,
    appId: rec.sessionId,
    kind,
    title: rec.title ?? null,
    cwd: rec.cwd ?? null,
    configDir,
    archived: Boolean(rec.isArchived),
    path,
    exists: Boolean(st),
    mtime: st?.mtimeMs ?? rec.lastActivityAt ?? 0,
    size: st?.size ?? 0,
  };
}

function readRegistry(sub, kind, cwdFilter) {
  const out = [];
  for (const dir of registryDirs(sub)) {
    for (const f of safeReaddir(dir)) {
      if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
      let rec;
      try {
        rec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      if (cwdFilter && kind === 'code' && resolve(rec.cwd ?? '') !== resolve(cwdFilter)) continue;
      const s = toSession(rec, kind);
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * 列出 App 里的对话。Code tab 的按 cfg.projectDir 过滤（只看这个项目的），
 * Cowork 的不分项目，全都带上 —— 它们本来就自成一体。
 */
export function listSessions(cfg) {
  const code = readRegistry('claude-code-sessions', 'code', cfg.projectDir);
  const cowork = readRegistry('local-agent-mode-sessions', 'cowork', null);
  const all = [...code, ...cowork].sort((a, b) => b.mtime - a.mtime);

  if (all.length) return all;

  // 兜底：登记簿读不到，就退回扫 transcript 文件
  const dir = transcriptDir(cfg.projectDir);
  return safeReaddir(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const id = n.slice(0, -'.jsonl'.length);
      const path = join(dir, n);
      const st = statOf(path);
      return {
        id, appId: null, kind: 'code', title: readTitle(dir, id), cwd: cfg.projectDir,
        configDir: null, archived: false, path, exists: true,
        mtime: st?.mtimeMs ?? 0, size: st?.size ?? 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function readTitle(dir, id) {
  try {
    const p = join(dir, id, 'custom-title.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')).customTitle ?? null;
  } catch {
    return null;
  }
}

// 按 id / appId 或唯一前缀找会话。`/list` 只展示 8 位短 id，所以必须支持前缀。
export function matchSession(sessions, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;

  const exact = sessions.find((s) => s.id === raw || s.appId === raw);
  if (exact) return exact;

  const q = raw.toLowerCase();
  if (q.length < 4) return null;
  const hits = sessions.filter(
    (s) => s.id.toLowerCase().startsWith(q) || (s.appId && s.appId.toLowerCase().startsWith(q))
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const lines = hits.slice(0, 5).map((s) => `· \`${s.id.slice(0, 8)}\` 「${s.title ?? '(无标题)'}」`);
    throw new Error(`前缀 ${raw} 匹配到 ${hits.length} 个对话，请多给几位：\n${lines.join('\n')}`);
  }
  return null;
}

// 手动指定优先，其次配置里写死的，最后自动取最近活跃
export function pickSession(cfg, overrideRef = null) {
  const all = listSessions(cfg);
  if (!all.length) throw new Error(`找不到任何会话（项目 ${cfg.projectDir}）`);

  const wanted = overrideRef || cfg.sessionId;
  if (wanted) {
    const hit = matchSession(all, wanted);
    if (!hit) throw new Error(`找不到会话 ${wanted}`);
    return hit;
  }
  return all.find((s) => !s.archived) ?? all[0];
}

export function describeSession(s) {
  const ageMin = Math.round((Date.now() - s.mtime) / 60000);
  const kb = Math.round(s.size / 1024);
  const title = s.title ? `「${s.title}」` : '';
  const tag = s.kind === 'cowork' ? '〔Cowork〕' : '';
  return `${tag}${title}${s.id}（${kb}KB，${ageMin} 分钟前）`;
}

// 按 cliSessionId 拿会话；登记簿里还没有（比如刚落盘的新对话）就造一个临时视图
export function sessionById(cfg, cliSessionId, titleHint = null) {
  const known = listSessions(cfg).find((s) => s.id === cliSessionId);
  if (known) return known;

  const path = join(transcriptDir(cfg.projectDir), `${cliSessionId}.jsonl`);
  const st = statOf(path);
  return {
    id: cliSessionId,
    appId: null,
    kind: 'code',
    title: titleHint,
    cwd: cfg.projectDir,
    configDir: null,
    archived: false,
    path,
    exists: Boolean(st),
    mtime: st?.mtimeMs ?? Date.now(),
    size: st?.size ?? 0,
  };
}

function findRegistryDir(cwd) {
  for (const dir of registryDirs('claude-code-sessions')) {
    const locals = safeReaddir(dir).filter((f) => f.startsWith('local_') && f.endsWith('.json'));
    if (!locals.length) continue;
    if (cwd) {
      try {
        const rec = JSON.parse(readFileSync(join(dir, locals[0]), 'utf8'));
        if (resolve(rec.cwd ?? '') !== resolve(cwd)) continue;
      } catch {
        continue;
      }
    }
    return dir;
  }
  return null;
}

/**
 * 在 App 的 Code 登记簿里造一条新记录 —— 这样 App 重启后就会把它当成一个正常对话列出来。
 * 实测有效（2026-10-13）。这是 App 的私有格式，所以拿一条现有记录当模板，只改身份字段。
 */
export function createAppSession({ cwd, cliSessionId, title }) {
  const dir = findRegistryDir(cwd);
  if (!dir) throw new Error('找不到 App 的会话登记簿目录');
  const locals = safeReaddir(dir).filter((f) => f.startsWith('local_') && f.endsWith('.json'));
  if (!locals.length) throw new Error('登记簿里没有可作模板的记录');

  const tpl = JSON.parse(readFileSync(join(dir, locals[0]), 'utf8'));
  const now = Date.now();
  const rec = {
    ...tpl,
    sessionId: `local_${randomUUID()}`,
    cliSessionId,
    priorCliSessionIds: [],
    cwd: resolve(cwd),
    originCwd: resolve(cwd),
    gitAnchorsFolderRealpath: resolve(cwd),
    title: title || 'Discord 对话',
    titleSource: 'auto',
    createdAt: now,
    lastFocusedAt: now,
    lastActivityAt: now,
    isArchived: false,
    completedTurns: 0,
    titleTurn: 0,
    postTurnSummary: null,
    postTurnSummaryFor: null,
    lastAssistantUuid: null,
    latestUserFrameAt: now,
  };
  const outPath = join(dir, `${rec.sessionId}.json`);
  writeFileSync(outPath, JSON.stringify(rec));
  return { appId: rec.sessionId, path: outPath };
}
