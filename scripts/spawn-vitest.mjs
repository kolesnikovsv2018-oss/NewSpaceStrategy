// Запуск vitest-батча в фоне: child_process с detached:true переживает выход
// шелла среды (голый setsid убивается песочницей). Пишет done-маркер с кодом выхода.
// Использование: node scripts/spawn-vitest.mjs <doneMarker> <logFile> <vitest args...>
import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';

const [donePath, logPath, ...vitestArgs] = process.argv.slice(2);
if (!donePath || !logPath || vitestArgs.length === 0) {
  console.error('usage: node spawn-vitest.mjs <doneMarker> <logFile> <vitest args...>');
  process.exit(2);
}

const log = openSync(logPath, 'w');
const child = spawn('npx', ['vitest', 'run', ...vitestArgs], {
  detached: true,
  stdio: ['ignore', log, log],
  env: process.env,
});
child.unref();
void child.on('exit', code => {
  writeFileSync(donePath, String(code ?? 1));
});
process.exit(0);
