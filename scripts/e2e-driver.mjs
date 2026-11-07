// E2E-oracle Н17.2: настоящий chromium, CDP-сценарий в одном вызове.
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const [, , mode] = process.argv; // desktop | mobile
const width = mode === 'mobile' ? 390 : 1280;
const height = mode === 'mobile' ? 844 : 720;
const GAME_W = 1280;
const URL_ = 'http://localhost:4173/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

rmSync(`.chromium-e2e-${mode}`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9222', `--user-data-dir=.chromium-e2e-${mode}`,
  `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });

try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch('http://127.0.0.1:9222/json/version'); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('no CDP');
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error) + ' for id ' + msg.id)) : p.resolve(msg.result);
    }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: mode === 'mobile' });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result.value;
  };
  let rect = { left: 0, top: 0, width, height: height, backingW: 1280, backingH: 720 };
  const refreshRect = async () => {
    rect = await evaluate(`(() => { const c = document.querySelector('canvas'); if (!c) return { left: 0, top: 0, width: 1, height: 1, backingW: 1280, backingH: 720 }; const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, backingW: c.width, backingH: c.height }; })()`);
  };
  const click = async (gx, gy) => {
    await refreshRect();
    // Игра -> клиент: пропорция backing-хранилища канивы к его CSS-размеру.
    const x = rect.left + gx * (rect.width / rect.backingW);
    const y = rect.top + gy * (rect.height / rect.backingH);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left',
        buttons: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, clickCount: 1 });
      await sleep(45);
    }
  };
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`/tmp/e2e-${mode}-${name}.png`, Buffer.from(r.data, 'base64'));
  };
  const waitGame = async () => {
    for (let i = 0; i < 60; i++) {
      await refreshRect();
      if (rect.width > 100) break;
      await sleep(200);
    }
  };
  // Координаты кнопок в игровых координатах: wide-раскладка (1280x720) и narrow (по размеру окна).
  const ui = mode === 'mobile' ? {
    menuConquest: [195, 422],   // меню: Новая кампания
    dialogLocal: [100, 485],    // диалог: Локальная партия (content 12,24 + local 0,440)
    dialogCancel: [100, 585],   // диалог: Отмена (local 0,544)
    loadPanel: [100, 152],      // панель без партии: Загрузить партию (12,132)
    confirm: [260, 175],        // confirm: Подтвердить (content 12+366-160, y=130)
    endTurn: [60, 94],          // Завершить ход (12,72)
    tabActions: [310, 198],     // вкладка Партия (12+2*(third+8), 176)
    tabMap: [60, 146],          // вкладка Мир (12, 124)
    save: [90, 314],            // Сохранить (12,292)
    menu: [100, 574]            // Меню (12,552)
  } : {
    menuConquest: [640, 360],
    dialogLocal: [320, 486],
    dialogCancel: [330, 585],
    loadPanel: [250, 118],
    confirm: [860, 175],
    endTurn: [1095, 105],
    tabActions: null,
    tabMap: null,
    save: [410, 45],
    menu: [730, 45]
  };
  const at = key => { const p2 = ui[key]; if (!p2) throw new Error('no position for ' + key); return click(p2[0], p2[1]); };
  const oracle = { mode, steps: [] };
  await send('Page.navigate', { url: URL_ });
  await sleep(2500);
  await waitGame();
  // 1. Меню -> Новая кампания.
  await at('menuConquest');
  await sleep(900);
  // 2. Диалог новой кампании -> Локальная партия.
  await at('dialogLocal');
  await sleep(2200);
  await shot('1-campaign');
  oracle.steps.push('campaign-started');
  // 3. Завершить ход.
  await at('endTurn');
  await sleep(900);
  await shot('2-turn2');
  // 4. Сохранить (в narrow - через вкладку Партия) и проверить сохранение.
  if (ui.tabActions) { await at('tabActions'); await sleep(700); }
  await at('save');
  await sleep(600);
  await at('confirm');
  await sleep(900);
  const saved = await evaluate(`(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('orion')) { const v = JSON.parse(localStorage.getItem(k)); if (v && v.conquest) return { schemaVersion: v.schemaVersion, rulesVersion: v.rulesVersion, turn: v.conquest.session.schedule.turn, order: v.conquest.session.schedule.order, participants: v.conquest.participants.map(p => p.id) }; } } return null; })()`);
  oracle.saved = saved;
  if (ui.tabMap) { await at('tabMap'); await sleep(600); }
  await shot('2b-saved');
  const readSave = () => evaluate(`(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('orion')) { const v = JSON.parse(localStorage.getItem(k)); if (v && v.conquest) return { schemaVersion: v.schemaVersion, rulesVersion: v.rulesVersion, turn: v.conquest.session.schedule.turn, order: v.conquest.session.schedule.order, participants: v.conquest.participants.map(p => p.id) }; } } return null; })()`);
  // 5. Перезагрузка: приложение стартует с меню; путь загрузки - через conquest-сцену.
  await send('Page.reload', {});
  await sleep(2800);
  await at('menuConquest');
  await sleep(900);
  await at('dialogCancel');
  await sleep(600);
  await at('loadPanel');
  await sleep(700);
  await at('confirm');
  await sleep(1000);
  await shot('3-loaded');
  // 6. Ход после загрузки: расписание продолжается с загруженного хода.
  await at('endTurn');
  await sleep(900);
  await shot('3b-loaded-turn3');
  if (ui.tabActions) { await at('tabActions'); await sleep(700); }
  // Сохранение с confirm; повторяем пару кликов, пока сохранение не подтвердится.
  let savedAfterLoad = null;
  for (let attempt = 0; attempt < 3 && (!savedAfterLoad || savedAfterLoad.turn !== 3); attempt++) {
    await at('save');
    await sleep(600);
    await at('confirm');
    await sleep(900);
    savedAfterLoad = await readSave();
  }
  oracle.savedAfterLoad = savedAfterLoad;
  await shot('3c-saved');
  // 7. Отмена: Меню -> Подтвердить.
  await at('menu');
  await sleep(700);
  await at('confirm');
  await sleep(700);
  await shot('4-menu');
  oracle.steps.push('exited-to-menu');
  writeFileSync(`/tmp/e2e-${mode}-oracle.json`, JSON.stringify(oracle, null, 2) + '\n');
  const savedOk = saved && saved.schemaVersion === 19 && saved.turn === 2 &&
    JSON.stringify(saved.order) === '["player-01","player-02"]' &&
    JSON.stringify(saved.participants) === '["player-01","player-02"]';
  const afterLoadOk = savedAfterLoad && savedAfterLoad.turn === 3;
  console.log('ORACLE', JSON.stringify({ mode, savedOk, afterLoadOk }));
  process.exitCode = savedOk && afterLoadOk ? 0 : 1;
} finally {
  chrome.kill('SIGKILL');
}
