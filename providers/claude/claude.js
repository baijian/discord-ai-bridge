import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// 桌面 App 是 3p 构建，CLI 嵌在包里，路径带版本号和哈希、随升级变化，
// 所以每次启动时动态解析，取最新那份 —— 不另装 CLI，保证和桌面版共用 transcript 时格式一致。
export function resolveClaudeBin(cfg) {
  if (cfg.claudeBin) {
    if (!existsSync(cfg.claudeBin)) throw new Error(`配置的 claudeBin 不存在：${cfg.claudeBin}`);
    return cfg.claudeBin;
  }
  const root = join(homedir(), 'Library', 'Application Support', 'Claude-3p', 'claude-code');
  const found = [];
  for (const ver of safeReaddir(root)) {
    for (const hash of safeReaddir(join(root, ver))) {
      const bin = join(root, ver, hash, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(bin)) {
        found.push({ bin, mtime: statSync(bin).mtimeMs });
      }
    }
  }
  if (!found.length) {
    throw new Error(`没找到 claude 二进制，找过：${root}；可在 config.json 里手动指定 claudeBin`);
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].bin;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// 宿主 App 注入的那些变量，脱离 App 跑时要清掉，免得干扰
const HOST_ONLY_ENV = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDECODE',
];

export function buildEnv(cfg, session = {}) {
  const env = { ...process.env };
  for (const k of HOST_ONLY_ENV) delete env[k];
  env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey;
  // Cowork 会话的 transcript 在它自己的配置目录下，得让它去那儿找
  if (session.configDir) env.CLAUDE_CONFIG_DIR = session.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export function buildArgs(cfg, sessionId, prompt, { create = false } = {}) {
  const args = [
    '-p',
    // 会话还不存在（例如刚从 Discord 新建的对话）就用 --session-id 把它造出来，之后一律 --resume
    create ? '--session-id' : '--resume', sessionId,
  ];

  // 工具策略由权限档决定，见 src/config.js 的 PROFILES
  if (cfg.restricted) args.push('--restricted');
  if (cfg.allowedTools) args.push('--allowedTools', cfg.allowedTools);
  if (cfg.disallowedTools) args.push('--disallowedTools', cfg.disallowedTools);
  if (cfg.permissionMode) args.push('--permission-mode', cfg.permissionMode);

  // 行分隔 JSON；--verbose 是 stream-json 的必要条件（实测）
  args.push('--output-format', 'stream-json', '--verbose', prompt);
  return args;
}

/**
 * 起一个一次性 claude 子进程，把 stream-json 事件翻译成回调。
 * 返回 { kill(), done }，done 在进程结束时 resolve/reject。
 */
export function runClaude(cfg, claudeBin, sessionId, prompt, handlers = {}, opts = {}) {
  const args = buildArgs(cfg, sessionId, prompt, opts);
  const child = spawn(claudeBin, args, {
    cwd: opts.cwd || cfg.projectDir,
    env: buildEnv(cfg, opts),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let result = null;
  let stderr = '';
  let finished = false;
  let timer = null;

  const done = new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    timer = setTimeout(() => {
      kill('timeout');
      finish(reject, new Error(`超过 ${Math.round(cfg.timeoutMs / 1000)} 秒还没结束，已中止`));
    }, cfg.timeoutMs);

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行直接忽略
      }
      dispatch(evt, handlers, (r) => {
        result = r;
      });
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => finish(reject, err));

    child.on('close', (code) => {
      if (code !== 0 && !result) {
        const tail = stderr.trim().split('\n').slice(-4).join('\n');
        finish(reject, new Error(`claude 退出码 ${code}${tail ? `\n${tail}` : ''}`));
        return;
      }
      finish(resolve, result);
    });
  });

  function kill(reason = 'stop') {
    if (!finished && !child.killed) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 3000).unref?.();
    }
    handlers.onKill?.(reason);
  }

  return { kill, done, get pid() { return child.pid; } };
}

// 事件形状见 spike 实测：43 条里 37 条是 thinking_tokens 噪音，只挑有用的
// 导出以便用录下来的样本离线回归（见 README「自检」）
export function dispatch(evt, handlers, setResult = () => {}) {
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') handlers.onInit?.({ sessionId: evt.session_id, tools: evt.tools });
      return; // thinking_tokens / informational 一律忽略

    case 'assistant': {
      for (const block of evt.message?.content ?? []) {
        if (block.type === 'text' && block.text) handlers.onText?.(block.text);
        else if (block.type === 'tool_use') handlers.onTool?.(block.name, block.input, block.id);
      }
      return;
    }

    case 'user': {
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') handlers.onToolResult?.(block.tool_use_id, block.content);
        }
      }
      return;
    }

    case 'result': {
      const r = {
        isError: Boolean(evt.is_error),
        text: typeof evt.result === 'string' ? evt.result : '',
        numTurns: evt.num_turns,
        durationMs: evt.duration_ms,
        costUsd: evt.total_cost_usd,
        permissionDenials: evt.permission_denials ?? [],
        sessionId: evt.session_id,
      };
      setResult(r);
      handlers.onResult?.(r);
      return;
    }

    default:
      return;
  }
}
