import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// thread 绑定：{ "<threadId>": { sessionId, title?, pending? } }
const mapPath = (configDir) => join(configDir, 'threads.json');

export function loadMap(configDir) {
  try {
    return JSON.parse(readFileSync(mapPath(configDir), 'utf8'));
  } catch {
    return {};
  }
}

export function saveMap(configDir, map) {
  try {
    writeFileSync(mapPath(configDir), JSON.stringify(map, null, 2));
  } catch {
    /* 存不下来不该拖垮主流程 */
  }
}