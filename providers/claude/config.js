import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.config', 'ccbridge');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const KEY_PATH = join(CONFIG_DIR, 'api.key');
const LEGACY_KEY_PATH = join(CONFIG_DIR, 'deepseek.key');

// ── 权限档 ──────────────────────────────────────────────────────────
// ro   只读：能读代码、搜东西、答问题，不能改文件、不能跑命令
// rw   文件读写：能改文件，但不能执行命令（--restricted 仍会剥掉 Bash/REPL）
// full 完全放开：等价于把本机终端交给 Discord 侧 —— 只在你清楚风险时用
const NO_SHELL = [
  'Bash', 'BashOutput', 'KillShell', 'REPL',
  'Task', 'Skill', 'SendMessage',
  'DesignSync', 'EnterWorktree', 'ExitWorktree', 'TaskStop',
  'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList',
].join(' ');

export const PROFILES = {
  ro: {
    restricted: true,
    allowedTools: 'Read Grep Glob WebSearch WebFetch',
    disallowedTools: [...NO_SHELL.split(' '), 'Write', 'Edit', 'NotebookEdit'].join(' '),
    permissionMode: null,
  },
  rw: {
    // --restricted 只剥执行类工具，Write/Edit 本来就还在，所以放开写入只需改白名单
    restricted: true,
    allowedTools: 'Read Write Edit NotebookEdit Grep Glob WebSearch WebFetch',
    disallowedTools: NO_SHELL,
    permissionMode: null,
  },
  full: {
    restricted: false,
    allowedTools: null,
    disallowedTools: null,
    // -p 模式没法弹授权框，要全放开就得跳过权限检查
    permissionMode: 'bypassPermissions',
  },
};

const DEFAULTS = {
  projectDir: join(homedir(), 'Claude'),
  baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  // null = 自动接登记簿里最近活跃的对话
  sessionId: null,
  // null = 运行时动态解析 Claude Desktop 包内的 claude 二进制
  claudeBin: null,
  // 只认这些人的消息；其余静默丢弃。这是唯一挡在你机器前面的东西，别留空。
  allowedUserIds: [],
  // null = 不限频道
  channelId: null,
  // null = 从 HTTPS_PROXY/ALL_PROXY 等环境变量自动探测；本机连 Discord 必须走代理
  proxyUrl: null,
  timeoutMs: 15 * 60 * 1000,
  maxCharsPerMessage: 1900,
  throttleMs: 1500,
  permission: 'ro',
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`缺少配置文件：${CONFIG_PATH}（建法见 README）`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`${CONFIG_PATH} 不是合法 JSON：${err.message}`);
  }

  const cfg = { ...DEFAULTS, ...raw };

  // 权限档展开成具体的工具策略；config.json 里显式写了的字段优先
  const profile = PROFILES[cfg.permission] ?? PROFILES.ro;
  cfg.restricted = raw.restricted ?? profile.restricted;
  cfg.allowedTools = raw.allowedTools ?? profile.allowedTools;
  cfg.disallowedTools = raw.disallowedTools ?? profile.disallowedTools;
  cfg.permissionMode = raw.permissionMode ?? profile.permissionMode;

  if (!cfg.discordToken) throw new Error('config.json 缺少 discordToken');
  if (!Array.isArray(cfg.allowedUserIds) || cfg.allowedUserIds.length === 0) {
    throw new Error('config.json 缺少 allowedUserIds（至少一个，这是唯一挡在你机器前面的东西）');
  }

  // 兼容老配置：优先 api.key，退回 deepseek.key
  const keyPath = existsSync(KEY_PATH) ? KEY_PATH : LEGACY_KEY_PATH;
  if (!existsSync(keyPath)) throw new Error(`缺少 API key 文件：${KEY_PATH}`);
  cfg.apiKey = readFileSync(keyPath, 'utf8').trim();
  if (!cfg.apiKey) throw new Error(`${keyPath} 是空的`);

  return cfg;
}
