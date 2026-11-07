import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Н17.2: статические фикстуры прежней версии (save 18) заменяются новыми оплаченными
// сценариями актуальной версии (прецедент upgrade-n15-fixtures.mjs). Сценарий — реальная
// партия baseline 40 миров / seed 41 / campaignSeed 101 / current-ai / direct, сыгранная
// настоящим AI-конвейером до контрольных точек перед ходами 199 и 200.
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
try {
  const { createBaselineStart, runBaseline, baselineInputSchema } = await server.ssrLoadModule('/src/diagnostics/conquestBaseline.ts');
  const { encodeConquestSave } = await server.ssrLoadModule('/src/utils/ConquestSaveManager.ts');
  const input = baselineInputSchema.parse({
    id: '40-41-current-ai-direct', worldCount: 40, mapSeed: 41, campaignSeed: 101,
    mirrored: false, schedule: 'current-ai', kind: 'paid', maxTurns: 200
  });
  const outputDir = 'reports/2026-11-06/n17-2-state-platform/replays';
  await mkdir(outputDir, { recursive: true });
  const capture = async checkpointAt => {
    let captured;
    runBaseline(input, undefined, {
      checkpointAt,
      onWindow: (_window, checkpointJson) => { if (checkpointJson) captured = checkpointJson; }
    });
    if (!captured) throw new Error(`Контрольная точка ${checkpointAt} не зафиксирована`);
    return captured;
  };
  const run = runBaseline(input);
  if (run.status !== 'timeout' || run.turnsExecuted !== 200) throw new Error(`Оплаченный сценарий не дошёл до cutoff: ${run.status}/${run.turnsExecuted}`);
  // before-199: после 198 выполненных ходов (следующий пакет — ход 199); before-200: после 199.
  const before199 = await capture(198);
  const before200 = await capture(199);
  const first = JSON.parse(before199);
  if (first.conquest.session.schedule.turn !== 199) throw new Error('Контрольная точка перед ходом 199 не совпадает');
  if (first.conquest.session.schedule.activeIndex !== 0) throw new Error('Ход 199 должен принадлежать первому участнику');
  await writeFile(join(outputDir, '40-41-current-ai-direct.before-199.save.json'), before199 + '\n');
  await writeFile(join(outputDir, '40-41-current-ai-direct.before-200.save.json'), before200 + '\n');
  console.log(`fixtures written to ${outputDir} (schema 19, turns 199/200)`);
  process.exitCode = 0;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
}
