import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * codex exec [resume <id>] --json --skip-git-repo-check <prompt>
 *
 * 注意：
 * - `codex exec` 要求目录在 git 仓库里，否则必须带 --skip-git-repo-check
 * - `exec resume` **没有** --sandbox 参数，沙箱只能靠 -c 覆盖 config.toml 里的 sandbox_mode
 * - 事件流是 JSONL：thread.started / turn.started / item.completed / turn.completed / turn.failed
 */
export function buildArgs(cfg, sessionId, prompt, { create = false } = {}) {
  const args = ['exec'];
  if (!create) args.push('resume', sessionId);
  args.push('--json', '--skip-git-repo-check');

  if (cfg.bypassSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (cfg.sandboxMode) {
    args.push('-c', `sandbox_mode="${cfg.sandboxMode}"`);
  }

  if (cfg.model) args.push('--model', cfg.model);
  args.push(prompt);
  return args;
}

/** 起一个一次性 codex 子进程；返回 { kill(), done } */
export function runCodex(cfg, codexBin, sessionId, prompt, handlers = {}, opts = {}) {
  const args = buildArgs(cfg, sessionId, prompt, opts);
  // 认证走 ~/.codex/auth.json；Rust 侧会自己认 HTTP(S)_PROXY，不用像 Node 那样手工接
  const child = spawn(codexBin, args, {
    cwd: opts.cwd || cfg.projectDir,
    env: process.env,
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
      const t = line.trim();
      if (!t) return;
      let evt;
      try {
        evt = JSON.parse(t);
      } catch {
        return; // 非 JSON 行（日志）忽略
      }
      dispatch(evt, handlers, (r) => {
        result = r;
      });
    });

    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });

    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code !== 0 && !result) {
        const tail = stderr.trim().split('\n').slice(-4).join('\n');
        finish(reject, new Error(`codex 退出码 ${code}${tail ? `\n${tail}` : ''}`));
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

// 事件形状是实测出来的（2026-10-13）：
//   {type:"thread.started", thread_id}
//   {type:"turn.started"}
//   {type:"item.completed", item:{id, type:"agent_message", text}}
//   {type:"turn.completed", usage:{...}}
//   {type:"turn.failed", error:{message}}  /  {type:"error", message}
const SKIP_ITEM_TYPES = new Set(['reasoning']);

export function dispatch(evt, handlers, setResult = () => {}) {
  switch (evt.type) {
    case 'thread.started':
      handlers.onInit?.({ sessionId: evt.thread_id });
      return;

    case 'turn.started':
      return;

    case 'item.completed': {
      const it = evt.item ?? {};
      if (it.type === 'agent_message') {
        if (it.text) handlers.onText?.(it.text);
      } else if (it.type === 'error') {
        handlers.onNotice?.(it.message);
      } else if (it.type && !SKIP_ITEM_TYPES.has(it.type)) {
        handlers.onTool?.(it.type, it);
      }
      return;
    }

    case 'turn.completed': {
      const r = { isError: false, text: '', usage: evt.usage ?? null };
      setResult(r);
      handlers.onResult?.(r);
      return;
    }

    case 'turn.failed': {
      const r = { isError: true, text: evt.error?.message ?? 'turn failed' };
      setResult(r);
      handlers.onResult?.(r);
      return;
    }

    case 'error':
      handlers.onNotice?.(evt.message);
      return;

    default:
      return;
  }
}
