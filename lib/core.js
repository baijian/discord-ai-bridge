import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { StreamRenderer } from './render.js';
import { installProxy, resolveProxyUrl } from './proxy.js';
import { loadMap, saveMap } from './store.js';

const SESSION_LIST_TTL = 15 * 60 * 1000;

/**
 * 启动一个 bridge 实例。Discord 层（命令、绑定、thread、并行、渲染）全在这里，
 * provider 只负责"怎么跟本机某个 App 对话"。
 */
export function startBridge(provider) {
  const cfg = provider.config.load();
  const APP = provider.appLabel;
  const LOG_PATH = join(provider.config.CONFIG_DIR, 'bridge.log');

  const log = (...args) => {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
    console.log(line);
    try {
      appendFileSync(LOG_PATH, line + '\n');
    } catch {
      /* 日志写不了不该影响主流程 */
    }
  };

  const proxyUrl = resolveProxyUrl(cfg);
  const proxied = installProxy(proxyUrl);

  log(`[bridge] provider: ${provider.name}`);
  log('[bridge] binary  :', provider.resolveBinary(cfg));
  log('[bridge] project :', cfg.projectDir);
  log('[bridge] 权限档  :', cfg.permission);
  if (cfg.permission === 'full') {
    log(
      '[bridge] ⚠️⚠️ 完全放开：白名单里的人 = 本机终端的完整控制权（可执行任意命令、改任意文件）。' +
        '你的 Discord 账号被盗 = 这台机器被控。'
    );
  } else {
    log('[bridge] 限制    :', cfg.sandboxLabel ?? cfg.allowedTools ?? '(默认)');
  }
  log('[bridge] proxy   :', proxied ? proxyUrl : '(直连)');
  log('[bridge] logfile :', LOG_PATH);

  // 每个 thread / 频道各自一个运行中的任务：不同会话并行，同一会话仍串行。
  const runs = new Map();
  const runIn = (channelId) => runs.get(channelId) ?? null;
  const busyWith = (sessionId) => {
    if (!sessionId) return null;
    for (const r of runs.values()) if (r.sessionId === sessionId) return r;
    return null;
  };
  let attachedId = null;

  const syncMap = loadMap(provider.config.CONFIG_DIR);
  const threadOfSession = (sessionId) =>
    Object.entries(syncMap).find(([, v]) => v.sessionId === sessionId)?.[0] ?? null;

  const sessionLists = new Map(); // channelId -> { ids, at }
  const rememberList = (channelId, ids) => {
    sessionLists.set(channelId, { ids, at: Date.now() });
    if (sessionLists.size > 500) sessionLists.delete(sessionLists.keys().next().value);
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on('clientReady', () =>
    log(`[bridge] 已登录：${client.user.tag}（id ${client.user.id}）`)
  );
  client.on('error', (err) => log('[bridge] client error:', err.message));
  client.on('shardError', (err) => log('[bridge] shard error:', err.message));
  client.on('shardDisconnect', (evt, id) => log(`[bridge] shard ${id} 断开:`, evt?.code));
  client.on('shardReconnecting', (id) => log(`[bridge] shard ${id} 重连中…`));
  client.on('warn', (m) => log('[bridge] warn:', m));
  process.on('unhandledRejection', (err) => log('[bridge] unhandled rejection:', err?.stack ?? err));
  process.on('uncaughtException', (err) => log('[bridge] uncaught exception:', err?.stack ?? err));

  client.on('messageCreate', (msg) => {
    if (msg.author.bot) return;
    log(`[bridge] 收到 ch=${msg.channelId} user=${msg.author.id} ${JSON.stringify(msg.content.slice(0, 70))}`);
    handleMessage(msg).catch((err) => log('[bridge] 处理消息出错：', err?.stack ?? err));
  });

  const stripMention = (content) =>
    content.replace(new RegExp(`^<@!?${client.user?.id}>\\s*`), '').trim();

  const HELP = [
    `**Discord ↔ ${provider.label} 桥接 · 命令一览**`,
    '',
    '`/help` 列出全部命令',
    `\`/sessions\`（或 \`/sessionlist\`）列出 ${APP} 对话并编号`,
    '`/session <编号>` 把**当前聊天**绑定到该对话；也接受短 id 或标题关键词（别名 `/sess`）',
    '`/new` 解除当前聊天的绑定',
    `\`/list\` 列出 ${APP} 里的全部对话（带 id）`,
    '`/status` 看当前绑定',
    '`/stop` 中止本频道正在跑的任务（`/stop all` 中止全部）',
    '',
    '`/attach` 列出最近的对话',
    '`/attach <id>` 指定主频道发给哪个对话',
    '`/attach auto` 恢复"自动接最近活跃的"',
    '',
    '`/sync <id>` 给一个已有对话开 thread',
    '`/sync new <标题>` **从 Discord 新建一个对话**',
    '`/unsync` 在 thread 里解绑',
    '',
    '在**主频道**发普通文字 → 发给当前绑定的对话；',
    '在**thread** 里发 → 发给该 thread 绑定的对话。',
    '`@机器人` 前缀会自动剥掉，带不带都行。',
  ].join('\n');

  const channelAllowed = (msg) => {
    if (!cfg.channelId) return true;
    if (msg.channelId === cfg.channelId) return true;
    return msg.channel?.parentId === cfg.channelId;
  };

  const boundSessionId = (channelId) =>
    syncMap[channelId]?.sessionId ?? (channelId === cfg.channelId ? attachedId : null);

  async function handleMessage(msg) {
    if (!channelAllowed(msg)) {
      return log(`[bridge]   跳过：频道/父频道不匹配（期望 ${cfg.channelId}）`);
    }
    if (!cfg.allowedUserIds.includes(msg.author.id)) {
      return log('[bridge]   跳过：用户不在白名单');
    }

    const inThread = Boolean(msg.channel?.isThread?.());
    const entry = syncMap[msg.channelId];

    const content = stripMention(msg.content.trim());
    if (!content) return log('[bridge]   跳过：空内容');
    log(`[bridge]   指令/内容 = ${JSON.stringify(content.slice(0, 70))}`);

    const isCommand = content.startsWith('/');
    if (inThread && !entry && !isCommand) {
      log('[bridge]   跳过：未绑定的 thread（已提示用户）');
      await msg
        .reply(
          '这条 thread 还没绑定对话，所以刚才那句话没发出去。\n' +
            '· 想接到某个已有对话：在这里发 `/session <编号>`（先 `/sessions` 看编号）\n' +
            '· 想新起一个：在这里发 `/sync new <标题>`'
        )
        .catch(() => {});
      return;
    }

    if (content === '/help') return msg.reply(HELP);
    if (content === '/status') return replyStatus(msg);
    if (content === '/list') return listCommand(msg);
    if (content === '/sessions' || content === '/sessionlist') return sessionsCommand(msg);
    // /session 与 /sess 等价（有些客户端会占用 /session 这个名字）
    for (const alias of ['/session', '/sess']) {
      if (content === alias || content.startsWith(`${alias} `)) {
        return bindSessionCommand(msg, content.slice(alias.length).trim());
      }
    }
    if (content === '/new') return newBindingCommand(msg);
    if (content === '/stop') return stopRun(msg);
    if (content === '/stop all') return stopRun(msg, true);
    if (content === '/unsync') return unsync(msg);
    if (content === '/sync' || content.startsWith('/sync ')) {
      return syncCommand(msg, content.slice('/sync'.length).trim());
    }
    if (content === '/attach' || content.startsWith('/attach ')) {
      return attach(msg, content.slice('/attach'.length).trim());
    }

    return runPrompt(msg, content);
  }

  async function replyStatus(msg) {
    const lines = [];
    const inThread = Boolean(msg.channel?.isThread?.());
    const entry = syncMap[msg.channelId];
    try {
      const session = entry?.sessionId
        ? provider.sessions.byId(cfg, entry.sessionId, entry.title)
        : provider.sessions.pick(cfg, attachedId);
      lines.push(`${inThread ? '本 thread' : '主频道'}绑定：${provider.sessions.describe(session)}`);
      lines.push(`来源：${entry ? '本 thread 单独绑定' : attachedId ? '/attach 指定' : '自动（最近活跃）'}`);
      const threadId = threadOfSession(session.id);
      if (threadId) lines.push(`同步 thread：<#${threadId}>`);
    } catch (err) {
      lines.push(`⚠️ ${err.message}`);
    }
    const active = runIn(msg.channelId);
    lines.push(
      active
        ? `本频道：正在跑（${String(active.sessionId ?? '').slice(0, 8)}）${active.live ? ' · 实时' : ''}`
        : '本频道：空闲'
    );
    if (runs.size > 1) lines.push(`全局并行中：${runs.size} 个`);
    log('[bridge] /status →', lines.join(' | '));
    await msg.reply(lines.join('\n'));
  }

  async function listCommand(msg) {
    let all;
    try {
      all = provider.sessions.list(cfg);
    } catch (err) {
      return msg.reply(`❌ ${err.message}`);
    }
    if (!all.length) return msg.reply(`${APP} 里还没有任何对话。`);

    const LIMIT = 25;
    const lines = all.slice(0, LIMIT).map((s, i) => {
      const bits = [
        provider.sessions.kindLabel(s),
        `${Math.round(s.size / 1024)}KB`,
        `${Math.round((Date.now() - s.mtime) / 60000)} 分钟前`,
      ];
      if (s.archived) bits.push('已归档');
      const t = threadOfSession(s.id);
      if (t) bits.push(`thread <#${t}>`);
      return `${i + 1}. 「${s.title ?? '(无标题)'}」\n　　\`${s.id.slice(0, 8)}\` · ${bits.join(' · ')}`;
    });

    let body = `📋 **${APP} 里的对话**（共 ${all.length} 个）\n\n${lines.join('\n')}`;
    if (all.length > LIMIT) body += `\n\n…另有 ${all.length - LIMIT} 个未列出`;
    body += '\n\n绑定：`/session <编号>` 或 `/sync <短id>`';
    if (body.length > 1900) body = `${body.slice(0, 1880)}\n…（过长已截断）`;
    rememberList(msg.channelId, all.slice(0, LIMIT).map((s) => s.id));
    log(`[bridge] /list -> ${all.length} 个对话`);
    return msg.reply(body);
  }

  async function sessionsCommand(msg) {
    let all;
    try {
      all = provider.sessions.list(cfg).filter((s) => !s.archived);
    } catch (err) {
      return msg.reply(`❌ ${err.message}`);
    }
    if (!all.length) return msg.reply(`${APP} 里还没有任何对话。`);

    const LIMIT = 20;
    const shown = all.slice(0, LIMIT);
    rememberList(msg.channelId, shown.map((s) => s.id));

    const bound = boundSessionId(msg.channelId);
    const lines = shown.map((s, i) => {
      const mark = s.id === bound ? '  ← 当前绑定' : '';
      const t = threadOfSession(s.id);
      return `${i + 1}. 「${s.title ?? '(无标题)'}」 ${provider.sessions.kindLabel(s)} · ${Math.round(s.size / 1024)}KB${t ? ` · thread <#${t}>` : ''}${mark}`;
    });

    let body = `📋 **${APP} 对话**（共 ${all.length} 个）\n\n${lines.join('\n')}`;
    if (all.length > LIMIT) body += `\n\n…另有 ${all.length - LIMIT} 个未列出（可用完整 id 绑定）`;
    body += '\n\n绑定：`/session <编号>` 或 `/session <短id|标题关键词>`；解绑：`/new`。\n列表 15 分钟内有效。';
    if (body.length > 1900) body = `${body.slice(0, 1880)}\n…（过长已截断）`;
    log(`[bridge] /sessions -> ${all.length} 个，本频道绑定 ${bound ?? '无'}`);
    return msg.reply(body);
  }

  async function bindSessionCommand(msg, arg) {
    if (!arg) return sessionsCommand(msg);

    let all;
    try {
      all = provider.sessions.list(cfg).filter((s) => !s.archived);
    } catch (err) {
      return msg.reply(`❌ ${err.message}`);
    }

    let target = null;

    if (/^\d+$/.test(arg)) {
      const list = sessionLists.get(msg.channelId);
      if (!list || Date.now() - list.at > SESSION_LIST_TTL) {
        return msg.reply('先发 `/sessions` 列出编号，再用 `/session <编号>` 绑定（列表 15 分钟内有效）。');
      }
      const idx = Number(arg) - 1;
      if (idx < 0 || idx >= list.ids.length) {
        return msg.reply(`编号超出范围（1-${list.ids.length}）。重新发 \`/sessions\` 看看。`);
      }
      target = all.find((s) => s.id === list.ids[idx]) ?? null;
    } else {
      try {
        target = provider.sessions.match(all, arg);
      } catch (err) {
        return msg.reply(`❌ ${err.message}`);
      }
      if (!target && !/\s/.test(arg.trim())) {
        const hits = all.filter((s) => (s.title ?? '').toLowerCase().includes(arg.trim().toLowerCase()));
        if (hits.length === 1) target = hits[0];
        else if (hits.length > 1) {
          const lines = hits.slice(0, 10).map((s) => `· 「${s.title ?? '(无标题)'}」 \`${s.id.slice(0, 8)}\``);
          return msg.reply(`「${arg}」匹配到 ${hits.length} 个，请用编号或完整 id：\n${lines.join('\n')}`);
        }
      }
    }

    if (!target) return msg.reply(`找不到对话 ${arg}（先 \`/sessions\` 看看编号）`);

    const inThread = Boolean(msg.channel?.isThread?.());
    if (inThread) {
      syncMap[msg.channelId] = { sessionId: target.id, title: target.title };
      saveMap(provider.config.CONFIG_DIR, syncMap);
    } else {
      attachedId = target.id;
    }
    log(`[bridge] bind -> ${target.id}（${inThread ? 'thread' : '主频道'}）`);
    return msg.reply(
      `✅ 已绑定${inThread ? '这条 thread' : '主频道'}到：${provider.sessions.describe(target)}\n之后的普通消息会继续这个对话。`
    );
  }

  async function newBindingCommand(msg) {
    const inThread = Boolean(msg.channel?.isThread?.());
    if (inThread) {
      if (!syncMap[msg.channelId]) return msg.reply('这条 thread 本来就没绑定。');
      delete syncMap[msg.channelId];
      saveMap(provider.config.CONFIG_DIR, syncMap);
      log('[bridge] /new 解绑 thread', msg.channelId);
      return msg.reply('已解绑。用 `/session <编号>` 重新绑定，或 `/sync new <标题>` 新起一个。');
    }
    attachedId = null;
    log('[bridge] /new 主频道恢复自动');
    return msg.reply('已解除指定，主频道恢复"自动接最近活跃的对话"。');
  }

  async function stopRun(msg, all = false) {
    if (all) {
      if (!runs.size) return msg.reply('当前没有在跑的任务。');
      let stopped = 0;
      const live = [];
      for (const r of runs.values()) {
        if (r.live) {
          live.push(r);
          continue;
        }
        (r.handle?.child ?? r.child)?.kill('stop');
        stopped += 1;
      }
      log(`[bridge] 用户请求中止全部（${stopped} 个，实时 ${live.length} 个）`);
      return msg.reply(
        `已请求中止 ${stopped} 个任务。` + (live.length ? `\n另有 ${live.length} 个是桌面 App 在跑，去桌面停。` : '')
      );
    }
    const run = runIn(msg.channelId);
    if (!run) return msg.reply('这里没有在跑的任务。');
    if (run.live) return msg.reply('这个回合是桌面 App 在跑的，去桌面停。');
    (run.handle?.child ?? run.child)?.kill('stop');
    log('[bridge] 用户请求中止', run.sessionId);
    return msg.reply('已请求中止。');
  }

  async function attach(msg, arg) {
    if (!arg) {
      const recent = provider.sessions.list(cfg).slice(0, 7);
      if (!recent.length) return msg.reply('还没有任何对话记录。');
      const lines = recent.map((s, i) => `${i + 1}. ${provider.sessions.describe(s)}`);
      return msg.reply(
        `最近的对话：\n${lines.join('\n')}\n\n用 \`/attach <id>\` 指定；\`/attach auto\` 恢复自动。`
      );
    }
    if (arg === 'auto') {
      attachedId = null;
      log('[bridge] attach -> auto');
      return msg.reply('已恢复：自动接最近活跃的对话。');
    }
    let hit;
    try {
      hit = provider.sessions.match(provider.sessions.list(cfg), arg);
    } catch (e) {
      return msg.reply(`❌ ${e.message}`);
    }
    if (!hit) return msg.reply(`找不到对话 ${arg}（可以先 \`/sessions\` 看编号）`);
    attachedId = hit.id;
    log('[bridge] attach ->', hit.id);
    return msg.reply(`已接上：${provider.sessions.describe(hit)}`);
  }

  async function syncCommand(msg, arg) {
    if (arg === 'new' || arg.startsWith('new ')) return createAndSync(msg, arg.slice(3).trim());

    let session;
    try {
      session = provider.sessions.pick(cfg, arg || attachedId);
    } catch (err) {
      return msg.reply(`❌ ${err.message}`);
    }

    const existing = threadOfSession(session.id);
    if (existing) return msg.reply(`这个对话已经绑过 thread 了：<#${existing}>`);

    const name = `${session.title ?? '对话'} · ${session.id.slice(0, 8)}`;
    let thread;
    try {
      thread = await msg.channel.threads.create({
        name: name.slice(0, 100),
        autoArchiveDuration: 10080,
        reason: `同步 ${provider.name} 对话 ${session.id}`,
      });
    } catch (err) {
      log('[bridge] 建 thread 失败:', err.message);
      return msg.reply(
        `❌ 建 thread 失败：${err.message}\n检查 bot 是否具备 **Create Public Threads** 权限（服务器设置 → 角色）。`
      );
    }

    syncMap[thread.id] = { sessionId: session.id };
    saveMap(provider.config.CONFIG_DIR, syncMap);
    log(`[bridge] sync -> thread ${thread.id} -> ${session.id}`);

    await thread.send(
      `📎 已接入 ${APP} 对话「${session.title ?? session.id}」\n` +
        `· 你在这里说的话 → 写进那个对话\n` +
        `· 到 ${APP} 里打开它就能看到，并可以直接接着聊\n` +
        `· 单向：${APP} 里说的话不会再回到这里`
    );
    return msg.reply(`已建 thread：<#${thread.id}>`);
  }

  async function createAndSync(msg, title) {
    const name = (title || 'Discord 对话').slice(0, 100);
    let thread;
    try {
      thread = await msg.channel.threads.create({
        name,
        autoArchiveDuration: 10080,
        reason: 'Discord 新建对话',
      });
    } catch (err) {
      log('[bridge] 建 thread 失败:', err.message);
      return msg.reply(`❌ 建 thread 失败：${err.message}\n检查 bot 是否具备 **Create Public Threads** 权限。`);
    }

    // Claude 的 id 我们自己生成；Codex 的 id 要等它跑起来才知道
    const id = provider.newSessionId?.() ?? null;
    syncMap[thread.id] = { sessionId: id, title: name, pending: true };
    saveMap(provider.config.CONFIG_DIR, syncMap);
    log(`[bridge] sync new -> thread ${thread.id}${id ? ` (id ${id})` : ''}`);

    await thread.send(
      `🆕 新对话「${name}」\n在这里说第一句话，它就会在 ${APP} 里变成一个对话，之后两边都能接着聊。`
    );
    return msg.reply(`已建 thread：<#${thread.id}>`);
  }

  async function unsync(msg) {
    if (!syncMap[msg.channelId]) return msg.reply('这里不是同步 thread。');
    delete syncMap[msg.channelId];
    saveMap(provider.config.CONFIG_DIR, syncMap);
    log('[bridge] unsync', msg.channelId);
    return msg.reply('已停止同步（thread 本身保留）。');
  }

  async function runPrompt(msg, prompt) {
    if (!prompt) return;
    const key = msg.channelId;
    if (runs.has(key)) {
      return msg.reply('⚠️ 这条 thread 上一个任务还在跑。发 `/stop` 中止，或等它结束。');
    }

    const entry = syncMap[key];
    const pending = Boolean(entry?.pending);

    let session;
    try {
      if (pending) {
        let id = entry.sessionId || provider.newSessionId?.() || null;
        if (id && !entry.sessionId) {
          entry.sessionId = id;
          saveMap(provider.config.CONFIG_DIR, syncMap);
        }
        session = id
          ? provider.sessions.byId(cfg, id, entry.title)
          : { id: null, title: entry.title, exists: false, path: null, size: 0, mtime: Date.now() };
      } else if (entry?.sessionId) {
        session = provider.sessions.byId(cfg, entry.sessionId, entry.title);
      } else {
        session = provider.sessions.pick(cfg, attachedId);
      }
    } catch (err) {
      return msg.reply(`❌ ${err.message}`);
    }

    if (session.id) {
      const busy = busyWith(session.id);
      if (busy) return msg.reply(`⚠️ 这个对话正在 <#${busy.channelId}> 里跑，等它结束再发。`);
    }

    const create = pending || !session.exists;

    const renderer = new StreamRenderer(msg.channel, cfg);
    await renderer.start();

    const run = {
      channelId: key,
      sessionId: session.id ?? null,
      renderer,
      child: null,
      handle: null,
      live: false,
      startedAt: Date.now(),
    };
    runs.set(key, run);

    let finalId = session.id ?? null;
    const handlers = {
      onText: (t) => renderer.pushText(t),
      onTool: (name, input) => renderer.pushTool(name, input),
      onToolResult: () => renderer.clearTool(),
      onResult: (r) => renderer.setResult(r),
    };
    const onSessionId = (id) => {
      if (!id) return;
      finalId = id;
      run.sessionId = id;
      if (pending) {
        entry.sessionId = id;
        saveMap(provider.config.CONFIG_DIR, syncMap);
      }
    };

    try {
      const handle = provider.runTurn({
        cfg,
        session,
        prompt,
        handlers,
        run,
        onSessionId,
        create,
        log,
      });
      run.handle = handle;
      run.child = handle.child;

      await handle.done;
      await renderer.finish();
      log(`[bridge] ✓ ${finalId ?? '(新建)'} 完成`);

      if (pending) {
        try {
          provider.finalizeNewSession?.({ cfg, sessionId: finalId, title: entry.title });
          entry.pending = false;
          saveMap(provider.config.CONFIG_DIR, syncMap);
          log(`[bridge] 新对话已落盘：${finalId}`);
        } catch (e) {
          log('[bridge] 新对话登记失败:', e.message);
          await msg.channel.send(`⚠️ 对话已创建，但没能在 ${APP} 里登记：${e.message}`).catch(() => {});
        }
      }

      if (finalId) {
        try {
          provider.afterTurn?.({ cfg, sessionId: finalId });
        } catch (e) {
          log('[bridge] afterTurn 失败:', e.message);
        }
      }
    } catch (err) {
      log(`[bridge] ✗ ${finalId ?? '(新建)'} 失败:`, err.message);
      const hint = /active writer/.test(err.message)
        ? '\n（这个 Codex 对话正被桌面端占用 —— Codex 会硬性拒绝并发，换一个对话或等它空闲）'
        : '';
      await renderer.fail(err.message + hint);
    } finally {
      runs.delete(key);
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`[bridge] 收到 ${sig}，退出`);
      for (const r of runs.values()) (r.handle?.child ?? r.child)?.kill('shutdown');
      client.destroy();
      process.exit(0);
    });
  }

  client.login(cfg.discordToken).catch((err) => {
    log('[bridge] 登录失败：', err.message);
    if (String(err.message).includes('disallowed intents')) {
      log('[bridge] → 去开发者后台 Bot 页把 Message Content Intent 打开');
    }
    process.exit(1);
  });
}