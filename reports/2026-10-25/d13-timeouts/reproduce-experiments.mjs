import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const directory = new URL('./', import.meta.url);
if (process.argv.length > 3 || process.argv[2] === '') throw new Error('Допускается один путь нового выходного JSON');
const manifest = JSON.parse(await readFile(new URL('summary.json', directory), 'utf8'));
for (const file of manifest.base.files) {
  const actual = createHash('sha256').update(await readFile(file.path)).digest('hex');
  if (actual !== file.sha256) throw new Error(`Исходная база изменилась: ${file.path}`);
}
const output = await open(process.argv[2] ?? new URL('experiments.json', directory), 'wx');
try {
const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
try {
  const baseline = await server.ssrLoadModule('/src/diagnostics/conquestBaseline.ts');
  const conquest = await server.ssrLoadModule('/src/domain/conquest.ts');
  const ai = await server.ssrLoadModule('/src/domain/conquestAi.ts');
  const travel = await server.ssrLoadModule('/src/domain/campaignTravel.ts');
  const campaign = await server.ssrLoadModule('/src/domain/campaign.ts');
  const saves = await server.ssrLoadModule('/src/utils/ConquestSaveManager.ts');
  const evidence = [];
  for (const row of manifest.cases) {
    const saved = saves.decodeConquestSave(await readFile(new URL(row.files.checkpoint, directory), 'utf8'));
    const worldPositions = campaign.getGalaxyDefinition(saved.session.galaxy).systems;
    const trace = JSON.parse(gunzipSync(await readFile(new URL(row.files.trace, directory))));
    const windows = trace.windows;
    const last = windows.at(-1).position;
    const commands = windows.flatMap(window => window.commands.map(record => record.command));
    const owns = (position, side) => position.worlds.filter(world => world.ownerId === side).length;
    const frontier = position => position.factions.map(faction => ({
      side: faction.side,
      targets: position.worlds.filter(world => world.ownerId !== faction.side && world.ownerId !== null &&
        faction.knowledge.known.includes(world.id) && faction.knowledge.surveys[world.id] === undefined).map(world => world.id)
    }));
    const firstBlocked = [];
    for (const side of ['blue', 'red']) {
      const first = windows.find(window => {
        const sideFrontier = frontier(window.position).find(entry => entry.side === side);
        return sideFrontier.targets.some(target => window.position.ships.some(ship => ship.side === side &&
          !ship.transit && ship.tactical.weapons.length &&
          window.position.worlds.find(world => world.id === ship.systemId).ownerId === side &&
          travel.getTravelQuote(travel.getWorldDistance(worldPositions, ship.systemId, target),
            ship.capabilities, ship.fuel).ok));
      });
      firstBlocked.push({ side, snapshotTurn: first?.turn ?? null });
    }
    const keys = windows.map(window => JSON.stringify({
      phase: window.turn % 2, owners: window.position.worlds.map(world => [world.id, world.ownerId]),
      ships: window.position.ships,
      factions: window.position.factions.map(faction => ({
        side: faction.side, knowledge: { known: faction.knowledge.known, habitable: faction.knowledge.habitable,
          surveys: faction.knowledge.surveys, visible: faction.knowledge.visible, enemies: faction.knowledge.enemies },
        research: faction.research, orders: faction.orders, completed: faction.completed, projects: faction.projects
      }))
    }));
    let recurrence = null;
    for (let period = 1; period <= 40; period++) {
      let start = keys.length - period;
      while (start > 0 && keys[start - 1] === keys[start - 1 + period]) start--;
      if (keys.length - start >= period * 3 && (!recurrence || start < recurrence.startIndex)) {
        const end = start + Math.floor((keys.length - 1 - start) / period) * period;
        recurrence = { period, startIndex: start, fromTurn: windows[start].turn, toTurn: windows[end].turn,
          economicDrift: windows[end].position.factions.map((faction, index) => ({
            side: faction.side,
            credits: faction.treasury.credits - windows[start].position.factions[index].treasury.credits,
            minerals: faction.treasury.minerals - windows[start].position.factions[index].treasury.minerals
          })) };
      }
    }
    const facts = { id: row.input.id, status: row.status, firstBlocked, frontier: frontier(last), recurrence,
      maxOwned: Object.fromEntries(['blue', 'red'].map(side => [side, Math.max(...windows.map(window => owns(window.position, side)))])),
      lastOwnershipChange: windows.filter(window => window.ownershipChanges.length).at(-1)?.turn ?? null,
      production: Object.fromEntries(['blue', 'red'].map(side => [side, {
        firstOrder: row.metrics[side].firstOrder, firstRelease: row.metrics[side].firstRelease,
        allResearchAt: windows.find(window => window.position.factions.find(faction => faction.side === side)
          .research.completed.length === saved.researchTree.nodes.length)?.turn ?? null
      }])),
      commandCounts: Object.fromEntries([...new Set(commands.map(command => command.kind))].map(kind => [
        kind, commands.filter(command => command.kind === kind).length
      ])),
      limits: {
        maximumShipsPerSide: Math.max(...windows.flatMap(window => ['blue', 'red'].map(side =>
          window.position.ships.filter(ship => ship.side === side).length))),
        maximumPendingPerSide: Math.max(...windows.flatMap(window => window.position.factions.map(side => side.orders.length + side.completed.length + side.projects.length))),
        maximumCommandCount: Math.max(...windows.map(window => window.commands.length)),
        forcedEnds: windows.filter(window => window.commands.length === 24).length,
        badBudgets: windows.flatMap(window => window.position.factions).filter(side => !side.budget.ok).length,
        shortageForecasts: windows.flatMap(window => window.position.factions).filter(side => side.budget.ok && side.budget.upkeep.shortfallCredits > 0).length,
        lastOrderId: last.counters.order
      } };
    if (row.status !== 'timeout') {
      evidence.push(facts);
      continue;
    }
    const special = row.input.id === '6-12345-production-first-mirror';
    const actor = row.input.schedule === 'research-first' ? (row.input.mirrored ? 'blue' : 'red')
      : row.input.schedule === 'production-first' && !special ? 'red' : 'blue';
    const variants = [{ side: actor, mode: 'blind-target' }];
    if (special) variants.push({ side: 'red', mode: 'farther-known-target' });
    facts.counterfactuals = [];
    for (const { side, mode } of variants) {
    const beforeWindow = side === 'blue' ? 104 : 105;
    let prefixTrace;
    const prefix = baseline.runBaseline({ ...row.input, maxTurns: beforeWindow },
      { state: saved, turnsExecuted: row.verification.checkpointAt }, { onWindow: window => { prefixTrace = window; } });
    if (JSON.stringify(prefixTrace) !== JSON.stringify(windows.find(window => window.turn === beforeWindow))) {
      throw new Error(`Префикс контрфакта не совпал с исходной трассой: ${row.input.id}`);
    }
    let state = prefix.finalState;
    const original = windows.find(window => window.turn === beforeWindow + 1).commands;
    let changed = null;
    for (let index = 0; index < original.length; index++) {
      const command = original[index].command;
      const view = conquest.getConquestView(state, side);
      const planned = index === 23 ? { kind: 'endTurn', factionId: side, expectedTurn: view.turn } : ai.planConquestAction(view);
      if (JSON.stringify(planned) !== JSON.stringify(command)) {
        throw new Error(`Общий префикс/суффикс решения изменился: ${row.input.id}/${index}`);
      }
      const targetFor = ship => {
        const caps = travel.getTravelCapabilities(ship.design.strategicEquipment);
        const distance = world => travel.getWorldDistance(view.galaxy.systems, ship.systemId, world.id);
        return view.galaxy.systems.filter(world => (mode === 'blind-target'
          ? view.knownSystems.includes(world.id) && view.environmentKnowledge[world.id] === undefined
          : view.knownHabitableSystems.includes(world.id) && (world.visibility === 'unknown' || world.ownerId !== side)) &&
          world.id !== command.destinationId && travel.getTravelQuote(distance(world), caps, ship.fuel).ok)
          .sort((a, b) => (mode === 'farther-known-target' ? distance(b) - distance(a) : 0) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
      };
      const eligible = ship => !ship.transit && ship.design.slots.some(slot =>
        ['beam', 'projectile'].includes(slot.component?.kind)) && view.galaxy.systems.some(world =>
        world.id === ship.systemId && world.visibility === 'explored' && world.ownerId === side);
      const ship = command.kind === 'sendShip' ? view.ships.find(ship => ship.id === command.shipId)
        : command.kind === 'endTurn' ? view.ships.find(ship => eligible(ship) && targetFor(ship)) : undefined;
      const target = ship && eligible(ship) ? targetFor(ship) : undefined;
      if (target) {
        const actual = command.kind === 'sendShip' ? { ...command, destinationId: target.id } : {
          kind: 'sendShip', factionId: side, expectedTurn: view.turn, shipId: ship.id,
          systemId: ship.systemId, destinationId: target.id };
        changed = { commandIndex: index, mode, original: command, alternative: actual,
          factor: command.kind === 'sendShip' ? 'one-sendShip-destination-only' : 'one-additional-sendShip-before-end',
          ownObservation: { target, knownSystems: view.knownSystems, environmentKnowledge: view.environmentKnowledge,
            ship, operational: view.operations[String(ship.id)], treasury: view.treasury },
          quote: travel.getTravelQuote(travel.getWorldDistance(view.galaxy.systems, ship.systemId, target.id),
            travel.getTravelCapabilities(ship.design.strategicEquipment), ship.fuel) };
        const executed = conquest.executeConquestAction(state, actual, true);
        if (!executed.ok) throw new Error(`${row.input.id}: ${executed.code}/${executed.message}`);
        state = executed.state;
        break;
      }
      const executed = conquest.executeConquestAction(state, command, true);
      if (!executed.ok) throw new Error(`${row.input.id}: ${executed.code}/${executed.message}`);
      state = executed.state;
    }
    if (!changed) throw new Error(`Нет единственной допустимой альтернативы в выбранном окне: ${row.input.id}/${mode}`);
    const alternativeWindows = [];
    const alternative = baseline.runBaseline(row.input, { state, turnsExecuted: state.session.turn - 1 },
      { onWindow: window => alternativeWindows.push(window) });
    const suffix = original.slice(changed.commandIndex + (changed.original.kind === 'sendShip' ? 1 : 0));
    if (JSON.stringify(alternativeWindows[0].commands.map(record => record.command)) !==
      JSON.stringify(suffix.map(record => record.command)) ||
      changed.commandIndex + 1 + alternativeWindows[0].commands.length > 24) {
      throw new Error(`Изменился прочий пакет/бюджет24: ${row.input.id}/${mode}`);
    }
    const repeated = baseline.runBaseline(row.input, { state: saves.decodeConquestSave(saves.encodeConquestSave(state)),
      turnsExecuted: state.session.turn - 1 });
    if (alternative.status === 'executor-error' || JSON.stringify(alternative) !== JSON.stringify(repeated)) {
      throw new Error(`Контрфакт не повторяется/отказ executor: ${row.input.id}`);
    }
    const targetId = changed.alternative.destinationId;
    const events = alternativeWindows.filter(window => window.ownershipChanges.length ||
      window.battles.some(battle => battle.systemId === targetId)).map(window => ({
      turn: window.turn, ownershipChanges: window.ownershipChanges, battles: window.battles,
      owners: window.position.worlds.map(world => ({ id: world.id, ownerId: world.ownerId }))
    }));
    const result = { turn: beforeWindow + 1, ...changed,
      remainingPacketCommands: 'identical-to-original-and-normal-planner', accepted: true,
      firstTargetCapture: alternativeWindows.find(window => window.ownershipChanges.some(change =>
        change.systemId === targetId && change.to === side))?.turn ?? null,
      status: alternative.status, turnsExecuted: alternative.turnsExecuted, outcome: alternative.outcome,
      repeatAndRoundTrip: 'passed', events,
      finalStateSha256: createHash('sha256').update(saves.encodeConquestSave(alternative.finalState)).digest('hex') };
    facts.counterfactuals.push(result);
    console.error(`${row.input.id}/${mode}: one-command -> ${alternative.status}/${alternative.turnsExecuted}, target=${targetId}, capture=${result.firstTargetCapture}`);
    }
    evidence.push(facts);
  }
  await output.writeFile(JSON.stringify({
    format: 'orion-conquest-timeout-experiments', schemaVersion: 1, sourceSha256: manifest.base.sourceSha256, cases: evidence
  }, null, 2) + '\n');
} finally {
  await server.close();
}
} finally {
  await output.close();
}
