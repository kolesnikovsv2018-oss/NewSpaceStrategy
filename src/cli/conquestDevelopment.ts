import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { baselineInputSchema, createBaselineStart, runBaseline, BASELINE_VERSION } from '../diagnostics/conquestBaseline';
import { replayDevelopmentCommands, type DevelopmentWindow } from '../diagnostics/conquestDevelopment';
import { conquestSchema, conquestCommandSchema, getConquestOutcome, type Conquest } from '../domain/conquest';
import { getGalaxyDefinition } from '../domain/campaign';
import { encodeConquestSave, decodeConquestSave, CONQUEST_SAVE_VERSION, CONQUEST_RULES_VERSION } from '../utils/ConquestSaveManager';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const versionsSchema = z.object({
  baseline: z.literal(BASELINE_VERSION), save: z.literal(CONQUEST_SAVE_VERSION), rules: z.literal(CONQUEST_RULES_VERSION),
  tree: z.number().int().positive(), battlePolicy: z.enum(['campaign-v1', 'campaign-v2']),
  tacticalRules: z.literal('design-combat-v1')
}).strict();
const archiveSchema = z.object({
  run: z.object({
    input: baselineInputSchema, versions: versionsSchema, status: z.literal('timeout'), turnsExecuted: z.literal(200),
    commands: z.array(z.object({ command: conquestCommandSchema, result: z.literal('accepted') }).passthrough()).min(1).max(4800),
    finalState: conquestSchema
  }).passthrough(),
  verification: z.object({ repeat: z.literal('passed'), roundTrip: z.literal('passed') }).strict()
}).strict();
const sourceSchema = z.object({
  input: baselineInputSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).passthrough();

async function sourceFingerprint() {
  const paths = (await readdir('src', { recursive: true })).filter(path => /\.(ts|mjs)$/.test(path))
    .map(path => join('src', path));
  paths.push('yarn.lock');
  const files = await Promise.all(paths.sort().map(async path => ({ path, sha256: hash(await readFile(path)) })));
  return { sourceSha256: hash(JSON.stringify(files)), files };
}

function position(state: Conquest) {
  const goals = getGalaxyDefinition(state.session.galaxy).systems.filter(world => world.habitable);
  return {
    turn: state.session.turn, outcome: getConquestOutcome(state), victory: state.victory.kind,
    totalGoals: goals.length,
    neutralGoals: goals.filter(goal => state.session.galaxy.systems.find(world => world.id === goal.id)!.ownerId === null).length,
    sides: (['blue', 'red'] as const).map(side => ({
      side, colonies: state.session.galaxy.systems.filter(world => world.ownerId === side).length,
      surveys: Object.keys(state.surveys[side]).length,
      research: state.research[side].completed.length,
      ships: state.session.ships.filter(ship => ship.factionId === side).length
    }))
  };
}

function activity(windows: readonly DevelopmentWindow[]) {
  return {
    windows: windows.length,
    ownEnds: Object.fromEntries((['blue', 'red'] as const).map(side => [
      side, windows.filter(window => window.factionId === side).reduce((sum, window) => sum + window.advanced, 0)
    ])),
    commands: windows.reduce((sum, window) => sum + window.commandCount, 0),
    idleIndustryAssignments: windows.reduce((sum, window) => sum + window.idleIndustryAssignments, 0),
    fullBudgetWindows: windows.filter(window => window.fullBudget).length,
    ownershipChanges: windows.reduce((sum, window) => sum + window.ownershipChanges.length, 0),
    commandKinds: Object.fromEntries([...new Set(windows.flatMap(window => Object.keys(window.commandKinds)))].map(kind => [
      kind, windows.reduce((sum, window) => sum + Object.entries(window.commandKinds)
        .filter(([key]) => key === kind).reduce((total, [, count]) => total + count, 0), 0)
    ]))
  };
}

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('yarn baseline:conquest --development --archive <case.run.json.gz> --output-dir <new-dir> [--from-window 160]\nВоспроизведение проверенного cutoff200 и сравнение суффикса без изменения горизонта.');
    return 0;
  }
  if (![4, 6].includes(args.length) || args[0] !== '--archive' || !args[1]?.endsWith('.run.json.gz') ||
    args[2] !== '--output-dir' || !args[3] || args.length === 6 && (args[4] !== '--from-window' || !/^\d+$/.test(args[5]))) {
    console.error('Требуются --archive <case.run.json.gz> --output-dir <new-dir> [--from-window 160]');
    return 1;
  }
  const fromWindow = args.length === 6 ? Number(args[5]) : 160;
  if (!Number.isInteger(fromWindow) || fromWindow < 1 || fromWindow >= 200) {
    console.error('Начало суффикса должно быть целым от1 до199');
    return 1;
  }
  const bytes = await readFile(args[1]);
  const original = sourceSchema.parse(JSON.parse(await readFile(join(dirname(args[1]),
    basename(args[1]).replace(/\.run\.json\.gz$/, '.result.json')), 'utf8')));
  if (hash(bytes) !== original.sha256) throw new Error('SHA256 архива не совпадает с исходным результатом');
  const archive = archiveSchema.parse(JSON.parse(gunzipSync(bytes).toString('utf8'))).run;
  if (!isDeepStrictEqual(original.input, archive.input) || archive.input.kind !== 'paid' ||
    archive.input.worldCount === 6 || archive.input.maxTurns !== 200) throw new Error('Архив не является заявленным large cutoff200');
  const start = createBaselineStart(archive.input).state;
  if (archive.versions.tree !== start.researchTree.version || archive.versions.battlePolicy !== start.battlePolicy ||
    archive.versions.tacticalRules !== start.tacticalRules) throw new Error('Версии архива не соответствуют текущему исполнению');
  const source = await sourceFingerprint();
  await mkdir(args[3]);
  const replayed = replayDevelopmentCommands(start, archive.commands.map(record => record.command), fromWindow + 1);
  if (!isDeepStrictEqual(replayed.finalState, archive.finalState) || !replayed.checkpoint ||
    replayed.finalState.session.turn !== 201 || getConquestOutcome(replayed.finalState).status !== 'ongoing') {
    throw new Error('Старые команды больше не воспроизводят исходный cutoff/checkpoint');
  }
  const checkpoint = encodeConquestSave(replayed.checkpoint);
  await writeFile(join(args[3], 'before.save.json'), checkpoint + '\n', { flag: 'wx' });
  const resume = () => ({ state: decodeConquestSave(checkpoint), turnsExecuted: fromWindow });
  const current = runBaseline(archive.input, resume());
  if (current.status === 'executor-error') throw new Error('Ошибка executor в текущем суффиксе');
  const repeat = runBaseline(archive.input, resume());
  if (!isDeepStrictEqual(current, repeat)) throw new Error('Текущий суффикс не воспроизводится после load');
  const midway = Math.min(Math.floor((fromWindow + archive.input.maxTurns) / 2), current.turnsExecuted - 1);
  let middleRoundTrip: 'passed' | 'unavailable-short-suffix' = 'unavailable-short-suffix';
  if (midway > fromWindow) {
    const prefix = runBaseline({ ...archive.input, maxTurns: midway }, resume());
    if (prefix.turnsExecuted !== midway || prefix.outcome.status !== 'ongoing') throw new Error('Некорректная средняя контрольная точка');
    const middle = encodeConquestSave(prefix.finalState);
    const continued = runBaseline(archive.input, { state: decodeConquestSave(middle), turnsExecuted: midway });
    if (!isDeepStrictEqual(continued.finalState, current.finalState) || continued.status !== current.status ||
      !isDeepStrictEqual(continued.outcome, current.outcome) ||
      !isDeepStrictEqual(continued.commands, current.commands.filter(record => record.command.expectedTurn > midway))) {
      throw new Error('Midway save/load изменил результат или команды');
    }
    await writeFile(join(args[3], 'midway.save.json'), middle + '\n', { flag: 'wx' });
    middleRoundTrip = 'passed';
  }
  const currentReplay = replayDevelopmentCommands(decodeConquestSave(checkpoint),
    current.commands.map(record => record.command), fromWindow + 1);
  if (!isDeepStrictEqual(currentReplay.finalState, current.finalState)) throw new Error('Replay текущего суффикса изменил результат');
  if (!isDeepStrictEqual(source, await sourceFingerprint())) throw new Error('Исходники изменились во время сравнения');
  const oldWindows = replayed.windows.filter(window => window.turn > fromWindow);
  const summary = {
    format: 'orion-ai-development-comparison', schemaVersion: 1, input: archive.input,
    source, archivedSha256: original.sha256, fromWindow, throughWindow: archive.input.maxTurns,
    verification: { archivedReplay: 'passed', repeat: 'passed', roundTrip: 'passed', middleRoundTrip },
    observer: 'full-state-diagnostic-only',
    before: position(replayed.checkpoint),
    archived: { position: position(replayed.finalState), activity: activity(oldWindows) },
    current: { status: current.status, position: position(current.finalState), activity: activity(currentReplay.windows) }
  };
  await writeFile(join(args[3], 'current.save.json'), encodeConquestSave(current.finalState) + '\n', { flag: 'wx' });
  await writeFile(join(args[3], 'windows.json.gz'), gzipSync(JSON.stringify({
    archived: oldWindows, current: currentReplay.windows, commands: current.commands
  }) + '\n'), { flag: 'wx' });
  await writeFile(join(args[3], 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
  console.log(`${archive.input.id}: idle ${summary.archived.activity.idleIndustryAssignments}→${summary.current.activity.idleIndustryAssignments}; ${current.status}/${current.turnsExecuted}; replay/repeat/save passed`);
  return 0;
}
