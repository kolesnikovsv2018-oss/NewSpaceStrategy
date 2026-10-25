import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const directory = new URL('./', import.meta.url);
if (process.argv.length > 3 || process.argv[2] === '') throw new Error('Допускается один путь нового выходного JSON');
const manifest = JSON.parse(await readFile(new URL('summary.json', directory), 'utf8'));
for (const file of manifest.base.files) {
  if (createHash('sha256').update(await readFile(file.path)).digest('hex') !== file.sha256) {
    throw new Error(`Исходная база изменилась: ${file.path}`);
  }
}
const output = await open(process.argv[2] ?? new URL('secondary-confirmed.json', directory), 'wx');
try {
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
try {
  const baseline = await server.ssrLoadModule('/src/diagnostics/conquestBaseline.ts');
  const conquest = await server.ssrLoadModule('/src/domain/conquest.ts');
  const ai = await server.ssrLoadModule('/src/domain/conquestAi.ts');
  const saves = await server.ssrLoadModule('/src/utils/ConquestSaveManager.ts');
  const battle = await server.ssrLoadModule('/src/domain/conquestBattle.ts');
  const results = [];
  for (const id of ['6-41-current-ai-direct', '6-41-current-ai-mirror']) {
    const row = manifest.cases.find(row => row.input.id === id);
    const trace = JSON.parse(gunzipSync(await readFile(new URL(row.files.trace, directory))));
    const checkpoint = saves.decodeConquestSave(await readFile(new URL(row.files.checkpoint, directory), 'utf8'));
    const window = id.endsWith('direct') ? 105 : 120;
    const prefix = baseline.runBaseline({ ...row.input, maxTurns: window - 1 },
      { state: checkpoint, turnsExecuted: row.verification.checkpointAt });
    let state = prefix.finalState;
    const commands = trace.windows.find(entry => entry.turn === window).commands;
    for (const record of commands) {
      const command = record.command;
      if (id.endsWith('direct') && command.kind === 'sendShip') {
        const end = { kind: 'endTurn', factionId: 'blue', expectedTurn: window };
        const executed = conquest.executeConquestAction(state, end, true);
        if (!executed.ok) throw new Error(executed.message);
        const events = [];
        const continued = baseline.runBaseline(row.input, { state: executed.state,
          turnsExecuted: executed.state.session.turn - 1 }, { onWindow: entry => {
          if (entry.battles.length || entry.ownershipChanges.length) events.push({
            turn: entry.turn, battles: entry.battles, ownershipChanges: entry.ownershipChanges
          });
        } });
        const repeated = baseline.runBaseline(row.input, { state: saves.decodeConquestSave(saves.encodeConquestSave(executed.state)),
          turnsExecuted: executed.state.session.turn - 1 });
        if (JSON.stringify(continued) !== JSON.stringify(repeated)) throw new Error('Ранний endTurn не повторился');
        results.push({ id, intervention: 'one-early-endTurn-instead-of-first-sendShip', turn: window,
          original: command, alternative: end, paidPrefixCommands: commands.indexOf(record), accepted: true,
          status: continued.status, turnsExecuted: continued.turnsExecuted, repeatAndRoundTrip: 'passed',
          originalBattlesAfter94: row.battles - trace.battles.filter(entry => entry.turn <= 94).length,
          actualBattlesAfter94: continued.battles.length, firstNewBattle: continued.battles[0]?.turn ?? null, events });
        const hold = input => {
          let cursor = input;
          const events = [], commands = [];
          for (let ownEnd = 0; ownEnd < 4; ownEnd++) {
            for (let action = 0; action < 24; action++) {
              const planned = ai.planConquestAction(conquest.getConquestView(cursor, 'blue'));
              const command = planned.kind === 'sendShip' || action === 23
                ? { kind: 'endTurn', factionId: 'blue', expectedTurn: cursor.session.turn } : planned;
              const executed = conquest.executeConquestAction(cursor, command, true);
              if (!executed.ok) throw new Error(executed.message);
              commands.push(command);
              cursor = executed.state;
              if (command.kind === 'endTurn') break;
            }
            const opponent = baseline.runBaseline({ ...row.input, maxTurns: cursor.session.turn },
              { state: cursor, turnsExecuted: cursor.session.turn - 1 }, { onWindow: entry => events.push(entry) });
            if (opponent.status === 'executor-error') throw new Error('Отказ в hold-frontier');
            cursor = opponent.finalState;
          }
          return { state: cursor, events, commands };
        };
        const held = hold(state);
        if (JSON.stringify(held) !== JSON.stringify(hold(saves.decodeConquestSave(saves.encodeConquestSave(state))))) {
          throw new Error('Удержание фронтира не повторилось после load');
        }
        const continuedHold = baseline.runBaseline(row.input, { state: held.state, turnsExecuted: held.state.session.turn - 1 });
        const repeatedHold = baseline.runBaseline(row.input, {
          state: saves.decodeConquestSave(saves.encodeConquestSave(held.state)), turnsExecuted: held.state.session.turn - 1 });
        if (JSON.stringify(continuedHold) !== JSON.stringify(repeatedHold)) throw new Error('Суффикс удержания не повторился');
        const holdBattles = [...held.events.flatMap(entry => entry.battles), ...continuedHold.battles];
        results.push({ id, intervention: 'one-priority-hold-frontier-for-four-own-ends', turn: window,
          end: held.state.session.turn - 1, ownCommands: held.commands, accepted: true,
          status: continuedHold.status, turnsExecuted: continuedHold.turnsExecuted, repeatAndRoundTrip: 'passed',
          firstNewBattle: holdBattles[0]?.turn ?? null, actualBattlesAfter94: holdBattles.length,
          events: held.events.map(entry => ({ turn: entry.turn, battles: entry.battles, ownershipChanges: entry.ownershipChanges })) });
        break;
      }
      if (id.endsWith('mirror') && command.kind === 'endTurn') {
        const executed = conquest.executeConquestAction(state, command, true);
        if (!executed.ok || !executed.frames) throw new Error('Нет реального боя в выбранном окне');
        const report = executed.state.battles.find(entry => entry.id === state.lastBattleId + 1);
        if (!report) throw new Error('Не найден первый реальный бой');
        const presentIds = executed.frames[0].ships.map(ship => ship.id);
        if (JSON.stringify([...presentIds].sort((a, b) => a - b)) !==
          JSON.stringify(report.participants.map(ship => ship.id).sort((a, b) => a - b))) throw new Error('Неоднозначные frames');
        const ships = state.session.ships.filter(ship => presentIds.includes(ship.id)).map(ship => {
          const copy = structuredClone(ship);
          copy.systemId = report.systemId;
          delete copy.transit;
          return copy;
        });
        const seed = ((state.seed ^ Math.imul(window, 2654435761) ^ (state.lastBattleId + 1)) >>> 0) || 1;
        const first = battle.resolveConquestBattle(ships, state.operations, seed, state.battlePolicy);
        if (JSON.stringify(first.frames) !== JSON.stringify(executed.frames) ||
          JSON.stringify(first.destroyed) !== JSON.stringify(report.destroyed)) throw new Error('Микробой не совпал с настоящим endTurn');
        const repeated = battle.resolveConquestBattle(ships, state.operations, seed, state.battlePolicy);
        if (JSON.stringify(first) !== JSON.stringify(repeated)) throw new Error('Микробой не повторяется');
        const encounters = [first];
        let operations = Object.fromEntries(first.survivors.map(ship => [String(ship.id), ship.operational]));
        let remaining = ships.filter(ship => !first.destroyed.includes(ship.id));
        while (encounters.length < 3 && new Set(remaining.map(ship => ship.factionId)).size > 1) {
          const next = battle.resolveConquestBattle(remaining, operations, seed, state.battlePolicy);
          encounters.push(next);
          remaining = remaining.filter(ship => !next.destroyed.includes(ship.id));
          operations = Object.fromEntries(next.survivors.map(ship => [String(ship.id), ship.operational]));
        }
        results.push({ id, intervention: 'isolated-same-seed-encounters-with-persisted-hp-no-intermediate-service',
          turn: window, systemId: report.systemId, seed, tacticalRules: first.tacticalRules, policy: state.battlePolicy,
          actualEndTurnFramesAndRepeat: 'passed', ships, initialOperations: Object.fromEntries(ships.map(ship =>
            [String(ship.id), state.operations[String(ship.id)]])),
          encounters: encounters.map(result => ({ winner: result.winner, timedOut: result.timedOut,
            destroyed: result.destroyed, survivors: result.survivors })),
          scope: 'isolated-tactical-diagnostic-not-a-strategic-continuation' });
        break;
      }
      const executed = conquest.executeConquestAction(state, command, true);
      if (!executed.ok) throw new Error(executed.message);
      state = executed.state;
    }
  }
  if (results.length !== 3) throw new Error('Не завершены три вторичные проверки');
  await output.writeFile(JSON.stringify({
    format: 'orion-conquest-timeout-secondary', schemaVersion: 1, sourceSha256: manifest.base.sourceSha256, results
  }, null, 2) + '\n');
  console.log(JSON.stringify(results.map(result => ({ id: result.id, intervention: result.intervention,
    firstNewBattle: result.firstNewBattle, status: result.status,
    encounters: result.encounters?.map(battle => ({ timedOut: battle.timedOut, destroyed: battle.destroyed })) }))));
} finally {
  await server.close();
}
} finally {
  await output.close();
}
