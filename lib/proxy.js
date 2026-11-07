import https from 'node:https';
import { createRequire } from 'node:module';
import { HttpsProxyAgent } from 'https-proxy-agent';

const require = createRequire(import.meta.url);

// 本机只有走本地代理（Clash/Surge 之类）才连得上 Discord，而 Node 的 fetch 和 ws
// 都**不读** HTTP_PROXY 环境变量 —— 只有 curl 读。所以这里手工把两条路都接上：
//   1) 网关 WebSocket：ws 对 wss 会调 https.request，注入 CONNECT 隧道 agent
//   2) REST API：@discordjs/rest 用 undici，设全局 dispatcher
// 用 createRequire 拿 undici，保证和 @discordjs/rest require 到的是同一个模块实例。

export function resolveProxyUrl(cfg = {}) {
  return (
    cfg.proxyUrl ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null
  );
}

export function installProxy(proxyUrl) {
  if (!proxyUrl) return false;

  // 1) WebSocket 网关
  const agent = new HttpsProxyAgent(proxyUrl);
  const origRequest = https.request;
  https.request = function patched(...args) {
    const [options] = args;
    if (options && typeof options === 'object') {
      options.agent = options.agent ?? agent;
    }
    return origRequest.apply(this, args);
  };

  // 2) REST
  try {
    const { setGlobalDispatcher, ProxyAgent } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (err) {
    console.warn('[bridge] undici 代理设置失败（REST 可能连不上）：', err.message);
  }

  return true;
}
