import { AttachmentBuilder } from 'discord.js';

function shortPath(p = '') {
  const parts = String(p).split('/').filter(Boolean);
  return parts.slice(-2).join('/') || String(p);
}

function describeTool(name, input = {}) {
  switch (name) {
    case 'Read':
      return `读 ${shortPath(input.file_path)}`;
    case 'Grep':
      return `搜索 /${input.pattern ?? ''}/`;
    case 'Glob':
      return `匹配 ${input.pattern ?? ''}`;
    case 'WebFetch':
      return `抓取 ${input.url ?? ''}`;
    case 'WebSearch':
      return `联网搜 ${input.query ?? ''}`;
    case 'Task':
      return '派子任务';
    default:
      return name;
  }
}

/**
 * 把 claude 的流式事件渲染成一条不断被编辑的 Discord 消息，
 * 结束时按长度决定是就地收尾还是转 .md 附件。
 */
export class StreamRenderer {
  constructor(channel, cfg) {
    this.channel = channel;
    this.cfg = cfg;
    this.text = '';
    this.tool = null;
    this.msg = null;
    this.timer = null;
    this.dirty = false;
    this.lastEdit = 0;
    this.result = null;
    this.closed = false;
  }

  async start() {
    this.msg = await this.channel.send('💭 启动中…');
  }

  pushText(t) {
    if (this.closed) return;
    this.text += t;
    this.tool = null;
    this.markDirty();
  }

  pushTool(name, input) {
    if (this.closed) return;
    this.tool = describeTool(name, input);
    this.markDirty();
  }

  clearTool() {
    if (this.closed) return;
    this.tool = null;
    this.markDirty();
  }

  setResult(r) {
    this.result = r;
  }

  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.cfg.throttleMs - (Date.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, wait);
  }

  async flush() {
    if (!this.msg || !this.dirty || this.closed) return;
    this.dirty = false;
    this.lastEdit = Date.now();
    const body = this.liveBody();
    try {
      await this.msg.edit(body);
    } catch {
      // 编辑失败（限流/消息被删）不致命，下次再来
    }
  }

  liveBody() {
    const status = this.tool ? `⚙️ ${this.tool}` : '💭 思考中…';
    const tail = this.text.trim();
    let out = tail ? `${status}\n\n${tail}` : status;
    if (out.length > this.cfg.maxCharsPerMessage + 80) {
      out = `…${out.slice(-(this.cfg.maxCharsPerMessage + 60))}`;
    }
    return out;
  }

  async finish() {
    await this.stopTimer();
    this.closed = true;
    if (!this.msg) return;

    const finalText = (this.text.trim() || this.result?.text?.trim() || '').trim();
    const err = this.result?.isError;
    const denied = this.result?.permissionDenials ?? [];

    if (!finalText) {
      await this.safeEdit(err ? '⚠️ 这轮出错了，没有输出。' : '（没有输出）');
      return;
    }

    if (finalText.length <= this.cfg.maxCharsPerMessage) {
      const body = err ? `⚠️ ${finalText}` : finalText;
      await this.safeEdit(body);
      if (denied.length) await this.note(`（有 ${denied.length} 个工具调用因只读限制被拒）`);
      return;
    }

    // 超长：就地留一句摘要，正文走 .md 附件
    await this.safeEdit(`📄 回复较长（${finalText.length} 字符），见附件。`);
    const file = new AttachmentBuilder(Buffer.from(finalText, 'utf8'), { name: 'reply.md' });
    await this.channel.send({ files: [file] });
    if (denied.length) await this.note(`（有 ${denied.length} 个工具调用因只读限制被拒）`);
  }

  async fail(message) {
    await this.stopTimer();
    this.closed = true;
    if (!this.msg) return;
    await this.safeEdit(`❌ ${message}`);
  }

  async note(text) {
    try {
      await this.channel.send(text);
    } catch {
      /* ignore */
    }
  }

  async safeEdit(body) {
    try {
      await this.msg.edit(body.slice(0, 2000) || '（空）');
    } catch {
      /* ignore */
    }
  }

  async stopTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
