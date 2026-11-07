import { statSync } from 'node:fs';
import { loadConfig as load, CONFIG_DIR as DIR, resolveCodexBin } from './config.js';
import {
  listSessions,
  matchSession,
  pickSession,
  sessionById,
  describeSession,
} from './session.js';
import { runCodex } from './codex.js';
import { markSessionVisible } from './appdb.js';
import {
  queueMessage,
  dropQueuedItem,
  readRolloutDelta,
  extractAssistantText,
  isTurnDone,
} from './appqueue.js';

export const name = 'codex';
export const label = 'Codex';
export const appLabel = 'Codex';

export const config = { load, CONFIG_DIR: DIR };

export function resolveBinary(cfg) {
  return resolveCodexBin(cfg);
}

export const sessions = {
  list: () => listSessions(),
  match: (all, ref) => matchSession(all, ref),
  pick: (cfg, ref) => pickSession(cfg, ref),
  byId: (cfg, id, title) => sessionById(cfg, id, title),
  describe: (s) => describeSession(s),
  kindLabel: () => 'Codex',
};

// Codex 的新会话 id 由 codex 自己分配（thread.started 里报上来）
export function newSessionId() {
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function offsetOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// 实时路径：对话正被 App 加载着时，queue 能让 App 立刻跑这一轮。
// 探测期内没动静 → 判定没加载，撤回自己投的那条（否则以后打开会补跑），返回 false。
async function tryLive({ cfg, session, prompt, handlers, run, log }) {
  if (!session.path) return false;

  let itemId;
  try {
    itemId = queueMessage(resolveBinary(cfg), session.id, prompt);
  } catch (e) {
    log('[bridge] queue 投递失败，退回 codex exec:', e.message);
    return false;
  }
  log(`[bridge] queue 投递 ${itemId} → ${session.id}（探测 ${cfg.liveProbeMs}ms）`);

  let offset = offsetOf(session.path);
  const probeUntil = Date.now() + cfg.liveProbeMs;
  let alive = false;

  while (!alive && Date.now() < probeUntil) {
    await sleep(600);
    const { records, offset: next } = readRolloutDelta(session.path, offset);
    if (!records.length) continue;
    offset = next;
    alive = true;
    for (const r of records) {
      const t = extractAssistantText(r);
      if (t) handlers.onText?.(t);
      if (isTurnDone(r)) {
        log('[bridge] ✓ 实时回合完成（App 侧）');
        return true;
      }
    }
  }

  if (!alive) {
    try {
      dropQueuedItem(itemId);
      log('[bridge] App 没加载该对话 → 已撤回投递，退回 codex exec');
    } catch (e) {
      log('[bridge] 撤回投递失败:', e.message);
    }
    return false;
  }

  run.live = true;
  const hardUntil = Date.now() + cfg.timeoutMs;
  while (Date.now() < hardUntil) {
    await sleep(1000);
    const { records, offset: next } = readRolloutDelta(session.path, offset);
    offset = next;
    for (const r of records) {
      const t = extractAssistantText(r);
      if (t) handlers.onText?.(t);
      if (isTurnDone(r)) {
        log('[bridge] ✓ 实时回合完成（App 侧）');
        return true;
      }
    }
  }
  throw new Error('实时回合超时未结束');
}

export function runTurn({ cfg, session, prompt, handlers, run, onSessionId, create, log }) {
  const bin = resolveBinary(cfg);

  if (create) {
    const child = runCodex(
      cfg,
      bin,
      '',
      prompt,
      {
        ...handlers,
        onInit: (info) => {
          if (info?.sessionId) onSessionId?.(info.sessionId);
          handlers.onInit?.(info);
        },
      },
      { create: true }
    );
    return { child, done: child.done };
  }

  // 非 create：先试实时，失败再起子进程。子进程是在异步判定之后才有的，
  // 所以返回一个 handle，core 通过 handle.child 做 /stop。
  const handle = { child: null, done: null };
  handle.done = (async () => {
    if (await tryLive({ cfg, session, prompt, handlers, run, log })) return;
    const child = runCodex(cfg, bin, session.id, prompt, handlers);
    handle.child = child;
    await child.done;
  })();
  return handle;
}

export function finalizeNewSession({ sessionId }) {
  markSessionVisible(sessionId);
}

// codex 的 upsert 每轮都会把 source 写回 'exec'，所以每轮结束都要重新标记
export function afterTurn({ sessionId }) {
  try {
    markSessionVisible(sessionId);
  } catch {
    /* 标记失败不影响对话 */
  }
}