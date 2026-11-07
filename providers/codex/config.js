import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.config', 'codexbridge');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// 必须用 App 包内那份 CLI：PATH 里装的是旧版（0.151.0），认不了 ~/.codex/config.toml 里配的模型，
// 会直接报 "model is not supported when using Codex with a ChatGPT account"。
const APP_CLI = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

// 权限档 → codex 的沙箱策略。
// 注意 `codex exec resume` 没有 --sandbox 参数，只能靠 -c 覆盖配置里的 sandbox_mode。
export const PROFILES = {
  ro: { sandboxMode: 'read-only', bypass: false },
  rw: { sandboxMode: 'workspace-write', bypass: false },
  full: { sandboxMode: null, bypass: true },
};

const DEFAULTS = {
  projectDir: join(homedir(), 'Claude'),
  // 只认这些人的消息；其余静默丢弃
  allowedUserIds: [],
  // null = 不限频道
  channelId: null,
  // null = 从 HTTPS_PROXY/ALL_PROXY 等环境变量自动探测
  proxyUrl: null,
  // null = 自动解析（优先 App 包内那份）
  codexBin: null,
  // null = 用 ~/.codex/config.toml 里的模型
  model: null,
  // null = 自动接最近活跃的对话
  sessionId: null,
  timeoutMs: 15 * 60 * 1000,
  // 走实时路径（codex queue）时，等多久没动静就判定"App 没加载那个对话"并退回 codex exec
  liveProbeMs: 8000,
  maxCharsPerMessage: 1900,
  throttleMs: 1500,
  permission: 'ro',
};

export function resolveCodexBin(cfg) {
  if (cfg.codexBin) {
    if (!existsSync(cfg.codexBin)) throw new Error(`配置的 codexBin 不存在：${cfg.codexBin}`);
    return cfg.codexBin;
  }
  if (existsSync(APP_CLI)) return APP_CLI;
  const local = join(homedir(), '.local', 'bin', 'codex');
  if (existsSync(local)) {
    console.warn('[bridge] ⚠️ 没找到 App 包内的 codex CLI，退回 PATH 里那份（可能是旧版，模型可能不认）');
    return local;
  }
  return 'codex';
}

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

  const profile = PROFILES[cfg.permission] ?? PROFILES.ro;
  cfg.sandboxMode = raw.sandboxMode ?? profile.sandboxMode;
  cfg.bypassSandbox = raw.bypassSandbox ?? profile.bypass;

  if (!cfg.discordToken) throw new Error('config.json 缺少 discordToken');
  if (!Array.isArray(cfg.allowedUserIds) || cfg.allowedUserIds.length === 0) {
    throw new Error('config.json 缺少 allowedUserIds（至少一个，这是唯一挡在你机器前面的东西）');
  }

  // 认证走 ~/.codex/auth.json（你现有的 ChatGPT 登录），这里不需要 key
  return cfg;
}
