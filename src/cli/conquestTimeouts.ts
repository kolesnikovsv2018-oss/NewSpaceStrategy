import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { baselineMatrix, runBaseline, verifyBaseline, BASELINE_TRACE_VERSION,
  type BaselineRun, type BaselineWindowTrace } from '../diagnostics/conquestBaseline';
import { decodeConquestSave, encodeConquestSave } from '../utils/ConquestSaveManager';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export function createLateBaselineCheckpoint(run: BaselineRun) {
  const turnsExecuted = Math.min(60, run.turnsExecuted - 1);
  if (turnsExecuted < 1) throw new Error(`Нет поздней контрольной точки до остановки: ${run.input.id}`);
  const prefix = runBaseline({ ...run.input, maxTurns: turnsExecuted });
  if (prefix.turnsExecuted !== turnsExecuted || prefix.outcome.status !== 'ongoing') {
    throw new Error(`Префикс поздней контрольной точки не соответствует партии: ${run.input.id}`);
  }
  return { turnsExecuted, json: encodeConquestSave(prefix.finalState) };
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('yarn baseline:conquest --trace-timeouts --output-dir <new-directory>\n18 paid6 до200 окон, repeat/early/late checkpoints; каталог не перезаписывается.');
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1]) {
    console.error('Требуется --output-dir <new-directory>');
    return 1;
  }
  await mkdir(args[1]);
  const paths = (await readdir('src', { recursive: true })).filter(path => /\.(ts|mjs)$/.test(path)).map(path => join('src', path));
  paths.push('yarn.lock');
  const files = await Promise.all(paths.sort().map(async path => ({ path, sha256: hash(await readFile(path)) })));
  const base = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSha256: hash(JSON.stringify(files)), files };
  const cases = [];
  for (const input of baselineMatrix().filter(item => item.kind === 'paid' && item.worldCount === 6)) {
    const windows: BaselineWindowTrace[] = [];
    let checkpoint: { turnsExecuted: number; json: string } | undefined;
    const run = runBaseline(input, undefined, { checkpointAt: 60, onWindow(window, json) {
      windows.push(window);
      if (json) checkpoint = { turnsExecuted: window.turnsExecuted, json };
    } });
    const verification = verifyBaseline(run);
    if (!checkpoint || checkpoint.turnsExecuted >= run.turnsExecuted) checkpoint = createLateBaselineCheckpoint(run);
    const checkpointTurn = checkpoint.turnsExecuted;
    const continuationWindows: BaselineWindowTrace[] = [];
    const continued = runBaseline(input, { turnsExecuted: checkpointTurn,
      state: decodeConquestSave(checkpoint.json) }, { onWindow: window => continuationWindows.push(window) });
    const suffix = run.commands.filter(record => record.command.expectedTurn > checkpointTurn);
    if (JSON.stringify(continued.finalState) !== JSON.stringify(run.finalState) ||
      JSON.stringify(continued.commands) !== JSON.stringify(suffix) ||
      JSON.stringify(continued.outcome) !== JSON.stringify(run.outcome) || continued.status !== run.status ||
      JSON.stringify(continuationWindows) !== JSON.stringify(windows.filter(window => window.turn > checkpointTurn))) {
      throw new Error(`Поздняя контрольная точка изменила state/commands/trace: ${input.id}`);
    }
    const last = windows[windows.length - 1].position;
    const summary = { input, status: run.status, turnsExecuted: run.turnsExecuted, outcome: run.outcome,
      verification: { ...verification, lateRoundTrip: 'passed', checkpointAt: checkpointTurn },
      versions: run.versions, battles: run.battles.length, battleTimeouts: run.battleTimeouts,
      metrics: run.metrics, finalStateSha256: hash(encodeConquestSave(run.finalState)),
      ownership: windows.filter(window => window.ownershipChanges.length).map(window => ({
        turn: window.turn, changes: window.ownershipChanges })),
      final: last,
      activityAfter100: {
        captures: windows.filter(window => window.turn > 100).reduce((sum, window) => sum + window.ownershipChanges.length, 0),
        battles: run.battles.filter(battle => battle.turn > 100).length,
        commandKinds: Object.fromEntries([...new Set(run.commands.map(record => record.command.kind))].map(kind => [
          kind, run.commands.filter(record => record.command.expectedTurn > 100 && record.command.kind === kind).length
        ]))
      },
      files: { trace: `${input.id}.trace.json.gz`, checkpoint: `${input.id}.save.json` } };
    await writeFile(join(args[1], summary.files.trace), gzipSync(JSON.stringify({
      format: 'orion-conquest-window-trace', schemaVersion: BASELINE_TRACE_VERSION,
      input, windows, battles: run.battles
    }) + '\n'), { flag: 'wx' });
    await writeFile(join(args[1], summary.files.checkpoint), checkpoint.json + '\n', { encoding: 'utf8', flag: 'wx' });
    cases.push(summary);
    console.error(`${input.id}: ${run.status}/${run.turnsExecuted}, battles=${run.battles.length}, repeat/early/late=passed`);
  }
  await writeFile(join(args[1], 'summary.json'), JSON.stringify({
    format: 'orion-conquest-timeout-analysis', schemaVersion: BASELINE_TRACE_VERSION, base, cases
  }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`Сохранено ${cases.length} проверенных партий`);
  return cases.some(run => run.status === 'executor-error') ? 1 : 0;
}
