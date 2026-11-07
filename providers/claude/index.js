import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig as load, CONFIG_DIR as DIR } from './config.js';
import {
  listSessions,
  matchSession,
  pickSession,
  sessionById,
  describeSession,
  createAppSession,
} from './session.js';
import { resolveClaudeBin, runClaude } from './claude.js';

export const name = 'claude';
export const label = 'Claude';
export const appLabel = 'CC';

export const config = { load, CONFIG_DIR: DIR };

let cachedBin = null;

export function resolveBinary(cfg) {
  // Claude Desktop 升级会换掉版本目录，旧路径直接消失。每次跑之前都校验一遍。
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  const next = resolveClaudeBin(cfg);
  cachedBin = next;
  return next;
}

export const sessions = {
  list: (cfg) => listSessions(cfg),
  match: (all, ref) => matchSession(all, ref),
  pick: (cfg, ref) => pickSession(cfg, ref),
  byId: (cfg, id, title) => sessionById(cfg, id, title),
  describe: (s) => describeSession(s),
  kindLabel: (s) => (s.kind === 'cowork' ? 'Cowork' : 'Code'),
};

// Claude 的新会话 id 由我们自己生成（--session-id）
export function newSessionId() {
  return randomUUID();
}

export function runTurn({ cfg, session, prompt, handlers, run, onSessionId, create }) {
  onSessionId?.(session.id);
  const bin = resolveBinary(cfg);
  const child = runClaude(cfg, bin, session.id, prompt, handlers, {
    create,
    cwd: session.cwd || cfg.projectDir,
    configDir: session.configDir,
  });
  return { child, done: child.done };
}

// 新建的对话落盘后，去 App 登记簿登记，App 重启就能看到
export function finalizeNewSession({ cfg, sessionId, title }) {
  return createAppSession({ cwd: cfg.projectDir, cliSessionId: sessionId, title });
}