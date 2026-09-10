import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import * as domain from '../src/domain/campaignSession';
import { getGalaxyDefinition } from '../src/domain/campaign';
import * as catalog from '../src/utils/ProductionCatalog';
import { createDesign, createComponent, installComponent } from '../src/domain/shipDesign';
import { getProductionQuote } from '../src/domain/production';
import { createCombatDesign } from '../src/domain/combatPresets';
import { ShipDesignManager, type StoragePort } from '../src/utils/ShipDesignManager';
import { CampaignSaveManager } from '../src/utils/CampaignSaveManager';
import { encodeCampaignSave, MAX_CAMPAIGN_SAVE_BYTES } from '../src/domain/campaignSave';
import * as aiExecutor from '../src/domain/campaignAiExecutor';
import * as aiPlanner from '../src/domain/campaignAiPlanner';
import * as runDomain from '../src/domain/campaignRun';
import { encodeCampaignRunSave, decodeCampaignRunSave } from '../src/domain/campaignRunSave';
import { CampaignRunSaveManager } from '../src/utils/CampaignRunSaveManager';
import { known, rich, threeCommands } from './fixtures/campaignAi';

vi.mock('phaser', () => ({ default: { Scene: class {}, Scenes: { Events: { SHUTDOWN: 'shutdown' } } } }));
const { MainScene } = await import('../src/scenes/MainScene');

/** Observe the real run boundary using the former session-shaped assertions, not a fake executor.
 * This keeps all historical input/result identity, command and receipt assertions meaningful. */
function observeRunCommands() {
  const execute = runDomain.executeRunCommand;
  const observer = vi.fn<(state: unknown, command: unknown) => domain.SessionResult | runDomain.RunFailure>();
  vi.spyOn(runDomain, 'executeRunCommand').mockImplementation((input, command) => {
    const result = execute(input, command);
    observer.mockImplementationOnce(() => result.ok
      ? { ok: true, state: result.run.session, ...(result.endTurnEconomy ? { endTurnEconomy: result.endTurnEconomy } : {}) }
      : result);
    observer((input as runDomain.CampaignRun).session, command);
    return result;
  });
  return observer;
}
function seedSession(state: domain.CampaignSession) {
  // Explicit diagnostic creator fault/fixture; ordinary paid cycles never call this.
  vi.spyOn(runDomain, 'createCampaignRun').mockReturnValueOnce({ ok: true, run: { session: state, control: { mode: 'local' } } });
}
function rawRun(state: domain.CampaignSession) {
  const result = encodeCampaignRunSave({ session: state, control: { mode: 'local' } });
  if (!result.ok) throw Error(result.message);
  return result.json;
}

/** Rendering/input contract harness; no actual Phaser hit testing. */
class Node extends EventEmitter {
  name = ''; text = ''; destroyed = false; interactive = false; list: Node[] = [];
  constructor(text = '') { super(); this.text = text; }
  // Synthetic fixed glyph width exercises truncation; browser checks real fonts.
  get width() { return this.text.length * 12; }
  setText(value: string) { this.text = value; return this; }
  add(node: Node) { this.list.push(node); return this; }
  destroy() { this.destroyed = true; this.list.forEach(node => node.destroy()); this.removeAllListeners(); }
  setName(value: string) { this.name = value; return this; }
  setPadding() { return this; }
  setBackgroundColor() { return this; }
  setInteractive() { this.interactive = true; return this; }
  setLineSpacing() { return this; }
  setWordWrapWidth() { return this; }
  fillStyle() { return this; }
  fillRoundedRect() { return this; }
  lineStyle() { return this; }
  strokeRoundedRect() { return this; }
  lineBetween() { return this; }
  strokeCircle() { return this; }
  fillCircle() { return this; }
}

function fixture() {
  const nodes: Node[] = [];
  const make = (text = '') => { const node = new Node(text); nodes.push(node); return node; };
  const keyboard = new EventEmitter(), events = new EventEmitter();
  const scene = new MainScene();
  const owner = scene as unknown as { run?: runDomain.CampaignRun };
  // Historical diagnostic access redirects to the sole run; there is no duplicate session.
  Object.defineProperty(scene, 'campaign', { configurable: true,
    get: () => owner.run?.session,
    set: (session: domain.CampaignSession) => { owner.run = { session, control: owner.run?.control ?? { mode: 'local' } }; } });
  const tasks: { callback: () => void; removed: boolean; remove: ReturnType<typeof vi.fn> }[] = [];
  const isActive = vi.fn(() => true);
  const delayedCall = vi.fn((_delay: number, callback: () => void) => {
    const task = { callback, removed: false, remove: vi.fn() };
    task.remove.mockImplementation(() => { task.removed = true; }); tasks.push(task); return task;
  });
  const start = vi.fn(() => events.emit('shutdown'));
  Object.assign(scene, {
    cameras: { main: { setBackgroundColor: vi.fn() } }, input: { keyboard }, events,
    scene: { start, isActive }, time: { delayedCall }, add: { container: () => make(), graphics: () => make(),
      text: (_x: number, _y: number, value: string) => make(value) }
  });
  scene.create();
  const find = (name: string) => {
    const node = nodes.find(item => item.name === name && !item.destroyed);
    if (!node) throw new Error(`Missing ${name}`);
    return node;
  };
  return { scene, nodes, keyboard, events, start, find, tasks, delayedCall, isActive,
    click: (name: string) => find(name).emit('pointerdown'),
    details: () => find('campaign-system-details').text,
    message: () => find('campaign-message').text };
}

describe('S3.34 bounded run scene integration', () => {
  type Runtime = {
    run: runDomain.CampaignRun; aiPhase: string; aiSummary?: aiExecutor.AiTurnSummary;
    factionId: 'blue' | 'red'; selectedId: string; generation: number; pending?: string;
    ticket?: { consumed: boolean; request: aiPlanner.AiTurnRequest };
    operation?: unknown; executing: boolean;
    render(): void; resetCampaign(): void; execute(command: domain.SessionCommand): void;
    requestOperation(action: string, request?: aiPlanner.AiTurnRequest): void;
    confirmOperation(operation?: unknown): void;
  };
  const runtime = (f: ReturnType<typeof fixture>) => f.scene as unknown as Runtime;
  const capture = (f: ReturnType<typeof fixture>, name: string) => f.find(name).listeners('pointerdown')[0] as () => void;
  const visible = (f: ReturnType<typeof fixture>) => f.nodes.filter(n => !n.destroyed).map(n => n.text).join('\n');
  const absent = (f: ReturnType<typeof fixture>, name: string) => expect(f.nodes.some(n => !n.destroyed && n.name === name)).toBe(false);
  function aiStart() {
    const f = fixture(); f.click('campaign-new');
    expect(f.find('campaign-mode-local').text).toContain('✓');
    f.click('campaign-mode-ai'); f.click('campaign-confirm');
    expect(runtime(f).run.control).toEqual({ mode: 'human-vs-ai', aiPolicy: 'expansion-v1' });
    expect(runtime(f).aiPhase).toBe('idle'); expect(f.tasks).toHaveLength(0);
    return f;
  }
  function redScheduled() {
    const f = aiStart(); f.click('campaign-end-turn');
    expect(runtime(f).run.session.turn).toBe(2); expect(runtime(f).aiPhase).toBe('scheduled');
    expect(f.tasks).toHaveLength(1); return f;
  }
  function slot() {
    const contents = new Map<string, string>([['unrelated', 'keep']]);
    const storage = { getItem: vi.fn((key: string) => contents.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { contents.set(key, value); }) } satisfies StoragePort;
    vi.stubGlobal('localStorage', storage); return { storage, contents };
  }
  function load(f: ReturnType<typeof fixture>, run: runDomain.CampaignRun, contents: Map<string, string>) {
    const encoded = encodeCampaignRunSave(run); if (!encoded.ok) throw Error(encoded.message);
    contents.set(CampaignRunSaveManager.STORAGE_KEY, encoded.json);
    f.click('campaign-load'); f.click('campaign-confirm');
    expect(runtime(f).run).toEqual(run); expect(f.delayedCall).not.toHaveBeenCalled();
  }

  it('ordinary entry/reset is local without IO; mode defaults local every time and cancellation preserves AI run', () => {
    const { storage } = slot();
    try {
      const f = aiStart(), r = runtime(f), source = r.run;
      f.click('campaign-new'); expect(f.find('campaign-mode-local').text).toContain('✓');
      const mode = capture(f, 'campaign-mode-ai'); f.click('campaign-cancel'); mode();
      expect(r.run).toBe(source); expect(r.pending).toBeUndefined();
      f.click('campaign-new'); f.click('campaign-confirm'); expect(r.run.control).toEqual({ mode: 'local' });
      absent(f, 'campaign-ai-status'); expect(f.find('campaign-ai').interactive).toBe(true);
      f.events.emit('shutdown'); f.scene.create(); expect(r.run.control).toEqual({ mode: 'local' });
      expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
      expect(f.delayedCall).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('real blue1→red2→blue3→red4→blue5 is one deferred call/commit per blue end, with no red summary or next AI', async () => {
    const panels = await import('../src/ui/CampaignPanel'), Original = panels.CampaignPanel;
    const rendered = vi.spyOn(panels, 'CampaignPanel').mockImplementation(function (...args) { return new Original(...args); });
    const { storage } = slot();
    try {
      const f = aiStart(), r = runtime(f);
      const executor = vi.spyOn(runDomain, 'executeRunAiTurn'), planner = vi.spyOn(aiPlanner, 'planAiTurn');
      const dispatch = vi.spyOn(domain, 'executeSessionCommand');
      const views = vi.spyOn(domain, 'getCampaignSessionView');
      const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
      for (const expectedTurn of [2, 4]) {
        if (expectedTurn === 4) { f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize'); }
        f.click('campaign-end-turn');
        expect(r.run.session.turn).toBe(expectedTurn);
        expect(r.run.session.treasuries.blue).toEqual({ credits: expectedTurn === 2 ? 110 : 130, minerals: expectedTurn === 2 ? 55 : 65 });
        const source = r.run, before = structuredClone(source), calls = executor.mock.calls.length;
        const task = f.tasks.at(-1)!;
        for (let frame = 0; frame < 4; frame++) r.render();
        f.click('campaign-budget'); f.click('campaign-budget'); f.click('system-sol');
        expect(executor).toHaveBeenCalledTimes(calls); expect(f.tasks).toHaveLength(expectedTurn / 2);
        let current = r.run, commits = 0;
        Object.defineProperty(r, 'run', { configurable: true, get: () => current, set: value => { current = value; commits++; } });
        const commandCount = dispatch.mock.calls.length; task.callback(); task.callback();
        expect(commits).toBe(1); expect(task.remove).toHaveBeenCalledWith(false);
        expect(executor).toHaveBeenCalledTimes(calls + 1); expect(planner).toHaveBeenCalledTimes(calls + 1);
        expect(executor.mock.calls[calls]).toEqual([before, { factionId: 'red', expectedTurn }]);
        expect(executor.mock.calls[calls][0]).toBe(source); expect(source).toEqual(before);
        expect(dispatch.mock.calls.slice(commandCount).map(([, command]) => (command as domain.SessionCommand).kind))
          .toEqual(expectedTurn === 2 ? ['explore', 'endTurn'] : ['colonize', 'explore', 'endTurn']);
        expect(r.run.session.turn).toBe(expectedTurn + 1); expect(r.aiPhase).toBe('idle'); expect(r.ticket).toBeUndefined();
        expect(r.factionId).toBe('blue'); expect(r.aiSummary).toBeUndefined(); absent(f, 'campaign-ai-summary');
        expect(f.message()).toBe('Компьютер завершил ход. Ваш ход.');
        expect(r.run.session.treasuries.red).toEqual({ credits: expectedTurn === 2 ? 110 : 130, minerals: expectedTurn === 2 ? 55 : 65 });
      }
      // The trusted executor needs red's own before/after observations; only its two calls per
      // transaction may request red. All panel projections below must still be blue-only.
      expect(views.mock.calls.filter(([, side]) => side === 'red').map(([state]) => state.turn)).toEqual([2, 3, 4, 5]);
      for (const [, view, state] of rendered.mock.calls.filter(([, , state]) => state.aiMode)) {
        expect(view.galaxy.factionId).toBe('blue'); expect(view).not.toHaveProperty('treasuries');
        expect(state.aiSummary).toBeUndefined();
      }
      expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
      expect(f.nodes.filter(n => !n.destroyed && n.name === 'campaign-panel')).toHaveLength(1);
      expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['button', 'escape'] as const)('%s pauses before panels unwind; cancelled Resume never executes and confirmed Resume is one-shot', how => {
    const f = redScheduled(), r = runtime(f), executor = vi.spyOn(runDomain, 'executeRunAiTurn');
    f.click('campaign-budget'); const source = r.run, first = f.tasks[0];
    if (how === 'button') f.click('campaign-pause'); else f.keyboard.emit('keydown-ESC');
    expect(first.removed).toBe(true); expect(r.aiPhase).toBe('paused'); expect(f.find('campaign-budget-panel')).toBeDefined();
    first.callback(); expect(executor).not.toHaveBeenCalled(); expect(r.run).toBe(source);
    f.click('campaign-resume'); const oldConfirm = capture(f, 'campaign-confirm'); f.keyboard.emit('keydown-ESC'); oldConfirm();
    expect(r.aiPhase).toBe('paused'); expect(f.tasks).toHaveLength(1);
    f.click('campaign-resume'); const confirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm'); confirm();
    expect(r.aiPhase).toBe('scheduled'); expect(f.tasks).toHaveLength(2); expect(executor).not.toHaveBeenCalled();
    first.callback(); expect(executor).not.toHaveBeenCalled(); f.tasks[1].callback(); f.tasks[1].callback();
    expect(executor).toHaveBeenCalledTimes(1); expect(r.run.session.turn).toBe(3);
  });

  it.each(['save', 'load', 'new', 'menu', 'takeover'] as const)('%s cancels the ticket BEFORE IO/pending; cancellation never silently resumes', action => {
    const { storage, contents } = slot();
    try {
      const f = redScheduled(), r = runtime(f), task = f.tasks[0], source = r.run;
      contents.set(CampaignRunSaveManager.STORAGE_KEY, rawRun(domain.createCampaignSession()));
      storage.getItem.mockImplementation(key => {
        expect(task.removed).toBe(true); expect(r.ticket).toBeUndefined(); expect(r.aiPhase).toBe('paused');
        expect(r.pending).toBe(action); task.callback(); return contents.get(key) ?? null;
      });
      const executor = vi.spyOn(runDomain, 'executeRunAiTurn');
      f.click(`campaign-${action}`); expect(task.removed).toBe(true); expect(r.aiPhase).toBe('paused');
      expect(r.pending).toBe(action); const old = capture(f, 'campaign-confirm');
      const buttons = f.nodes.filter(n => !n.destroyed && n.interactive).map(n => n.name);
      expect(buttons.sort()).toEqual((action === 'new' ? ['campaign-mode-local', 'campaign-mode-ai', 'campaign-cancel', 'campaign-confirm']
        : ['campaign-cancel', 'campaign-confirm']).sort());
      f.click('campaign-cancel'); old(); task.callback(); r.render();
      expect(r.run).toBe(source); expect(r.aiPhase).toBe('paused'); expect(executor).not.toHaveBeenCalled();
      expect(f.tasks).toHaveLength(1); expect(storage.setItem).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['save', 'load'] as const)('%s read failure remains paused; empty save writes full save2 and never auto-resumes', action => {
    const { storage, contents } = slot();
    try {
      const f = redScheduled(), r = runtime(f), source = r.run, task = f.tasks[0];
      storage.getItem.mockImplementationOnce(() => { expect(task.removed).toBe(true); throw Error('private'); });
      f.click(`campaign-${action}`); expect(r.pending).toBeUndefined(); expect(r.aiPhase).toBe('paused');
      expect(r.run).toBe(source); expect(f.message()).not.toContain('private');
      task.callback(); f.click('campaign-save');
      expect(r.run).toBe(source); expect(r.aiPhase).toBe('paused'); expect(storage.setItem).toHaveBeenCalledTimes(1);
      const json = contents.get(CampaignRunSaveManager.STORAGE_KEY)!;
      expect(Object.keys(JSON.parse(json)).sort()).toEqual(['format', 'schemaVersion', 'rulesVersion', 'session', 'control'].sort());
      expect(JSON.parse(json).schemaVersion).toBe(2); expect(decodeCampaignRunSave(json)).toEqual({ ok: true, run: source });
      expect(f.tasks).toHaveLength(1); expect(contents.get('unrelated')).toBe('keep');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['local-blue', 'local-red', 'ai-blue', 'ai-red', 'legacy-red'] as const)('load %s uses captured whole run/control without reread, resets UI and never schedules', variant => {
    const { storage, contents } = slot();
    try {
      const f = aiStart(), r = runtime(f);
      const run: runDomain.CampaignRun = { session: domain.createCampaignSession(), control: variant.startsWith('ai')
        ? { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } : { mode: 'local' } };
      run.session.turn = variant.endsWith('red') ? 2 : 1;
      const encoded = variant.startsWith('legacy') ? encodeCampaignSave(run.session) : encodeCampaignRunSave(run);
      if (!encoded.ok) throw Error(encoded.message);
      contents.set(CampaignRunSaveManager.STORAGE_KEY, encoded.json);
      f.click('campaign-production'); f.click('production-fleets');
      Object.assign(r, { fleetShipIds: [77, 88], fleetPage: 12, fleetMemberPage: 2, choiceIndex: 6, completedPage: 3 });
      f.click('campaign-load'); const operation = r.operation as { candidate: runDomain.CampaignRun };
      const reads = storage.getItem.mock.calls.length; contents.delete(CampaignRunSaveManager.STORAGE_KEY);
      f.click('campaign-confirm'); expect(r.run).toBe(operation.candidate); expect(r.run).toEqual(run);
      expect(storage.getItem).toHaveBeenCalledTimes(reads); expect(storage.setItem).not.toHaveBeenCalled();
      expect(r.factionId).toBe(variant.startsWith('ai') ? 'blue' : variant.endsWith('red') ? 'red' : 'blue');
      expect(r.aiPhase).toBe(variant === 'ai-red' ? 'paused' : 'idle'); expect(f.tasks).toHaveLength(0);
      expect(r).toMatchObject({ fleetShipIds: [], fleetPage: 0, fleetMemberPage: 0, choiceIndex: 0, completedPage: 0,
        productionOpen: false, budgetOpen: false, travelOpen: false, fleetsOpen: false, fleetTravelOpen: false, catalog: undefined });
      expect(r.aiSummary).toBeUndefined();
      if (variant.startsWith('legacy')) {
        contents.set(CampaignRunSaveManager.STORAGE_KEY, encoded.json);
        f.click('campaign-save'); expect(r.pending).toBe('save'); expect(storage.setItem).not.toHaveBeenCalled();
        f.click('campaign-confirm'); expect(JSON.parse(contents.get(CampaignRunSaveManager.STORAGE_KEY)!).schemaVersion).toBe(2);
        expect(r.run.control).toEqual({ mode: 'local' });
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('captures AI run before presence read and writes that snapshot even if nested live control/session change', () => {
    const { storage, contents } = slot();
    try {
      const f = redScheduled(), r = runtime(f), before = structuredClone(r.run);
      contents.set(CampaignRunSaveManager.STORAGE_KEY, 'occupied');
      f.click('campaign-save'); r.run.control = { mode: 'local' }; r.run.session.treasuries.red.credits = 234;
      f.click('campaign-confirm'); expect(decodeCampaignRunSave(contents.get(CampaignRunSaveManager.STORAGE_KEY)))
        .toEqual({ ok: true, run: before });
      expect(storage.getItem).toHaveBeenCalledTimes(1); expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(f.tasks).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['replace', 'turn', 'generation', 'mode', 'pending', 'inactive', 'reset', 'shutdown', 'reentry'] as const)
  ('pre-call %s invalidates a stale ticket, even if invoked despite removal', change => {
    const f = redScheduled(), r = runtime(f), task = f.tasks[0], execute = vi.spyOn(runDomain, 'executeRunAiTurn');
    if (change === 'replace') r.run = structuredClone(r.run);
    if (change === 'turn') r.run.session.turn = 4;
    if (change === 'generation') r.generation++;
    if (change === 'mode') r.run.control = { mode: 'local' };
    if (change === 'pending') r.pending = 'save';
    if (change === 'inactive') f.isActive.mockReturnValue(false);
    if (change === 'reset') r.resetCampaign();
    if (change === 'shutdown' || change === 'reentry') f.events.emit('shutdown');
    if (change === 'reentry') f.scene.create();
    const run = r.run; task.callback(); task.callback(); expect(execute).not.toHaveBeenCalled(); expect(r.run).toBe(run);
    expect(r.ticket).toBeUndefined(); expect(r.aiPhase).not.toBe('failed');
  });

  it.each(['replace', 'turn', 'generation', 'mode', 'pending', 'inactive', 'reset', 'shutdown', 'reentry'] as const)
  ('post-call %s discards a real result without committing/failing the replacement', change => {
    const f = redScheduled(), r = runtime(f), task = f.tasks[0], original = runDomain.executeRunAiTurn;
    let replacement: runDomain.CampaignRun;
    const executor = vi.spyOn(runDomain, 'executeRunAiTurn').mockImplementation((run, request) => {
      const result = original(run, request); expect(result.ok).toBe(true);
      if (change === 'replace') r.run = structuredClone(r.run);
      if (change === 'turn') r.run.session.turn = 4;
      if (change === 'generation') r.generation++;
      if (change === 'mode') r.run.control = { mode: 'local' };
      if (change === 'pending') r.pending = 'save';
      if (change === 'inactive') f.isActive.mockReturnValue(false);
      if (change === 'reset') r.resetCampaign();
      if (change === 'shutdown' || change === 'reentry') f.events.emit('shutdown');
      if (change === 'reentry') f.scene.create();
      replacement = r.run; return result;
    });
    task.callback(); task.callback(); expect(executor).toHaveBeenCalledTimes(1); expect(r.run).toBe(replacement!);
    expect(r.aiPhase).not.toBe('failed'); expect(r.aiSummary).toBeUndefined();
    expect(f.tasks).toHaveLength(1); expect(r.ticket).toBeUndefined();
    if (change === 'reset' || change === 'reentry') {
      expect(f.find('campaign-end-turn').interactive).toBe(true); expect(f.find('campaign-new').interactive).toBe(true);
      expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    }
  });

  it('consumes before synchronous AI; running blocks commands, repeat callbacks, Resume/IO/new/menu/takeover and ESC', () => {
    const { storage } = slot();
    try {
      const f = redScheduled(), r = runtime(f), task = f.tasks[0], original = runDomain.executeRunAiTurn;
      const execute = vi.spyOn(runDomain, 'executeRunAiTurn').mockImplementation((run, request) => {
        expect(r.aiPhase).toBe('running'); expect(r.ticket?.consumed).toBe(true); expect(task.removed).toBe(true);
        expect(f.nodes.filter(n => !n.destroyed && n.interactive)).toHaveLength(0);
        for (const action of ['resume', 'ai', 'save', 'load', 'new', 'menu', 'takeover']) r.requestOperation(action, { factionId: 'red', expectedTurn: 2 });
        r.execute({ kind: 'endTurn', factionId: 'red', expectedTurn: 2 }); task.callback(); f.keyboard.emit('keydown-ESC');
        expect(r.pending).toBeUndefined(); expect(r.run).toBe(run); expect(storage.getItem).not.toHaveBeenCalled();
        return original(run, request);
      });
      task.callback(); expect(execute).toHaveBeenCalledTimes(1); expect(r.aiPhase).toBe('idle');
      expect(r.run.session.turn).toBe(3); expect(storage.setItem).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['credits', 'minerals', 'late-credits', 'late-minerals', 'terminal', 'throw'] as const)
  ('%s failure is atomic, safe and never retries; accepted blue end remains accepted', fault => {
    const { contents } = slot();
    try {
      const f = aiStart(), r = runtime(f);
      if (fault === 'terminal') r.run.session.turn = domain.MAX_TURN - 1;
      if (fault.includes('credits') || fault.includes('minerals')) {
        const resource = fault.includes('credits') ? 'credits' : 'minerals';
        r.run.session.treasuries.red[resource] = domain.MAX_RESOURCE - (fault.startsWith('late') ? resource === 'credits' ? 10 : 5 : 0);
        if (fault.startsWith('late')) known(r.run.session, 'nexus', 'red', null);
      }
      r.render(); f.click('campaign-end-turn'); const source = r.run, before = structuredClone(source);
      const dispatch = vi.spyOn(domain, 'executeSessionCommand');
      const executor = vi.spyOn(runDomain, 'executeRunAiTurn');
      if (fault === 'throw') executor.mockImplementationOnce(() => { throw Error('red-target-and-finance-secret'); });
      f.tasks[0].callback(); f.tasks[0].callback(); r.render();
      expect(r.run).toBe(source); expect(source).toEqual(before); expect(r.aiPhase).toBe('failed');
      expect(executor).toHaveBeenCalledTimes(1); expect(dispatch.mock.calls.length).toBeLessThanOrEqual(3);
      expect(r.aiSummary).toBeUndefined(); expect(f.message()).toBe('Не удалось выполнить ход компьютера.');
      expect(visible(f)).not.toContain('red-target-and-finance-secret'); expect(f.tasks).toHaveLength(1);
      expect(source.session.treasuries.blue).toEqual({ credits: 110, minerals: 55 });
      f.click('campaign-save'); expect(r.aiPhase).toBe('failed');
      expect(decodeCampaignRunSave(contents.get(CampaignRunSaveManager.STORAGE_KEY))).toEqual({ ok: true, run: before });
      f.click('campaign-resume'); f.click('campaign-cancel'); expect(r.aiPhase).toBe('failed');
      expect(executor).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('blue end failure never schedules and explicit failed Resume is exactly one new attempt', () => {
    const f = aiStart(), r = runtime(f); r.run.session.treasuries.blue.credits = domain.MAX_RESOURCE;
    f.click('campaign-end-turn'); expect(f.tasks).toHaveLength(0); expect(r.run.session.turn).toBe(1);
    r.run.session.treasuries.blue.credits = 100; f.click('campaign-end-turn');
    const executor = vi.spyOn(runDomain, 'executeRunAiTurn').mockImplementationOnce(() => { throw Error('fault'); });
    f.tasks[0].callback(); expect(r.aiPhase).toBe('failed');
    f.click('campaign-resume'); f.click('campaign-confirm'); expect(executor).toHaveBeenCalledTimes(1);
    f.tasks[1].callback(); f.tasks[0].callback(); expect(executor).toHaveBeenCalledTimes(2);
    expect(r.run.session.turn).toBe(3); expect(r.aiPhase).toBe('idle'); expect(f.tasks).toHaveLength(2);
  });

  it.each(['scheduled', 'failed', 'idle'] as const)('confirmed takeover from %s changes only control, observes active and invalidates old task', phase => {
    const f = phase === 'idle' ? aiStart() : redScheduled(), r = runtime(f);
    if (phase === 'failed') {
      vi.spyOn(runDomain, 'executeRunAiTurn').mockImplementationOnce(() => { throw Error('fault'); }); f.tasks[0].callback();
    }
    const source = r.run, before = structuredClone(source.session);
    const commands = vi.spyOn(domain, 'executeSessionCommand'), takeover = vi.spyOn(runDomain, 'convertRunToLocal');
    f.click('campaign-takeover'); expect(takeover).not.toHaveBeenCalled(); f.click('campaign-confirm');
    expect(takeover).toHaveBeenCalledExactlyOnceWith(source); expect(r.run.session).toEqual(before);
    expect(r.run.control).toEqual({ mode: 'local' }); expect(r.factionId).toBe(phase === 'idle' ? 'blue' : 'red');
    expect(r.aiPhase).toBe('idle'); expect(r.aiSummary).toBeUndefined(); expect(commands).not.toHaveBeenCalled();
    f.tasks.forEach(task => task.callback()); expect(r.run.session).toEqual(before);
    expect(f.find('campaign-ai').interactive).toBe(true); expect(f.find('campaign-side-switch').interactive).toBe(true);
    f.click('campaign-end-turn'); expect(r.run.session.turn).toBe(before.turn + 1); expect(r.aiPhase).toBe('idle');
  });

  it('authorizes all eleven manual commands through run API; helper is absent and cannot be forced in AI mode', () => {
    const f = redScheduled(), r = runtime(f); f.click('campaign-pause');
    const source = r.run, low = vi.spyOn(domain, 'executeSessionCommand'), execute = vi.spyOn(runDomain, 'executeRunCommand');
    const payloads = [
      { kind: 'endTurn' }, { kind: 'explore', systemId: 'nexus' }, { kind: 'colonize', systemId: 'nexus' },
      { kind: 'enqueueProduction', systemId: 'vega', design: createCombatDesign('fighter') },
      { kind: 'cancelProduction', systemId: 'vega', orderId: 1 }, { kind: 'deployProduction', systemId: 'vega', orderId: 1 },
      { kind: 'sendShip', systemId: 'vega', shipId: 1, destinationId: 'nexus' },
      { kind: 'refuelShip', systemId: 'vega', shipId: 1 }, { kind: 'createFleet', systemId: 'vega', shipIds: [1, 2] },
      { kind: 'disbandFleet', systemId: 'vega', fleetId: 1 }, { kind: 'sendFleet', systemId: 'vega', fleetId: 1, destinationId: 'nexus' }
    ] as const;
    for (const payload of payloads) {
      r.execute({ ...payload, factionId: 'red', expectedTurn: 2 } as domain.SessionCommand);
      expect(execute.mock.results.at(-1)?.value).toMatchObject({ ok: false, code: 'FACTION_CONTROLLED_BY_AI' });
      expect(r.run).toBe(source);
    }
    expect(execute).toHaveBeenCalledTimes(11); expect(low).not.toHaveBeenCalled();
    r.requestOperation('ai', { factionId: 'red', expectedTurn: 2 }); expect(r.pending).toBeUndefined();
    absent(f, 'campaign-ai'); absent(f, 'campaign-side-switch');
    r.factionId = 'red'; r.render(); expect(r.factionId).toBe('blue');
  });

  it.each(['production', 'travel', 'fleets', 'fleetTravel'] as const)('%s stays blue-only/read-only on red turn, with navigation enabled and no hidden finances', panel => {
    const { contents } = slot();
    try {
      const f = fixture(), r = runtime(f), session = rich(2, 5);
      session.treasuries.red = { credits: 987654321, minerals: 876543210 };
      load(f, { session, control: { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } }, contents);
      f.click('campaign-production');
      if (panel === 'travel') f.click('production-travel');
      if (panel === 'fleets' || panel === 'fleetTravel') f.click('production-fleets');
      if (panel === 'fleetTravel') f.click('fleet-travel');
      const mutating = /^(campaign-(explore|colonize|end-turn)|production-(enqueue|deploy|cancel-\d+)|travel-(send|refuel)|fleet-(select|clear|create|disband)|fleet-travel-send)$/;
      const source = r.run, commands = vi.spyOn(runDomain, 'executeRunCommand');
      for (const node of f.nodes.filter(n => !n.destroyed && mutating.test(n.name))) {
        expect(node.interactive, node.name).toBe(false); node.emit('pointerdown');
      }
      expect(commands).not.toHaveBeenCalled(); expect(r.run).toBe(source);
      expect(visible(f)).not.toContain('987654321'); expect(visible(f)).not.toContain('876543210');
      expect(f.find('campaign-budget').interactive).toBe(true); f.click('campaign-budget');
      expect(f.find('budget-title').text).toContain('Синий союз'); expect(f.find('budget-context').text).toContain('Условный');
      expect(f.tasks).toHaveLength(0); expect(r.aiPhase).toBe('paused');
    } finally { vi.unstubAllGlobals(); }
  });

  it('diagnostic full ship cap/deficit advances paid FIFO/free/group arrivals with zero fuel and no leaked red receipt', () => {
    const { contents } = slot();
    try {
      const f = fixture(), r = runtime(f), session = rich(2);
      session.treasuries.red = { credits: 5, minerals: 5 };
      load(f, { session, control: { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } }, contents);
      const before = structuredClone(r.run), expected = runDomain.executeRunAiTurn(before, { factionId: 'red', expectedTurn: 2 });
      if (!expected.ok) throw Error(expected.message);
      expect(expected.summary.endTurnEconomy.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 });
      f.click('campaign-resume'); f.click('campaign-confirm'); f.tasks[0].callback();
      expect(r.run).toEqual(expected.run); expect(r.run.session.ships).toHaveLength(200);
      expect(r.run.session.ships.filter(s => s.factionId === 'red' && s.transit)).toHaveLength(0);
      expect(r.run.session.ships.filter(s => s.factionId === 'red').slice(0, 3).map(s => s.fuel)).toEqual([0, 0, 0]);
      expect(r.aiSummary).toBeUndefined(); absent(f, 'campaign-ai-summary'); expect(visible(f)).not.toContain('25/100');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['no-colonies', 'no-frontier', 'all-caps'] as const)('loaded diagnostic %s completes exactly one package and never seeks another turn', boundary => {
    const { contents } = slot();
    try {
      const f = fixture(), r = runtime(f), session = boundary === 'all-caps' ? rich(2) : domain.createCampaignSession();
      session.turn = 2;
      if (boundary === 'no-colonies') {
        session.galaxy.systems.forEach(system => { if (system.ownerId === 'red') system.ownerId = null; system.exploredBy = system.exploredBy.filter(side => side !== 'red'); });
      }
      if (boundary === 'no-frontier') {
        const galaxy = getGalaxyDefinition();
        session.galaxy.systems.forEach(system => {
          system.ownerId = galaxy.systems.find(definition => definition.id === system.id)!.habitable ? 'blue' : null;
          system.exploredBy = ['blue', 'red'];
        });
      }
      if (boundary === 'all-caps') {
        const design = session.ships[0].design;
        session.fleets.items = [];
        for (const [index, factionId] of (['blue', 'red'] as const).entries()) {
          const systemId = factionId === 'blue' ? 'sol' : 'vega';
          for (let n = 0; n < 95; n++) session.production.completed.push({ id: 300 + index * 100 + n, factionId, systemId, design: structuredClone(design) });
          for (let n = 0; n < 20; n++) session.fleets.items.push({ id: index * 20 + n + 1, factionId, systemId,
            shipIds: n === 0 ? [index * 100 + 2, index * 100 + 1] : [index * 100 + n * 2 + 2, index * 100 + n * 2 + 3] });
        }
        session.production.lastOrderId = 1_000_000_000; session.fleets.lastFleetId = 1_000_000_000;
        session.fleets.items.at(-1)!.id = 1_000_000_000;
        expect(session.production.orders.length + session.production.completed.length).toBe(200);
        expect(session.fleets.items).toHaveLength(40); expect(session.ships).toHaveLength(200);
      }
      load(f, { session, control: { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } }, contents);
      const expected = runDomain.executeRunAiTurn(r.run, { factionId: 'red', expectedTurn: 2 });
      if (!expected.ok) throw Error(expected.message);
      const executor = vi.spyOn(runDomain, 'executeRunAiTurn'), planner = vi.spyOn(aiPlanner, 'planAiTurn');
      f.click('campaign-resume'); f.click('campaign-confirm'); f.tasks[0].callback(); f.tasks[0].callback();
      expect(r.run).toEqual(expected.run); expect(r.run.session.turn).toBe(3); expect(r.aiPhase).toBe('idle');
      expect(executor).toHaveBeenCalledTimes(1); expect(planner).toHaveBeenCalledTimes(1); expect(f.tasks).toHaveLength(1);
      if (boundary !== 'all-caps') expect(expected.summary.commands.map(command => command.kind)).toEqual(['endTurn']);
      expect(r.aiSummary).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it('write failure after an accepted computer turn preserves both the accepted run and previous checkpoint bytes', () => {
    const { storage, contents } = slot();
    try {
      const f = redScheduled(), r = runtime(f);
      f.click('campaign-save'); const bytes = contents.get(CampaignRunSaveManager.STORAGE_KEY);
      expect(r.aiPhase).toBe('paused');
      f.click('campaign-resume'); f.click('campaign-confirm'); f.tasks[1].callback();
      const accepted = r.run, before = structuredClone(accepted), executor = vi.spyOn(runDomain, 'executeRunAiTurn');
      storage.setItem.mockImplementationOnce(() => { throw new DOMException('private quota', 'QuotaExceededError'); });
      f.click('campaign-save'); f.click('campaign-confirm');
      expect(r.run).toBe(accepted); expect(r.run).toEqual(before); expect(r.run.session.turn).toBe(3);
      expect(contents.get(CampaignRunSaveManager.STORAGE_KEY)).toBe(bytes); expect(contents.get('unrelated')).toBe('keep');
      expect(r.aiPhase).toBe('idle'); expect(f.message()).not.toContain('private quota');
      f.tasks.forEach(task => task.callback()); expect(executor).not.toHaveBeenCalled(); expect(f.tasks).toHaveLength(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('scheduler creation failure is neutral failed state without a ticket or hidden retry', () => {
    const f = aiStart(), r = runtime(f), executor = vi.spyOn(runDomain, 'executeRunAiTurn');
    f.delayedCall.mockImplementationOnce(() => { throw Error('private scheduler fault'); });
    f.click('campaign-end-turn'); expect(r.run.session.turn).toBe(2); expect(r.aiPhase).toBe('failed');
    expect(r.ticket).toBeUndefined(); expect(f.message()).toBe('Не удалось выполнить ход компьютера.');
    r.render(); f.click('campaign-budget'); expect(f.delayedCall).toHaveBeenCalledTimes(1); expect(executor).not.toHaveBeenCalled();
  });

  it('a request made while the scheduled panel is being built prevents an orphan deferred task', () => {
    const f = aiStart(), r = runtime(f);
    const render = r.render.bind(r);
    vi.spyOn(r, 'render').mockImplementation(() => {
      render();
      if (r.aiPhase === 'scheduled') r.requestOperation('new');
    });
    f.click('campaign-end-turn'); expect(r.pending).toBe('new'); expect(r.aiPhase).toBe('paused');
    expect(r.ticket).toBeUndefined(); expect(f.delayedCall).not.toHaveBeenCalled();
    f.click('campaign-cancel'); expect(r.aiPhase).toBe('paused'); expect(f.delayedCall).not.toHaveBeenCalled();
  });
});

describe('S3.29 confirmed manual AI turn', () => {
  type Runtime = {
    campaign: domain.CampaignSession; factionId: 'blue' | 'red'; selectedId: string;
    aiSummary?: aiExecutor.AiTurnSummary; pending?: string; generation: number;
    productionOpen: boolean; budgetOpen: boolean; catalog?: catalog.ProductionCatalog;
    choiceIndex: number; completedPage: number; shipsPage: number; showShips: boolean;
    travelOpen: boolean; destinationIndex: number; transitPage: number; fleetsOpen: boolean;
    fleetShipIds: number[]; fleetCandidatePage: number; fleetPage: number; fleetMemberPage: number;
    fleetTravelOpen: boolean; fleetDestinationIndex: number; fleetTransitPage: number;
    render(): void; resetCampaign(): void; execute(command: domain.SessionCommand): void;
  };
  const runtime = (f: ReturnType<typeof fixture>) => f.scene as unknown as Runtime;
  const capture = (f: ReturnType<typeof fixture>, name: string) => f.find(name).listeners('pointerdown')[0] as () => void;
  const ui = (r: Runtime) => ({ factionId: r.factionId, selectedId: r.selectedId,
    productionOpen: r.productionOpen, budgetOpen: r.budgetOpen, catalog: r.catalog,
    choiceIndex: r.choiceIndex, completedPage: r.completedPage, shipsPage: r.shipsPage, showShips: r.showShips,
    travelOpen: r.travelOpen, destinationIndex: r.destinationIndex, transitPage: r.transitPage,
    fleetsOpen: r.fleetsOpen, fleetShipIds: [...r.fleetShipIds], fleetCandidatePage: r.fleetCandidatePage,
    fleetPage: r.fleetPage, fleetMemberPage: r.fleetMemberPage, fleetTravelOpen: r.fleetTravelOpen,
    fleetDestinationIndex: r.fleetDestinationIndex, fleetTransitPage: r.fleetTransitPage });
  function open(f: ReturnType<typeof fixture>, panel: string) {
    if (panel === 'budget') f.click('campaign-budget');
    else if (panel !== 'map') {
      f.click('campaign-production');
      if (panel === 'travel') f.click('production-travel');
      if (panel === 'fleets' || panel === 'fleetTravel') f.click('production-fleets');
      if (panel === 'fleetTravel') f.click('fleet-travel');
    }
  }
  const summaryAbsent = (f: ReturnType<typeof fixture>) => {
    expect(runtime(f).aiSummary).toBeUndefined();
    expect(f.nodes.some(n => !n.destroyed && n.name === 'campaign-ai-summary')).toBe(false);
  };

  it('does no AI or IO on entry/render/reset/shutdown/reentry; inactive observation never silently swaps', () => {
    const executor = vi.spyOn(aiExecutor, 'executeAiTurn'), planner = vi.spyOn(aiPlanner, 'planAiTurn');
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    const library = vi.spyOn(catalog, 'loadProductionCatalog');
    vi.stubGlobal('localStorage', storage);
    try {
      const f = fixture(), r = runtime(f), state = r.campaign;
      r.render(); f.click('campaign-side-switch');
      expect(f.find('campaign-ai').interactive).toBe(false); f.click('campaign-ai');
      expect(r.campaign).toBe(state); expect(r.factionId).toBe('red'); expect(r.pending).toBeUndefined();
      f.click('campaign-new'); f.click('campaign-confirm');
      f.events.emit('shutdown'); f.scene.create();
      expect(executor).not.toHaveBeenCalled(); expect(planner).not.toHaveBeenCalled();
      expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
      expect(library).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['map', 'budget', 'production', 'travel', 'fleets', 'fleetTravel'])('pending blocks all %s background controls; cancel and ESC preserve UI without planning', panel => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage);
    try {
      const f = fixture(), r = runtime(f); r.campaign = rich(1, 5); r.render(); open(f, panel);
      if (panel === 'fleets') { f.click('fleet-select'); f.click('fleet-candidate-next'); f.click('fleet-select'); }
      const before = structuredClone(r.campaign), state = r.campaign, panels = ui(r), message = f.message();
      const executor = vi.spyOn(aiExecutor, 'executeAiTurn'), planner = vi.spyOn(aiPlanner, 'planAiTurn');
      const commands = vi.spyOn(domain, 'executeSessionCommand'), library = vi.spyOn(catalog, 'loadProductionCatalog');
      const reads = storage.getItem.mock.calls.length;
      for (const cancel of ['button', 'escape']) {
        const oldButtons = f.nodes.filter(n => !n.destroyed && n.interactive).map(n => n.listeners('pointerdown')[0] as () => void);
        f.click('campaign-ai'); const confirm = capture(f, 'campaign-confirm');
        expect(r.pending).toBe('ai'); expect(f.message()).toContain('Ход наблюдаемой стороны завершится');
        oldButtons.forEach(callback => callback());
        for (const node of f.nodes.filter(n => !n.destroyed && !['campaign-cancel', 'campaign-confirm'].includes(n.name))) {
          expect(node.interactive, node.name).toBe(false); node.emit('pointerdown');
        }
        r.execute({ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
        expect(ui(r)).toEqual(panels); expect(r.campaign).toBe(state); expect(r.campaign).toEqual(before);
        if (cancel === 'button') f.click('campaign-cancel'); else f.keyboard.emit('keydown-ESC');
        confirm(); f.click('campaign-ai'); confirm(); expect(r.pending).toBe('ai'); f.click('campaign-cancel');
        expect(ui(r)).toEqual(panels); expect(f.message()).toBe(message);
      }
      expect(executor).not.toHaveBeenCalled(); expect(planner).not.toHaveBeenCalled(); expect(commands).not.toHaveBeenCalled();
      expect(library).not.toHaveBeenCalled(); expect(storage.getItem).toHaveBeenCalledTimes(reads);
      expect(storage.setItem).not.toHaveBeenCalled(); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('runs the real four-request start, exactly one executor/planner and one scene replacement per confirmation', () => {
    const executor = vi.spyOn(aiExecutor, 'executeAiTurn'), planner = vi.spyOn(aiPlanner, 'planAiTurn');
    const commands = vi.spyOn(domain, 'executeSessionCommand');
    const storage = { getItem: vi.fn(() => { throw Error('no IO'); }), setItem: vi.fn(() => { throw Error('no IO'); }) };
    vi.stubGlobal('localStorage', storage);
    try {
      const f = fixture(), r = runtime(f), sceneExecute = vi.spyOn(r, 'execute');
      const owner = f.scene as unknown as { run: runDomain.CampaignRun };
      let owned = owner.run, writes = 0;
      Object.defineProperty(owner, 'run', { configurable: true, get: () => owned, set: value => { writes++; owned = value; } });
      let current = r.campaign;
      for (let turn = 1; turn <= 4; turn++) {
        const before = structuredClone(current), source = current, factionId = turn % 2 ? 'blue' : 'red';
        const calls = commands.mock.calls.length;
        f.click('campaign-ai'); expect(executor).toHaveBeenCalledTimes(turn - 1); expect(planner).toHaveBeenCalledTimes(turn - 1);
        expect(commands).toHaveBeenCalledTimes(calls); expect(writes).toBe(turn - 1);
        const confirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm'); confirm();
        current = r.campaign;
        expect(executor).toHaveBeenCalledTimes(turn); expect(planner).toHaveBeenCalledTimes(turn); expect(writes).toBe(turn);
        expect(executor.mock.calls[turn - 1]).toEqual([before, { factionId, expectedTurn: turn }]);
        expect(executor.mock.calls[turn - 1][0]).not.toBe(source); expect(source).toEqual(before);
        const result = executor.mock.results[turn - 1].value as aiExecutor.AiTurnResult;
        if (!result.ok) throw Error(result.message);
        expect(current).toEqual(result.state); expect(current).not.toBe(result.state);
        expect(r.aiSummary).toEqual(result.summary); expect(r.aiSummary).not.toBe(result.summary);
        expect(commands.mock.calls.slice(calls).map(([, c]) => c)).toEqual(result.summary.commands);
        expect(result.summary.commands.length).toBeLessThanOrEqual(3);
        expect(result.summary.commands.map(c => c.kind)).toEqual(turn < 3 ? ['explore', 'endTurn'] : ['colonize', 'explore', 'endTurn']);
        expect(current.turn).toBe(turn + 1); expect(r.factionId).toBe(factionId);
        expect(f.find('campaign-ai').interactive).toBe(false); f.click('campaign-ai');
        expect(executor).toHaveBeenCalledTimes(turn);
        expect(f.find('campaign-ai-summary').text).toContain(`ход ${turn}`);
        expect(f.find('campaign-ai-summary').text).not.toMatch(/exploredBy|treasuries|lastOrderId/);
        if (turn < 4) { f.click('campaign-side-switch'); summaryAbsent(f); }
      }
      expect(current.turn).toBe(5); expect(current.treasuries).toEqual({ blue: { credits: 130, minerals: 65 }, red: { credits: 130, minerals: 65 } });
      expect(sceneExecute).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['replace', 'reset', 'shutdown', 'reentry', 'load', 'redraw'] as const)('rejects late request/confirm after %s, including identical turn numbers', change => {
    const f = fixture(), r = runtime(f), executor = vi.spyOn(aiExecutor, 'executeAiTurn');
    const request = capture(f, 'campaign-ai'); f.click('campaign-ai'); const confirm = capture(f, 'campaign-confirm');
    const encoded = encodeCampaignSave(domain.createCampaignSession()); if (!encoded.ok) throw Error(encoded.message);
    const storage = { getItem: vi.fn(() => encoded.json), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage);
    try {
      if (change === 'replace') r.campaign = structuredClone(r.campaign);
      if (change === 'reset') r.resetCampaign();
      if (change === 'shutdown' || change === 'reentry') f.events.emit('shutdown');
      if (change === 'reentry') f.scene.create();
      if (change === 'redraw') r.render();
      if (change === 'load') { f.click('campaign-cancel'); f.click('campaign-load'); f.click('campaign-confirm'); }
      const state = r.campaign; request(); confirm();
      expect(r.campaign).toBe(state); expect(executor).not.toHaveBeenCalled();
      if (change === 'shutdown') { expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0); f.scene.create(); confirm(); }
      expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
      expect(f.nodes.filter(n => n.name === 'campaign-panel' && !n.destroyed)).toHaveLength(1);
      if (change === 'redraw') { expect(r.pending).toBe('ai'); f.click('campaign-confirm'); expect(executor).toHaveBeenCalledTimes(1); }
      else expect(r.pending).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects a request from an unredrawn panel after same-turn source replacement', () => {
    const f = fixture(), r = runtime(f), executor = vi.spyOn(aiExecutor, 'executeAiTurn');
    const request = capture(f, 'campaign-ai'); r.campaign = structuredClone(r.campaign); request();
    expect(r.pending).toBeUndefined(); expect(executor).not.toHaveBeenCalled();
  });

  it.each(['same-side turn', 'other-side turn'] as const)('passes captured request to the real executor after in-place %s becomes stale', change => {
    const f = fixture(), r = runtime(f), executor = vi.spyOn(runDomain, 'executeRunAiTurn');
    const low = vi.spyOn(aiExecutor, 'executeAiTurn');
    f.click('campaign-ai'); r.campaign.turn = change === 'same-side turn' ? 3 : 2;
    const state = r.campaign, before = structuredClone(state); f.click('campaign-confirm');
    expect(executor.mock.calls[0][1]).toEqual({ factionId: 'blue', expectedTurn: 1 });
    expect(executor.mock.results[0].value).toMatchObject({ ok: false, code: 'STALE_TURN' });
    expect(low).not.toHaveBeenCalled();
    expect(r.campaign).toBe(state); expect(state).toEqual(before); summaryAbsent(f);
  });

  it.each(['replace', 'reset', 'shutdown', 'reentry'] as const)('discards a real completed result if %s invalidates its operation before acceptance', change => {
    const execute = aiExecutor.executeAiTurn, f = fixture(), r = runtime(f);
    let replacement: domain.CampaignSession;
    const executor = vi.spyOn(aiExecutor, 'executeAiTurn').mockImplementation((state, request) => {
      const result = execute(state, request); expect(result.ok).toBe(true);
      // Lifecycle fault only; the planner/commands/result remain real.
      if (change === 'replace') r.campaign = structuredClone(r.campaign);
      if (change === 'reset') r.resetCampaign();
      if (change === 'shutdown' || change === 'reentry') f.events.emit('shutdown');
      if (change === 'reentry') f.scene.create();
      replacement = r.campaign;
      return result;
    });
    f.click('campaign-ai'); const confirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm'); confirm();
    expect(executor).toHaveBeenCalledTimes(1); expect(r.campaign).toBe(replacement!); summaryAbsent(f);
    if (r.campaign) expect(r.campaign.turn).toBe(1);
  });

  it.each(['blue', 'red'] as const)('shows %s initial forecast errors only after confirm with no dispatch and no UI replacement', faction => {
    for (const boundary of ['turn', 'credits', 'minerals'] as const) {
      const f = fixture(), r = runtime(f); r.factionId = faction;
      r.campaign.turn = boundary === 'turn' ? domain.MAX_TURN - (faction === 'blue' ? 1 : 0) : faction === 'blue' ? 1 : 2;
      if (boundary === 'turn' && faction === 'blue') {
        // MAX_TURN is red; blue at MAX_TURN-1 is allowed, so test its resource failure instead.
        r.campaign.treasuries.blue.credits = domain.MAX_RESOURCE;
      } else if (boundary !== 'turn') r.campaign.treasuries[faction][boundary] = domain.MAX_RESOURCE;
      r.render(); f.click('campaign-budget');
      const state = r.campaign, panels = ui(r), before = structuredClone(state);
      const executor = vi.spyOn(aiExecutor, 'executeAiTurn'), commands = vi.spyOn(domain, 'executeSessionCommand');
      executor.mockClear(); commands.mockClear();
      f.click('campaign-ai'); expect(executor).not.toHaveBeenCalled();
      f.click('campaign-confirm'); expect(executor).toHaveBeenCalledTimes(1); expect(commands).not.toHaveBeenCalled();
      expect(r.campaign).toBe(state); expect(state).toEqual(before); expect(ui(r)).toEqual(panels); summaryAbsent(f);
      expect(executor.mock.results[0].value).toMatchObject({ ok: false, code: boundary === 'turn' && faction === 'red' ? 'TURN_LIMIT' : 'RESOURCE_LIMIT' });
    }
  });

  it.each(['map', 'budget', 'production', 'travel', 'fleets', 'fleetTravel'])('success clears %s/subpanels/pages/drafts/catalog/old receipt and retains observation', panel => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    try {
      const f = fixture(), r = runtime(f); r.campaign = rich(1, 5); r.render(); open(f, panel);
      if (panel === 'fleets') { f.click('fleet-select'); f.click('fleet-candidate-next'); f.click('fleet-select'); }
      Object.assign(r, { choiceIndex: 2, destinationIndex: 1, fleetDestinationIndex: 1, showShips: true });
      f.click('campaign-ai'); f.click('campaign-confirm');
      expect(ui(r)).toEqual({ factionId: 'blue', selectedId: 'sol', productionOpen: false, budgetOpen: false, catalog: undefined,
        choiceIndex: 0, completedPage: 0, shipsPage: 0, showShips: false, travelOpen: false, destinationIndex: 0, transitPage: 0,
        fleetsOpen: false, fleetShipIds: [], fleetCandidatePage: 0, fleetPage: 0, fleetMemberPage: 0,
        fleetTravelOpen: false, fleetDestinationIndex: 0, fleetTransitPage: 0 });
      expect(f.nodes.filter(n => !n.destroyed && ['production-panel', 'campaign-budget-panel', 'fleet-panel', 'travel-panel'].includes(n.name))).toHaveLength(0);
      expect(f.message()).toContain('AI завершил один ход');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['side', 'select', 'production', 'manual', 'load', 'reset', 'shutdown'] as const)('clears summary on %s (budget keeps the actual receipt)', action => {
    const encoded = encodeCampaignSave(domain.createCampaignSession()); if (!encoded.ok) throw Error(encoded.message);
    vi.stubGlobal('localStorage', { getItem: () => encoded.json, setItem: vi.fn() });
    try {
      const f = fixture(); f.click('campaign-ai'); f.click('campaign-confirm');
      const summary = runtime(f).aiSummary; f.click('campaign-budget'); expect(runtime(f).aiSummary).toBe(summary);
      if (action === 'side') f.click('campaign-side-switch');
      if (action === 'select') { f.click('campaign-budget'); f.click('system-eden'); }
      if (action === 'production') f.click('campaign-production');
      if (action === 'manual') f.click('campaign-end-turn'); // Inactive failure must not leave an old AI report beside the error.
      if (action === 'load') { f.click('campaign-load'); f.click('campaign-confirm'); }
      if (action === 'reset') { f.click('campaign-new'); f.click('campaign-confirm'); }
      if (action === 'shutdown') f.events.emit('shutdown');
      summaryAbsent(f);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['blue', 'red'] as const)('renders actual %s deficit receipt, not subsequent forecast; FIFO and free/group arrivals continue', faction => {
    const f = fixture(), r = runtime(f); r.campaign = rich(faction === 'blue' ? 1 : 2); r.factionId = faction;
    r.campaign.treasuries[faction] = { credits: 5, minerals: 5 }; r.render();
    const enemy = faction === 'blue' ? 'red' : 'blue', enemyBefore = domain.getCampaignSessionView(r.campaign, enemy);
    const source = r.campaign, before = structuredClone(source);
    f.click('campaign-ai'); f.click('campaign-confirm');
    expect(source).toEqual(before); expect(r.campaign.ships).toHaveLength(200);
    expect(r.aiSummary?.endTurnEconomy).toMatchObject({ factionId: faction, income: { credits: 20, minerals: 10 },
      upkeep: { shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 }, treasuryAfter: { credits: 0, minerals: 15 } });
    expect(f.find('campaign-ai-summary').text).toContain('Оплата: 25/100 кр.');
    expect(f.find('campaign-ai-summary').text).toContain('Дефицит: 75 кр.');
    expect(r.campaign.ships.filter(s => s.factionId === faction && s.transit)).toHaveLength(0);
    expect(r.campaign.ships.filter(s => s.factionId === faction).slice(0, 3).map(s => s.fuel)).toEqual([0, 0, 0]);
    expect(r.campaign.fleets.items.find(g => g.factionId === faction)?.systemId).toBe(faction === 'blue' ? 'eden' : 'nexus');
    expect(r.campaign.production.orders.filter(o => o.factionId === faction).map(o => o.remainingTurns)).toEqual([4, 4]);
    const enemyAfter = domain.getCampaignSessionView(r.campaign, enemy);
    expect({ ...enemyAfter, turn: enemyBefore.turn, activeFactionId: enemyBefore.activeFactionId }).toEqual(enemyBefore);
    f.click('campaign-budget'); expect(f.find('budget-paid').text).toContain('20 кр.');
    expect(f.find('campaign-ai-summary').text).toContain('Оплата: 25/100 кр.');
  });

  it.each(['blue', 'red'] as const)('rolls back late %s colonization cap of either resource including all UI/drafts; no retry or partial summary', faction => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    try {
      for (const resource of ['credits', 'minerals'] as const) {
        const f = fixture(), r = runtime(f); r.campaign = rich(faction === 'blue' ? 1 : 2, 5); r.factionId = faction;
        // A known neutral frontier is colonizable, but its extra income exceeds the gross cap.
        const target = faction === 'blue' ? 'nexus' : 'eden';
        r.campaign.ships = r.campaign.ships.filter(s => s.factionId === faction);
        r.campaign.fleets.items = r.campaign.fleets.items.filter(g => g.factionId === faction);
        r.campaign.production.orders = r.campaign.production.orders.filter(o => o.factionId === faction);
        r.campaign.production.completed = r.campaign.production.completed.filter(o => o.factionId === faction);
        known(r.campaign, target, faction, null);
        r.campaign.treasuries[faction][resource] = domain.MAX_RESOURCE - (resource === 'credits' ? 20 : 10);
        r.selectedId = faction === 'blue' ? 'sol' : 'vega'; r.render(); open(f, 'fleets');
        f.click('fleet-select'); f.click('fleet-candidate-next'); f.click('fleet-select');
        const before = structuredClone(r.campaign), state = r.campaign, panels = ui(r);
        expect(domain.campaignSessionSchema.safeParse(state).success).toBe(true);
        expect(domain.getCampaignSessionView(state, faction).economyForecast.ok).toBe(true);
        const executor = vi.spyOn(aiExecutor, 'executeAiTurn'), commands = vi.spyOn(domain, 'executeSessionCommand');
        executor.mockClear(); commands.mockClear();
        f.click('campaign-ai'); const confirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm'); confirm();
        expect(executor).toHaveBeenCalledTimes(1); expect(commands).toHaveBeenCalledTimes(3);
        expect(commands.mock.calls.map(([, c]) => (c as domain.SessionCommand).kind)).toEqual(['colonize', 'explore', 'endTurn']);
        expect(executor.mock.results[0].value).toMatchObject({ ok: false, code: 'RESOURCE_LIMIT' });
        expect(r.campaign).toBe(state); expect(state).toEqual(before); expect(ui(r)).toEqual(panels); summaryAbsent(f);
        expect(f.message()).toBe('Операция превысит предел ресурсов');
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('shows three completed commands and exact capped own balances without exposing other-side fields', () => {
    const f = fixture(), r = runtime(f); r.campaign = threeCommands();
    r.campaign.treasuries.blue = { credits: domain.MAX_RESOURCE - 20, minerals: domain.MAX_RESOURCE - 10 }; r.render();
    f.click('campaign-ai'); f.click('campaign-confirm');
    const text = f.find('campaign-ai-summary').text;
    expect(text.split('\n')).toHaveLength(8);
    expect(text).toContain('Колонизация: eden\nРазведка: nexus\nЗавершение хода');
    expect(text).toContain('Остаток: 1000000000 кр. / 1000000000 мин.');
    expect(text).not.toContain('Красная лига');
  });
});

describe('S3.26 manual campaign slot UI', () => {
  const key = CampaignSaveManager.STORAGE_KEY;
  const raw = (state = domain.createCampaignSession()) => {
    const encoded = encodeCampaignSave(state);
    if (!encoded.ok) throw Error(encoded.message);
    return encoded.json;
  };
  const corrupt = [
    ['empty', ''], ['json', '{'], ['format', '{}'],
    ['schema', JSON.stringify({ format: 'orion-campaign', schemaVersion: 2, rulesVersion: 1, session: null })],
    ['rules', JSON.stringify({ format: 'orion-campaign', schemaVersion: 1, rulesVersion: 2, session: null })],
    ['state', JSON.stringify({ format: 'orion-campaign', schemaVersion: 1, rulesVersion: 1, session: null })],
    ['oversized', ' '.repeat(MAX_CAMPAIGN_SAVE_BYTES + 1)]
  ] as const;
  type Runtime = {
    campaign: domain.CampaignSession; factionId: 'blue' | 'red'; selectedId: string;
    pending?: string; operation?: { candidate: runDomain.CampaignRun }; generation: number;
    productionOpen: boolean; budgetOpen: boolean; catalog?: catalog.ProductionCatalog;
    choiceIndex: number; completedPage: number; shipsPage: number; showShips: boolean;
    travelOpen: boolean; destinationIndex: number; transitPage: number; fleetsOpen: boolean;
    fleetShipIds: number[]; fleetCandidatePage: number; fleetPage: number; fleetMemberPage: number;
    fleetTravelOpen: boolean; fleetDestinationIndex: number; fleetTransitPage: number;
    resetCampaign(): void;
  };
  const runtime = (f: ReturnType<typeof fixture>) => f.scene as unknown as Runtime;
  const capture = (f: ReturnType<typeof fixture>, name: string) => f.find(name).listeners('pointerdown')[0] as () => void;
  const ui = (f: ReturnType<typeof fixture>) => {
    const r = runtime(f);
    return { factionId: r.factionId, selectedId: r.selectedId, productionOpen: r.productionOpen,
      budgetOpen: r.budgetOpen, catalog: r.catalog, choiceIndex: r.choiceIndex, completedPage: r.completedPage,
      shipsPage: r.shipsPage, showShips: r.showShips, travelOpen: r.travelOpen, destinationIndex: r.destinationIndex,
      transitPage: r.transitPage, fleetsOpen: r.fleetsOpen, fleetShipIds: [...r.fleetShipIds],
      fleetCandidatePage: r.fleetCandidatePage, fleetPage: r.fleetPage, fleetMemberPage: r.fleetMemberPage,
      fleetTravelOpen: r.fleetTravelOpen, fleetDestinationIndex: r.fleetDestinationIndex, fleetTransitPage: r.fleetTransitPage };
  };
  function slot(initial?: string) {
    const contents = new Map([[ShipDesignManager.STORAGE_KEY, '{corrupt library'], ['unrelated', 'preserved']]);
    if (initial !== undefined) contents.set(key, initial);
    const storage = { getItem: vi.fn((k: string) => contents.get(k) ?? null),
      setItem: vi.fn((k: string, value: string) => { contents.set(k, value); }) } satisfies StoragePort;
    vi.stubGlobal('localStorage', storage);
    return { contents, storage };
  }
  function open(f: ReturnType<typeof fixture>, panel: string) {
    if (panel === 'budget') f.click('campaign-budget');
    else if (panel !== 'map') {
      f.click('campaign-production');
      if (panel === 'travel') f.click('production-travel');
      if (panel === 'fleets' || panel === 'fleetTravel') f.click('production-fleets');
      if (panel === 'fleetTravel') f.click('fleet-travel');
    }
  }

  it('does no IO on construction, create, reset, exit or reentry, even with a throwing global getter', () => {
    const getter = vi.fn(() => { throw Error('private storage details'); });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: getter });
    try {
      const f = fixture(); f.click('campaign-new'); f.click('campaign-confirm');
      f.click('campaign-menu'); f.click('campaign-confirm'); f.scene.create();
      expect(getter).not.toHaveBeenCalled();
      for (const action of ['save', 'load']) {
        const state = runtime(f).campaign;
        f.click(`campaign-${action}`);
        expect(f.message()).toBe('Не удалось прочитать сохранение кампании');
        expect(runtime(f).campaign).toBe(state); expect(runtime(f).pending).toBeUndefined();
      }
      expect(getter).toHaveBeenCalledTimes(2);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('saves both sides while observing inactive red, once, and never calls a game command or library method', () => {
    const { contents, storage } = slot();
    try {
      const f = fixture(), commands = vi.spyOn(domain, 'executeSessionCommand');
      const library = vi.spyOn(ShipDesignManager.prototype, 'load');
      f.click('campaign-side-switch'); const state = runtime(f).campaign, before = structuredClone(state);
      const old = capture(f, 'campaign-save'); f.click('campaign-save'); old();
      expect(commands).not.toHaveBeenCalled(); expect(library).not.toHaveBeenCalled();
      expect(storage.getItem.mock.calls).toEqual([[key]]); expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(contents.get(key)).toBe(rawRun(before)); expect(runtime(f).campaign).toBe(state);
      expect(state).toEqual(before); expect(runtime(f).factionId).toBe('red');
      expect(f.message()).toBe('Кампания сохранена.'); expect(runtime(f).pending).toBeUndefined();
      expect(contents.get(ShipDesignManager.STORAGE_KEY)).toBe('{corrupt library');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([['valid', raw()] as const, ...corrupt])('requires explicit overwrite of %s slot and fixes snapshot at request', (_name, existing) => {
    const { contents, storage } = slot(existing);
    try {
      const f = fixture(), state = runtime(f).campaign, before = structuredClone(state);
      f.click('campaign-save'); expect(runtime(f).pending).toBe('save');
      expect(f.message()).toContain('Заменить сохранение?'); expect(storage.setItem).not.toHaveBeenCalled();
      expect(contents.get(key)).toBe(existing);
      // Deliberate out-of-band mutation proves the write is a detached request snapshot.
      state.treasuries.red.credits = 123;
      contents.set(key, 'external writer while confirmation is open');
      const confirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm'); confirm();
      expect(storage.getItem.mock.calls).toEqual([[key]]); expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(contents.get(key)).toBe(rawRun(before)); expect(state.treasuries.red.credits).toBe(123);
      expect(runtime(f).campaign).toBe(state); expect(f.message()).toBe('Кампания сохранена.');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([['missing', undefined] as const, ...corrupt])('load %s fails before confirmation without replacing a party or its panels', (_name, existing) => {
    const { contents, storage } = slot(existing);
    try {
      const f = fixture(); open(f, 'fleetTravel');
      const state = runtime(f).campaign, before = structuredClone(state), panels = ui(f), keys = [...contents];
      f.click('campaign-load');
      expect(runtime(f).campaign).toBe(state); expect(state).toEqual(before); expect(ui(f)).toEqual(panels);
      expect(runtime(f).pending).toBeUndefined(); expect(f.message()).not.toContain('Загрузить кампанию?');
      expect(f.message().length).toBeGreaterThan(0);
      expect(storage.getItem.mock.calls[storage.getItem.mock.calls.length - 1]).toEqual([key]);
      expect(storage.setItem).not.toHaveBeenCalled(); expect([...contents]).toEqual(keys);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['save', 'load'])('aborts %s on read failure; retry reads again without cached presence', action => {
    const { contents, storage } = slot(raw());
    try {
      const f = fixture(); open(f, 'budget'); const state = runtime(f).campaign, panels = ui(f), keys = [...contents];
      storage.getItem.mockImplementationOnce(() => { throw new DOMException('secret', 'SecurityError'); });
      f.click(`campaign-${action}`);
      expect(f.message()).toBe('Не удалось прочитать сохранение кампании'); expect(runtime(f).pending).toBeUndefined();
      expect(runtime(f).campaign).toBe(state); expect(ui(f)).toEqual(panels); expect([...contents]).toEqual(keys);
      expect(storage.setItem).not.toHaveBeenCalled();
      f.click(`campaign-${action}`); expect(runtime(f).pending).toBe(action); expect(storage.getItem).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['map', 'budget', 'production', 'travel', 'fleets', 'fleetTravel'])('cancel/ESC preserve %s for both save and load; stale confirmation cannot confirm a newer operation', panel => {
    const { contents, storage } = slot(raw());
    try {
      const f = fixture(); open(f, panel);
      const state = runtime(f).campaign, panels = ui(f), keys = [...contents];
      for (const action of ['save', 'load']) {
        const message = f.message();
        f.click(`campaign-${action}`); const old = capture(f, 'campaign-confirm');
        f.click('campaign-cancel'); old();
        expect(f.message()).toBe(message); expect(runtime(f).campaign).toBe(state); expect(ui(f)).toEqual(panels);
        f.click(`campaign-${action}`); old(); expect(runtime(f).pending).toBe(action);
        const confirm = capture(f, 'campaign-confirm'); f.keyboard.emit('keydown-ESC'); confirm();
        expect(runtime(f).pending).toBeUndefined(); expect(ui(f)).toEqual(panels); expect(f.message()).toBe(message);
      }
      expect([...contents]).toEqual(keys); expect(storage.setItem).not.toHaveBeenCalled();
      expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['save', 'load'])('blocks every available background command/navigation/reset while %s is pending', action => {
    const { storage } = slot(raw());
    try {
      const f = fixture(), commands = vi.spyOn(domain, 'executeSessionCommand');
      for (const panel of ['map', 'budget', 'production', 'travel', 'fleets', 'fleetTravel']) {
        runtime(f).resetCampaign(); open(f, panel);
        const oldButtons = f.nodes.filter(node => !node.destroyed && node.interactive)
          .map(node => node.listeners('pointerdown')[0] as () => void);
        f.click(`campaign-${action}`); const state = runtime(f).campaign, panels = ui(f), reads = storage.getItem.mock.calls.length;
        oldButtons.forEach(callback => callback());
        for (const node of f.nodes.filter(node => !node.destroyed && !['campaign-cancel', 'campaign-confirm'].includes(node.name))) {
          expect(node.interactive, node.name).toBe(false); node.emit('pointerdown');
        }
        expect(runtime(f).campaign).toBe(state); expect(ui(f)).toEqual(panels); expect(runtime(f).pending).toBe(action);
        expect(storage.getItem).toHaveBeenCalledTimes(reads); expect(storage.setItem).not.toHaveBeenCalled();
        expect(commands).not.toHaveBeenCalled(); f.click('campaign-cancel');
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['save', 'load'])('invalidates %s confirmations after same-turn source replacement, reset, shutdown and reentry', action => {
    const { storage } = slot(raw());
    try {
      const f = fixture();
      for (const change of ['replace', 'reset', 'shutdown', 'reentry']) {
        f.click(`campaign-${action}`); const confirm = capture(f, 'campaign-confirm');
        if (change === 'replace') runtime(f).campaign = structuredClone(runtime(f).campaign);
        if (change === 'reset') runtime(f).resetCampaign();
        if (change === 'shutdown' || change === 'reentry') f.events.emit('shutdown');
        if (change === 'reentry') f.scene.create();
        const state = runtime(f).campaign; confirm();
        expect(runtime(f).campaign).toBe(state); expect(storage.setItem).not.toHaveBeenCalled();
        if (change === 'shutdown') {
          expect(f.nodes.every(node => node.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
          f.scene.create(); confirm();
        }
        expect(runtime(f).pending).toBeUndefined(); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
        expect(f.nodes.filter(node => !node.destroyed && node.name === 'campaign-panel')).toHaveLength(1);
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it('applies exactly the detached load candidate without rereading even if slot disappears; same-turn old commands stay inert', () => {
    const loaded = domain.createCampaignSession(); loaded.treasuries.red.credits = 42;
    const { contents, storage } = slot(raw(loaded));
    try {
      const f = fixture(), commands = vi.spyOn(domain, 'executeSessionCommand'), library = vi.spyOn(catalog, 'loadProductionCatalog');
      const oldEnd = capture(f, 'campaign-end-turn'), oldSave = capture(f, 'campaign-save');
      const state = runtime(f).campaign;
      f.click('campaign-load'); const candidate = runtime(f).operation!.candidate;
      expect(candidate).toEqual({ session: loaded, control: { mode: 'local' } }); expect(candidate.session).not.toBe(state);
      expect(runtime(f).campaign).toBe(state); contents.delete(key);
      const confirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm');
      expect(runtime(f).campaign).toBe(candidate.session); expect(runtime(f).campaign).toEqual(loaded);
      const generation = runtime(f).generation;
      confirm(); oldEnd(); oldSave();
      expect(runtime(f).generation).toBe(generation); expect(commands).not.toHaveBeenCalled(); expect(library).not.toHaveBeenCalled();
      expect(storage.getItem.mock.calls).toEqual([[key]]); expect(storage.setItem).not.toHaveBeenCalled();
      expect(f.message()).toBe('Кампания загружена.');
      f.click('campaign-end-turn'); expect(runtime(f).campaign.turn).toBe(2);
      expect(runtime(f).campaign.treasuries).toEqual({ blue: { credits: 110, minerals: 55 }, red: { credits: 42, minerals: 50 } });
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['blue', 'red'] as const)('selects first own %s in STATIC order, otherwise its home ID without grants', faction => {
    const { contents } = slot();
    try {
      const f = fixture();
      for (const own of [true, false]) {
        const loaded = domain.createCampaignSession(); loaded.turn = faction === 'blue' ? 3 : 2;
        for (const system of loaded.galaxy.systems) {
          system.ownerId = own && ['eden', 'nexus'].includes(system.id) ? faction : null;
          system.exploredBy = system.ownerId ? [faction] : [];
        }
        loaded.galaxy.systems.reverse(); contents.set(key, raw(loaded));
        f.click('campaign-load'); f.click('campaign-confirm');
        expect(runtime(f).campaign).toEqual(loaded); expect(runtime(f).factionId).toBe(faction);
        expect(runtime(f).selectedId).toBe(own ? 'eden' : faction === 'blue' ? 'sol' : 'vega');
        expect(f.details()).toContain(own ? 'Разведана' : 'Не разведана');
      }
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['quota', 'getter'] as const)('reports %s write failure, keeps old slot/state/draft and permits retry', fault => {
    const { contents, storage } = slot(raw());
    try {
      const f = fixture(); open(f, 'fleetTravel');
      const state = runtime(f).campaign, panels = ui(f), keys = [...contents]; f.click('campaign-save');
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      if (fault === 'quota') storage.setItem.mockImplementationOnce(() => { throw new DOMException('secret', 'QuotaExceededError'); });
      else Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw Error('secret'); } });
      try { f.click('campaign-confirm'); }
      finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); }
      expect(f.message()).toBe('Не удалось записать кампанию: хранилище недоступно или заполнено');
      expect(runtime(f).pending).toBeUndefined(); expect(runtime(f).campaign).toBe(state); expect(ui(f)).toEqual(panels);
      expect([...contents]).toEqual(keys);
      f.click('campaign-save'); f.click('campaign-confirm'); expect(f.message()).toBe('Кампания сохранена.');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['budget', 'production', 'travel', 'fleets', 'fleetTravel'])('successful load clears %s, all pages/drafts/catalog and previous receipt, without library IO', panel => {
    const { storage } = slot(raw());
    try {
      const f = fixture(); f.click('campaign-end-turn'); open(f, panel);
      // UI-only diagnostic fields, not persisted game state.
      Object.assign(runtime(f), { choiceIndex: 3, completedPage: 8, shipsPage: 9, showShips: true, destinationIndex: 4,
        transitPage: 6, fleetShipIds: [10, 11], fleetCandidatePage: 2, fleetPage: 3, fleetMemberPage: 2,
        fleetDestinationIndex: 5, fleetTransitPage: 3 });
      const oldButtons = f.nodes.filter(node => !node.destroyed && node.interactive)
        .map(node => node.listeners('pointerdown')[0] as () => void);
      const reads = storage.getItem.mock.calls.length;
      f.click('campaign-load'); f.click('campaign-confirm'); oldButtons.forEach(callback => callback());
      expect(ui(f)).toEqual({ factionId: 'blue', selectedId: 'sol', productionOpen: false, budgetOpen: false,
        catalog: undefined, choiceIndex: 0, completedPage: 0, shipsPage: 0, showShips: false, travelOpen: false,
        destinationIndex: 0, transitPage: 0, fleetsOpen: false, fleetShipIds: [], fleetCandidatePage: 0,
        fleetPage: 0, fleetMemberPage: 0, fleetTravelOpen: false, fleetDestinationIndex: 0, fleetTransitPage: 0 });
      expect(storage.getItem).toHaveBeenCalledTimes(reads + 1); expect(f.message()).toBe('Кампания загружена.');
      expect(f.nodes.filter(node => !node.destroyed && ['production-panel', 'campaign-budget-panel', 'fleet-panel', 'travel-panel'].includes(node.name))).toHaveLength(0);
      f.click('campaign-production'); expect(storage.getItem.mock.calls.slice(reads + 1).length).toBeGreaterThan(0);
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('preserves real valid fleet draft through cancelled load and failed save', () => {
    const { storage } = slot(raw());
    try {
      const f = fixture(), state = runtime(f).campaign;
      // Diagnostic domain-valid ships solely to exercise UI selection persistence.
      state.production.lastOrderId = 3;
      state.ships = [1, 2, 3].map(id => ({ id, factionId: 'blue', systemId: 'sol', fuel: 3, design: createCombatDesign('fighter') }));
      open(f, 'fleets'); f.click('fleet-select'); f.click('fleet-candidate-next'); f.click('fleet-select');
      const panels = ui(f), before = structuredClone(state);
      f.click('campaign-load'); f.click('campaign-cancel'); expect(ui(f)).toEqual(panels);
      storage.setItem.mockImplementationOnce(() => { throw Error('quota'); });
      f.click('campaign-save'); f.click('campaign-confirm');
      expect(ui(f)).toEqual(panels); expect(runtime(f).campaign).toBe(state); expect(state).toEqual(before);
      expect(f.find('fleet-selection-count').text).toContain('2/10');
      f.click('fleet-create'); expect(runtime(f).campaign.fleets.items[0].shipIds).toEqual([1, 2]);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['turn', 'credits', 'minerals', 'deficit'] as const)('load preserves %s boundary and recalculates forecast, never heals state', boundary => {
    const loaded = domain.createCampaignSession();
    if (boundary === 'turn') loaded.turn = domain.MAX_TURN;
    else if (boundary === 'deficit') {
      loaded.treasuries.blue.credits = 0; loaded.production.lastOrderId = 12;
      loaded.ships = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol', fuel: 0, design: createCombatDesign('fighter') }));
    } else loaded.treasuries.blue[boundary] = domain.MAX_RESOURCE;
    const { storage } = slot(raw(loaded));
    try {
      const f = fixture(); f.click('campaign-load'); f.click('campaign-confirm');
      expect(runtime(f).campaign).toEqual(loaded); f.click('campaign-budget');
      const faction = runtime(f).factionId, forecast = domain.getCampaignSessionView(loaded, faction).economyForecast;
      if (boundary === 'deficit') {
        expect(forecast).toMatchObject({ ok: true, upkeep: { paidCredits: 10, shortfallCredits: 2 } });
        expect(f.find('budget-shortfall').text).toContain('2 кр.');
      } else expect(f.find('budget-error').text).toContain(boundary === 'turn' ? 'ход' : 'ресурс');
      const expected = domain.executeSessionCommand(loaded, { kind: 'endTurn', factionId: faction, expectedTurn: loaded.turn });
      f.click('campaign-end-turn'); expect(runtime(f).campaign).toEqual(expected.ok ? expected.state : loaded);
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ['preset', 'manual'], ['library', 'manual'], ['preset', 'ai'], ['library', 'ai'],
    ['preset', 'diagnostic-red-ai'], ['library', 'diagnostic-red-ai']
  ] as const)('continues both paid %s FIFO and fleet routes across manual saves, shutdown/reentry/load with %s end turns', (source, mode) => {
    const { contents, storage } = slot();
    try {
      contents.delete(ShipDesignManager.STORAGE_KEY);
      const saved = createCombatDesign('fighter'); saved.name = 'Автономный оплаченный снимок';
      // The library updates updatedAt on save; the paid snapshots below come from its saved result.
      if (source === 'library') expect(new ShipDesignManager(storage).saveDesign(saved).id).toBe(saved.id);
      let libraryBefore = contents.get(ShipDesignManager.STORAGE_KEY);
      const f = fixture(), execute = domain.executeSessionCommand, spy = vi.spyOn(domain, 'executeSessionCommand');
      const owner = f.scene as unknown as { run: runDomain.CampaignRun; aiPhase: string };
      let uninterrupted = domain.createCampaignSession();
      const click = (name: string) => {
        const calls = spy.mock.calls.length; f.click(name);
        if (spy.mock.calls.length === calls) return;
        expect(spy.mock.calls.length).toBe(calls + 1);
        const expected = execute(uninterrupted, spy.mock.calls[calls][1]);
        expect(spy.mock.results[calls].value).toEqual(expected);
        expect(expected.ok).toBe(true); if (expected.ok) uninterrupted = expected.state;
        expect(runtime(f).campaign).toEqual(uninterrupted);
      };
      const executeAi = aiExecutor.executeAiTurn, aiSpy = vi.spyOn(aiExecutor, 'executeAiTurn');
      const end = () => {
        if (mode !== 'manual' && uninterrupted.turn >= 31) {
          const state = runtime(f).campaign, before = structuredClone(state);
          const calls = aiSpy.mock.calls.length, reads = storage.getItem.mock.calls.length, writes = storage.setItem.mock.calls.length;
          const computer = owner.run.control.mode === 'human-vs-ai';
          const expected = executeAi(uninterrupted, { factionId: computer ? 'red' : runtime(f).factionId, expectedTurn: uninterrupted.turn });
          if (!expected.ok) throw Error(expected.message);
          const commandCount = spy.mock.calls.length;
          f.click(computer ? 'campaign-resume' : 'campaign-ai'); expect(aiSpy).toHaveBeenCalledTimes(calls); expect(spy).toHaveBeenCalledTimes(commandCount);
          const oldConfirm = capture(f, 'campaign-confirm'); f.click('campaign-confirm'); oldConfirm();
          if (computer) {
            expect(owner.aiPhase).toBe('scheduled'); expect(aiSpy).toHaveBeenCalledTimes(calls);
            const task = f.tasks.at(-1)!; task.callback(); task.callback();
          }
          expect(aiSpy).toHaveBeenCalledTimes(calls + 1); expect(aiSpy.mock.results[calls].value).toEqual(expected);
          expect(runtime(f).campaign).toEqual(expected.state); expect(state).toEqual(before);
          expect(storage.getItem).toHaveBeenCalledTimes(reads); expect(storage.setItem).toHaveBeenCalledTimes(writes);
          expect(runtime(f).factionId).toBe(computer ? 'blue' : expected.summary.factionId);
          uninterrupted = expected.state;
          expect(owner.run).toEqual({ session: uninterrupted, control: computer
            ? { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } : { mode: 'local' } });
        } else click('campaign-end-turn');
        if (owner.run.control.mode === 'local') click('campaign-side-switch');
      };
      const checkpoint = () => {
        const snapshot = structuredClone(runtime(f).campaign), state = runtime(f).campaign;
        const computer = owner.run.control.mode === 'human-vs-ai';
        const oldEndNode = f.find('campaign-end-turn');
        expect(oldEndNode.interactive).toBe(!computer);
        const oldEnd = computer ? () => oldEndNode.emit('pointerdown') : capture(f, 'campaign-end-turn');
        const oldAi = capture(f, computer ? 'campaign-resume' : 'campaign-ai'), aiCalls = aiSpy.mock.calls.length;
        const runSnapshot = structuredClone(owner.run);
        click('campaign-save'); if (runtime(f).pending) click('campaign-confirm');
        expect(runtime(f).campaign).toBe(state);
        const decoded = decodeCampaignRunSave(contents.get(key));
        expect(decoded).toEqual({ ok: true, run: runSnapshot });
        const reads = storage.getItem.mock.calls.length;
        f.events.emit('shutdown'); f.scene.create();
        expect(storage.getItem).toHaveBeenCalledTimes(reads); expect(runtime(f).campaign).toEqual(domain.createCampaignSession());
        click('campaign-load'); click('campaign-confirm'); oldEnd(); oldAi();
        expect(aiSpy).toHaveBeenCalledTimes(aiCalls);
        expect(storage.getItem).toHaveBeenCalledTimes(reads + 1); expect(runtime(f).campaign).toEqual(snapshot);
        expect(owner.run).toEqual(runSnapshot); expect(owner.aiPhase).toBe(computer ? 'paused' : 'idle');
        expect(contents.get(ShipDesignManager.STORAGE_KEY)).toBe(libraryBefore);
        expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
      };
      for (const target of ['eden', 'nexus']) {
        click(`system-${target}`); click('campaign-explore'); click('campaign-colonize'); end();
      }
      for (let i = 0; i < 26; i++) end();
      expect(uninterrupted.turn).toBe(29);
      for (const home of ['sol', 'vega']) {
        click(`system-${home}`); click('campaign-production');
        if (source === 'library') for (let i = 0; i < 7; i++) click('production-next');
        click('production-enqueue'); click('production-enqueue'); click('campaign-production'); end();
      }
      const designs = uninterrupted.production.orders.map(order => structuredClone(order.design));
      expect(uninterrupted.production.orders.map(order => order.remainingTurns)).toEqual([3, 4, 3, 4]); checkpoint();
      if (mode === 'diagnostic-red-ai' && source === 'library') {
        saved.name = 'Изменён после оплаты'; new ShipDesignManager(storage).saveDesign(saved);
        contents.delete(ShipDesignManager.STORAGE_KEY); libraryBefore = undefined;
      }
      for (let i = 0; i < 14; i++) end();
      expect(uninterrupted.turn).toBe(45); expect(uninterrupted.production.completed.map(item => item.id)).toEqual([1, 3, 2, 4]);
      for (const home of ['sol', 'vega']) {
        click(`system-${home}`); click('campaign-production'); click('production-deploy'); click('production-deploy');
        click('production-fleets'); click('fleet-select'); click('fleet-candidate-next'); click('fleet-select'); click('fleet-create');
        click('fleet-travel'); click('fleet-travel-send');
        expect(runtime(f).campaign.ships.filter(ship => ship.transit)).toHaveLength(2);
        if (mode === 'diagnostic-red-ai' && home === 'vega') {
          // Diagnostic controller assignment AFTER actual local payment, FIFO, deployment and send.
          // There is intentionally no public local→AI conversion and expansion-v1 cannot buy/send.
          owner.run = { session: owner.run.session, control: { mode: 'human-vs-ai', aiPolicy: 'expansion-v1' } };
          owner.aiPhase = 'paused';
          (f.scene as unknown as { render(): void }).render();
        }
        checkpoint(); end();
      }
      expect(uninterrupted.turn).toBe(47);
      expect(uninterrupted.treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
      expect(uninterrupted.ships.map(ship => [ship.id, ship.systemId, ship.fuel, ship.transit])).toEqual([
        [1, 'eden', 2, undefined], [2, 'eden', 2, undefined], [3, 'nexus', 2, undefined], [4, 'nexus', 2, undefined]
      ]);
      expect(uninterrupted.ships.map(ship => ship.design)).toEqual(designs);
      expect(uninterrupted.fleets.items.map(fleet => fleet.shipIds)).toEqual([[1, 2], [3, 4]]);
      expect(contents.get(ShipDesignManager.STORAGE_KEY)).toBe(libraryBefore);
      expect(storage.setItem.mock.calls.filter(([k]) => k === key)).toHaveLength(3);
      expect(aiSpy).toHaveBeenCalledTimes(mode !== 'manual' ? 16 : 0);
    } finally { vi.unstubAllGlobals(); }
  });
});

/** Contract oracle: explicit fixture counts, colony income and arithmetic, never the upkeep calculator. */
function expectBudgetOracle(f: ReturnType<typeof fixture>, state: domain.CampaignSession,
  faction: 'blue' | 'red', shipCount: number, colonies: number) {
  const treasury = state.treasuries[faction], income = { credits: colonies * 10, minerals: colonies * 5 };
  const paid = Math.min(treasury.credits + income.credits, shipCount);
  const expected = { ok: true as const, income,
    upkeep: { shipCount, dueCredits: shipCount, paidCredits: paid, shortfallCredits: shipCount - paid },
    treasuryAfter: { credits: treasury.credits + income.credits - paid, minerals: treasury.minerals + income.minerals } };
  const view = domain.getCampaignSessionView(state, faction);
  expect(view.economyForecast).toEqual(expected); expect(view.income).toEqual(income);
  expect(view.ships).toHaveLength(shipCount); expect(view.ships.every(ship => ship.factionId === faction)).toBe(true);
  expect(view).not.toHaveProperty('treasuries'); expect(view).not.toHaveProperty('endTurnEconomy');
  expect(view.production.orders.every(order => order.factionId === faction)).toBe(true);
  expect(view.fleets.every(fleet => fleet.factionId === faction)).toBe(true);
  expect(f.find('budget-title').text).toBe(`БЮДЖЕТ · ${faction === 'blue' ? 'Синий союз' : 'Красная лига'}`);
  expect(f.find('budget-context').text).toBe((state.turn % 2 ? 'blue' : 'red') === faction
    ? 'Прогноз завершения текущего хода' : 'Условный прогноз своего хода · сейчас ход другой стороны');
  expect(f.find('budget-treasury').text).toBe(`Сейчас: ${treasury.credits} кр. / ${treasury.minerals} мин.`);
  expect(f.find('budget-income').text).toBe(`Валовой доход: +${income.credits} кр. / +${income.minerals} мин.`);
  expect(f.find('budget-ships').text).toBe(`Кораблей на содержании: ${shipCount}`);
  expect(f.find('budget-due').text).toBe(`Начислено: ${shipCount} кр.`);
  expect(f.find('budget-paid').text).toBe(`Будет списано: ${paid} кр.`);
  expect(f.find('budget-shortfall').text).toBe(`Дефицит: ${shipCount - paid} кр. (без долга)`);
  expect(f.find('budget-after').text).toBe(`Остаток после расчёта: ${expected.treasuryAfter.credits} кр. / ${expected.treasuryAfter.minerals} мин.`);
  expect(f.nodes.filter(node => !node.destroyed && node.name === 'campaign-budget-panel')).toHaveLength(1);
  expect(f.nodes.filter(node => !node.destroyed && ['production-panel', 'budget-error'].includes(node.name))).toHaveLength(0);
  return expected;
}

describe('campaign scene and projection renderer', () => {
  it.each(['preset', 'library'] as const)('accepts both factions through the full paid colony-to-colony cycle using %s', source => {
    // Real catalogue/repository/domain; only renderer/input and the storage port are substitutes.
    const saved = createCombatDesign('fighter'); saved.name = 'Приёмочный проект';
    const raw = JSON.stringify({ schemaVersion: 2, designs: [saved], components: [] });
    const storage = { getItem: vi.fn((key: string) => source === 'library' && key === ShipDesignManager.STORAGE_KEY ? raw : null), setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    try {
      const spy = observeRunCommands(), f = fixture();
      const current = (): domain.CampaignSession => {
        for (let i = spy.mock.results.length - 1; i >= 0; i--) {
          const result = spy.mock.results[i].value as domain.SessionResult;
          if (result.ok) return result.state;
        }
        throw Error('No successful session command');
      };
      const click = (name: string, failure?: domain.SessionErrorCode) => {
        const calls = spy.mock.calls.length;
        const before = calls ? structuredClone(current()) : undefined;
        f.click(name);
        if (spy.mock.calls.length === calls) { expect(failure).toBeUndefined(); return; }
        expect(spy.mock.calls.length).toBe(calls + 1);
        const result = spy.mock.results[calls].value as domain.SessionResult;
        if (before) expect(spy.mock.calls[calls][0]).toEqual(before);
        if (failure) {
          expect(result).toMatchObject({ ok: false, code: failure }); expect(current()).toEqual(before);
        } else {
          expect(result.ok).toBe(true); expect(domain.campaignSessionSchema.safeParse(current()).success).toBe(true);
        }
      };
      const end = () => { click('campaign-end-turn'); click('campaign-side-switch'); };
      const choose = () => { if (source === 'library') for (let i = 0; i < 7; i++) click('production-next'); };
      // Both colonies are founded by real commands, no preloaded money, ships, ownership or progress.
      for (const [home, target] of [['sol', 'eden'], ['vega', 'nexus']] as const) {
        click(`system-${target}`); click('campaign-explore'); click('campaign-colonize');
        expect(f.find('campaign-income').text).toContain('+20 кредитов · +10 минералов');
        click(`system-${home}`); click('campaign-production'); choose();
        expect(f.find('production-quote').text).toContain('185 кр. / 11 мин.');
        click('production-enqueue', 'INSUFFICIENT_RESOURCES');
        click('campaign-production'); end();
      }
      for (let i = 0; i < 8; i++) end();
      expect(current().turn).toBe(11);
      expect(current().treasuries).toEqual({ blue: { credits: 200, minerals: 100 }, red: { credits: 200, minerals: 100 } });
      const snapshots = [];
      for (const [faction, home, id] of [['blue', 'sol', 1], ['red', 'vega', 2]] as const) {
        click(`system-${home}`); click('campaign-production'); choose(); click('production-enqueue');
        expect(current().treasuries[faction]).toEqual({ credits: 15, minerals: 89 });
        const order = current().production.orders.find(item => item.id === id)!;
        expect(order).toMatchObject({ factionId: faction, systemId: home, remainingTurns: 4 });
        snapshots.push(structuredClone(order.design));
        if (source === 'library') expect(order.design).toEqual(saved);
        const paid = structuredClone(order.design);
        click('production-refresh'); expect(current().production.orders.find(item => item.id === id)!.design).toEqual(paid);
        click('campaign-production'); end();
      }
      // At each boundary only the ending faction's head advances; IDs and paid snapshots persist.
      for (let i = 0; i < 6; i++) {
        const faction = current().turn % 2 ? 'blue' : 'red';
        const enemy = faction === 'blue' ? 'red' : 'blue';
        const enemyBefore = domain.getCampaignSessionView(current(), enemy).production;
        end(); expect(domain.getCampaignSessionView(current(), enemy).production).toEqual(enemyBefore);
      }
      expect(current().turn).toBe(19); expect(current().production.orders).toEqual([]);
      expect(current().production.completed.map(item => item.id)).toEqual([1, 2]);
      for (const [faction, home, target, id] of [['blue', 'sol', 'eden', 1], ['red', 'vega', 'nexus', 2]] as const) {
        click(`system-${home}`); click('campaign-production');
        expect(f.find('production-completed').text).toContain(`#${id}`);
        const turn = current().turn, treasury = structuredClone(current().treasuries);
        click('production-deploy'); click('production-travel');
        expect(f.find('travel-ship').text).toContain(`#${id}`);
        const oldSend = f.find('travel-send').listeners('pointerdown')[0] as () => void;
        click('travel-send'); const count = spy.mock.calls.length; oldSend(); expect(spy).toHaveBeenCalledTimes(count);
        expect(current().turn).toBe(turn); expect(current().treasuries).toEqual(treasury);
        expect(current().ships.find(ship => ship.id === id)).toEqual({ id, factionId: faction, systemId: home,
          fuel: 2, design: snapshots[id - 1], transit: { destinationId: target, remainingTurns: 1 } });
        expect(f.find('travel-send').interactive).toBe(false);
        click('campaign-production'); click(`system-${target}`); click('campaign-production'); click('production-travel');
        expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
        click('campaign-end-turn');
        expect(f.find('travel-ship').text).toContain(`#${id}`); expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
        expect(current().ships.find(ship => ship.id === id)).toEqual({ id, factionId: faction, systemId: target, fuel: 2, design: snapshots[id - 1] });
        click('travel-send', 'NOT_ACTIVE_FACTION');
        click('campaign-production'); click('campaign-side-switch');
      }
      expect(current().turn).toBe(21); expect(current().production).toEqual({ lastOrderId: 2, orders: [], completed: [] });
      expect(current().treasuries).toEqual({ blue: { credits: 114, minerals: 139 }, red: { credits: 114, minerals: 139 } });
      for (const faction of ['blue', 'red'] as const) {
        const view = domain.getCampaignSessionView(current(), faction);
        expect(view.ships).toHaveLength(1); expect(view.ships[0].factionId).toBe(faction);
        expect(view.ships[0]).not.toHaveProperty('transit');
      }
      expect(storage.getItem).toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem(ShipDesignManager.STORAGE_KEY)).toBe(source === 'library' ? raw : null);
      click('campaign-new'); click('campaign-confirm'); click('campaign-production'); click('production-travel');
      expect(f.find('travel-count').text).toContain('0/100'); expect(f.find('campaign-turn').text).toContain('Ход 1');
      click('campaign-menu'); click('campaign-confirm');
      expect(f.nodes.every(node => node.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['preset', 'library'] as const)('accepts both factions through paid FIFO fleets, empty tanks, refuelling and return using %s', source => {
    // Only environment boundaries are replaced: no injected campaign state or catalog responses.
    const saved = createCombatDesign('fighter'); saved.name = 'Приёмочный групповой fighter';
    const raw = JSON.stringify({ schemaVersion: 2, designs: [saved], components: [] });
    const contents = new Map(source === 'library' ? [[ShipDesignManager.STORAGE_KEY, raw]] : []);
    const storage = {
      getItem: vi.fn((key: string) => contents.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { contents.set(key, value); })
    } satisfies StoragePort;
    const originalContents = [...contents];
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    vi.stubGlobal('localStorage', storage);
    const spy = observeRunCommands();
    const load = vi.spyOn(catalog, 'loadProductionCatalog');
    const repositoryLoad = vi.spyOn(ShipDesignManager.prototype, 'load');
    const f = fixture();
    try {
      // Read-only observation of the scene, also valid after reset (unlike the last command result).
      const current = () => (f.scene as unknown as { campaign: domain.CampaignSession }).campaign;
      expect(current()).toEqual(domain.createCampaignSession());
      const sides = [
        { faction: 'blue', home: 'sol', neighbor: 'eden', ids: [1, 2], fleetId: 1 },
        { faction: 'red', home: 'vega', neighbor: 'nexus', ids: [3, 4], fleetId: 2 }
      ] as const;
      const snapshots = new Map<number, domain.CampaignSession['ships'][number]['design']>();
      const oldCallbacks: (() => void)[] = [];
      const commandButtons: Record<string, domain.SessionCommand['kind']> = {
        'campaign-explore': 'explore', 'campaign-colonize': 'colonize', 'campaign-end-turn': 'endTurn',
        'production-enqueue': 'enqueueProduction', 'production-deploy': 'deployProduction',
        'fleet-create': 'createFleet', 'fleet-disband': 'disbandFleet',
        'fleet-travel-send': 'sendFleet', 'travel-refuel': 'refuelShip', 'travel-send': 'sendShip'
      };
      const click = (name: string, failure?: domain.SessionErrorCode) => {
        const before = structuredClone(current()), calls = spy.mock.calls.length;
        expect(f.find(name).interactive, name).toBe(true);
        f.click(name);
        const kind = commandButtons[name];
        expect(spy.mock.calls.length, name).toBe(calls + (kind ? 1 : 0));
        if (!kind) {
          if (name !== 'campaign-confirm') expect(current()).toEqual(before);
          return;
        }
        expect(spy.mock.calls[calls][0]).toEqual(before); // Commands must not mutate their input.
        const command = spy.mock.calls[calls][1] as domain.SessionCommand;
        expect(command).toMatchObject({ kind, expectedTurn: before.turn });
        const result = spy.mock.results[calls].value as domain.SessionResult;
        if (failure) {
          expect(result).toMatchObject({ ok: false, code: failure });
          expect(current()).toBe(spy.mock.calls[calls][0]);
          expect(current()).toEqual(before);
        } else {
          expect(result.ok).toBe(true);
          if (!result.ok) throw Error(result.message);
          expect(current()).toBe(result.state);
          expect(domain.campaignSessionSchema.safeParse(current()).success).toBe(true);
        }
        const enemy = command.factionId === 'blue' ? 'red' : 'blue';
        const enemyBefore = domain.getCampaignSessionView(before, enemy);
        expect(domain.getCampaignSessionView(current(), enemy)).toEqual(!failure && kind === 'endTurn'
          ? { ...enemyBefore, turn: before.turn + 1, activeFactionId: enemy } : enemyBefore);
        if (kind !== 'endTurn') expect(current().turn).toBe(before.turn);
        if (!['endTurn', 'enqueueProduction', 'refuelShip'].includes(kind)) expect(current().treasuries).toEqual(before.treasuries);
        for (const record of [...current().production.orders, ...current().production.completed, ...current().ships]) {
          if (snapshots.has(record.id)) expect(record.design).toEqual(snapshots.get(record.id));
        }
        expect(storage.setItem).not.toHaveBeenCalled();
      };
      const capture = (name: string) => {
        const callback = f.find(name).listeners('pointerdown')[0] as () => void;
        expect(callback).toBeTypeOf('function'); oldCallbacks.push(callback); return callback;
      };
      const inert = (callback: () => void) => {
        const before = structuredClone(current()), calls = spy.mock.calls.length;
        callback(); expect(spy).toHaveBeenCalledTimes(calls); expect(current()).toEqual(before);
      };
      const choose = () => {
        if (source === 'library') for (let i = 0; i < 7; i++) click('production-next');
        expect(f.find('production-quote').text).toContain('185 кр. / 11 мин.');
      };
      const end = () => {
        const before = structuredClone(current()), faction = before.turn % 2 ? 'blue' : 'red';
        // Budget opening resets production/routes. Restore the production shell after side switch;
        // the original side switch itself always cleared travel/fleet subpanels and their pages.
        const productionWasOpen = (f.scene as unknown as { productionOpen: boolean }).productionOpen;
        const readsBefore = load.mock.calls.length;
        const dueBySchedule = before.turn >= 45 ? 2 : 0;
        click('campaign-budget');
        const forecast = expectBudgetOracle(f, current(), faction, dueBySchedule, 2);
        const oldBudget = capture('campaign-budget');
        const old = capture('campaign-end-turn');
        click('campaign-end-turn'); inert(old); inert(oldBudget);
        expect(current().turn).toBe(before.turn + 1);
        const due = before.ships.filter(ship => ship.factionId === faction).length;
        expect(due).toBe(dueBySchedule); // Orders/completed are not ships, including the finishing FIFO head.
        const paid = Math.min(before.treasuries[faction].credits + 20, due);
        expect(current().treasuries[faction]).toEqual({
          credits: before.treasuries[faction].credits + 20 - paid, minerals: before.treasuries[faction].minerals + 10
        });
        const result = spy.mock.results[spy.mock.results.length - 1].value as domain.SessionResult;
        if (!result.ok) throw Error(result.message);
        expect(result.endTurnEconomy).toEqual({ factionId: faction, turn: before.turn,
          income: { credits: 20, minerals: 10 },
          upkeep: { shipCount: due, dueCredits: due, paidCredits: paid, shortfallCredits: due - paid },
          treasuryAfter: current().treasuries[faction] });
        const { ok: _ok, ...predicted } = forecast;
        expect(result.endTurnEconomy).toEqual({ ...predicted, factionId: faction, turn: before.turn });
        expectBudgetOracle(f, current(), faction, dueBySchedule, 2);
        const receipt = `Ход передан. Доход: +20 кр. / +10 мин. Содержание: ${paid}/${due} кр. Дефицит: 0 кр. (без долга).`;
        expect(f.message()).toBe(receipt);
        click('campaign-budget'); expect(f.message()).toBe(receipt);
        click('campaign-budget'); expect(f.message()).toBe(receipt);
        // Independent FIFO oracle: one head per own colony, no spillover into the second order.
        const heads = new Set<string>(), finished: number[] = [];
        const orders = before.production.orders.flatMap(order => {
          if (order.factionId !== faction || heads.has(order.systemId)) return [order];
          heads.add(order.systemId);
          if (order.remainingTurns > 1) return [{ ...order, remainingTurns: order.remainingTurns - 1 }];
          finished.push(order.id); return [];
        });
        expect(current().production).toEqual({ lastOrderId: before.production.lastOrderId, orders,
          completed: [...before.production.completed, ...before.production.orders.filter(order => finished.includes(order.id))
            .map(({ remainingTurns: _remaining, ...record }) => record)] });
        expect(current().ships).toEqual(before.ships.map(ship => {
          if (ship.factionId !== faction || !ship.transit) return ship;
          const { transit, ...stationary } = ship;
          return { ...stationary, systemId: transit.destinationId };
        }));
        expect(current().fleets).toEqual({ ...before.fleets, items: before.fleets.items.map(fleet => {
          const trip = before.ships.find(ship => ship.id === fleet.shipIds[0])?.transit;
          return fleet.factionId === faction && trip ? { ...fleet, systemId: trip.destinationId } : fleet;
        }) });
        click('campaign-end-turn', 'NOT_ACTIVE_FACTION'); // No second payment/arrival while observing the old side.
        expectBudgetOracle(f, current(), faction, dueBySchedule, 2);
        click('campaign-side-switch');
        const enemy = faction === 'blue' ? 'red' : 'blue';
        // The first blue income precedes red colonization; deployment also occurs one side at a time.
        expectBudgetOracle(f, current(), enemy, current().turn >= (enemy === 'blue' ? 46 : 47) ? 2 : 0,
          before.turn === 1 ? 1 : 2);
        click('campaign-budget');
        if (productionWasOpen) click('campaign-production');
        expect(load).toHaveBeenCalledTimes(readsBefore);
      };
      const budgetCheckpoint = (turn: number, count: number) => {
        expect(current().turn).toBe(turn);
        const before = structuredClone(current()), readsBefore = load.mock.calls.length;
        click('campaign-budget'); expectBudgetOracle(f, current(), 'blue', count, 2);
        click('campaign-side-switch'); expectBudgetOracle(f, current(), 'red', count, 2);
        click('campaign-side-switch'); click('campaign-budget');
        expect(current()).toEqual(before); expect(load).toHaveBeenCalledTimes(readsBefore);
      };
      const ownShips = (faction: 'blue' | 'red') => current().ships.filter(ship => ship.factionId === faction);
      const checkShips = (side: typeof sides[number], systemId: typeof side.home | typeof side.neighbor,
        fuel: readonly number[], destinationId?: typeof systemId) => {
        expect(ownShips(side.faction)).toEqual(side.ids.map((id, index) => ({ id, factionId: side.faction,
          systemId, fuel: fuel[index], design: snapshots.get(id),
          ...(destinationId ? { transit: { destinationId, remainingTurns: 1 } } : {}) })));
        expect(current().fleets.items.find(fleet => fleet.id === side.fleetId)).toEqual({
          id: side.fleetId, factionId: side.faction, systemId, shipIds: [...side.ids]
        });
        const view = domain.getCampaignSessionView(current(), side.faction);
        expect(view.ships).toEqual(ownShips(side.faction));
        expect(view.fleets).toEqual([current().fleets.items.find(fleet => fleet.id === side.fleetId)]);
        expect(view).not.toHaveProperty('treasuries'); expect(view.production).not.toHaveProperty('lastOrderId');
        expect(view).not.toHaveProperty('lastFleetId');
      };
      // Real exploration, colonization, rejection and fourteen own incomes fund two fighters each.
      for (const side of sides) {
        click(`system-${side.neighbor}`); click('campaign-explore'); click('campaign-colonize');
        expect(f.find('campaign-income').text).toContain('+20 кредитов · +10 минералов');
        click(`system-${side.home}`); click('campaign-production'); choose();
        click('production-enqueue', 'INSUFFICIENT_RESOURCES'); click('campaign-production'); end();
      }
      for (let i = 0; i < 26; i++) end();
      expect(current().turn).toBe(29);
      expect(current().treasuries).toEqual({ blue: { credits: 380, minerals: 190 }, red: { credits: 380, minerals: 190 } });
      budgetCheckpoint(29, 0);
      for (const side of sides) {
        click(`system-${side.home}`); click('campaign-production'); choose();
        for (const [index, id] of side.ids.entries()) {
          const old = capture('production-enqueue'); click('production-enqueue'); inert(old);
          const order = current().production.orders.find(item => item.id === id)!;
          expect(order).toMatchObject({ id, factionId: side.faction, systemId: side.home, remainingTurns: 4 });
          expect(order.design.hullId).toBe('fighter');
          if (source === 'library') expect(order.design).toEqual(saved);
          snapshots.set(id, structuredClone(order.design));
          expect(current().treasuries[side.faction]).toEqual({ credits: 380 - 185 * (index + 1), minerals: 190 - 11 * (index + 1) });
        }
        const paid = structuredClone(current()); click('production-refresh'); expect(current()).toEqual(paid);
        click('campaign-production'); end();
      }
      for (let i = 0; i < 6; i++) end();
      expect(current().turn).toBe(37);
      expect(current().production.completed.map(record => record.id)).toEqual([1, 3]);
      expect(current().production.orders.map(order => [order.id, order.remainingTurns])).toEqual([[2, 4], [4, 4]]);
      for (let i = 0; i < 8; i++) end();
      expect(current().turn).toBe(45); expect(current().production.orders).toEqual([]);
      expect(current().production.completed.map(record => record.id)).toEqual([1, 3, 2, 4]);
      expect(current().treasuries).toEqual({ blue: { credits: 170, minerals: 248 }, red: { credits: 170, minerals: 248 } });
      budgetCheckpoint(45, 0);
      for (const side of sides) {
        click(`system-${side.home}`); click('campaign-production');
        for (const id of side.ids) {
          expect(f.find('production-completed').text).toContain(`#${id}`);
          const old = capture('production-deploy'); click('production-deploy'); inert(old);
          expect(current().ships.find(ship => ship.id === id)).toEqual({ id, factionId: side.faction,
            systemId: side.home, fuel: 3, design: snapshots.get(id) });
          expect(current().production.completed.some(record => record.id === id)).toBe(false);
          click('campaign-budget'); expectBudgetOracle(f, current(), side.faction, id === side.ids[0] ? 1 : 2, 2);
          click('campaign-budget'); click('campaign-production');
        }
        click('production-fleets');
        expect(f.find('fleet-candidates-title').text).toBe('СВОБОДНЫЕ КОРАБЛИ: 2');
        click('fleet-select'); click('fleet-candidate-next'); click('fleet-select');
        const before = structuredClone(current()), old = capture('fleet-create'); click('fleet-create'); inert(old);
        expect(spy.mock.calls[spy.mock.calls.length - 1][1]).toEqual({ kind: 'createFleet', factionId: side.faction,
          expectedTurn: before.turn, systemId: side.home, shipIds: [...side.ids] });
        expect(current().ships).toEqual(before.ships); expect(current().production).toEqual(before.production);
        expect(current().fleets.lastFleetId).toBe(side.fleetId);
        checkShips(side, side.home, [3, 3]);
        expect(f.find('fleet-candidates-title').text).toBe('СВОБОДНЫЕ КОРАБЛИ: 0');
        for (const id of side.ids) {
          expect(f.find('fleet-member').text).toContain(`#${id}`);
          if (id === side.ids[0]) click('fleet-member-next');
        }
        click('production-travel'); click('travel-send', 'SHIP_IN_FLEET');
        click('campaign-production'); end();
      }
      expect(current().turn).toBe(47);
      expect(current().treasuries).toEqual({ blue: { credits: 188, minerals: 258 }, red: { credits: 188, minerals: 258 } });
      budgetCheckpoint(47, 2);
      expect(current().production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
      const reads = load.mock.calls.length;
      // Three real flight legs exhaust both tanks; the fourth returns each group home.
      for (let leg = 1; leg <= 4; leg++) {
        for (const side of sides) {
          const from = leg % 2 ? side.home : side.neighbor, to = leg % 2 ? side.neighbor : side.home;
          click(`system-${from}`); click('campaign-production'); click('production-fleets'); click('fleet-travel');
          expect(f.find('fleet-travel-current').text).toContain(`Группа #${side.fleetId}`);
          if (leg === 4) {
            checkShips(side, from, [0, 0]);
            expect(f.find('fleet-travel-fuel').text).toContain('0/3 · Без топлива: 2/2');
            click('fleet-travel-send', 'INSUFFICIENT_FUEL');
            const empty = structuredClone(current());
            for (const [index, id] of side.ids.entries()) {
              click('production-travel'); if (index) click('travel-ships-next');
              expect(f.find('travel-ship').text).toContain(`#${id}`);
              expect(f.find('travel-refuel-quote').text).toContain('+3 · Цена: 15 кр. / 6 мин.');
              const before = structuredClone(current()), old = capture('travel-refuel'); click('travel-refuel'); inert(old);
              expect(spy.mock.calls[spy.mock.calls.length - 1][1]).toEqual({ kind: 'refuelShip', factionId: side.faction,
                expectedTurn: before.turn, systemId: from, shipId: id });
              expect(current()).toEqual({ ...before,
                treasuries: { ...before.treasuries, [side.faction]: {
                  credits: before.treasuries[side.faction].credits - 15, minerals: before.treasuries[side.faction].minerals - 6 } },
                ships: before.ships.map(ship => ship.id === id ? { ...ship, fuel: 3 } : ship) });
              expect(f.find('travel-refuel').interactive).toBe(false);
              checkShips(side, from, index ? [3, 3] : [3, 0]);
              click('production-fleets'); click('fleet-travel');
              if (!index) {
                expect(f.find('fleet-travel-fuel').text).toContain('0/3 · Без топлива: 1/2');
                click('fleet-travel-send', 'INSUFFICIENT_FUEL'); checkShips(side, from, [3, 0]);
              }
            }
            expect(current().treasuries[side.faction]).toEqual({
              credits: empty.treasuries[side.faction].credits - 30, minerals: empty.treasuries[side.faction].minerals - 12 });
          }
          const before = structuredClone(current()), old = capture('fleet-travel-send');
          click('fleet-travel-send'); inert(old);
          expect(spy.mock.calls[spy.mock.calls.length - 1][1]).toEqual({ kind: 'sendFleet', factionId: side.faction,
            expectedTurn: before.turn, systemId: from, fleetId: side.fleetId, destinationId: to });
          const fuel = leg === 4 ? 2 : 3 - leg;
          checkShips(side, from, [fuel, fuel], to);
          expect(current().production).toEqual(before.production); expect(current().fleets).toEqual(before.fleets);
          expect(f.find('fleet-travel-title').text).toContain(': 0');
          expect(f.find('fleet-travel-send').interactive).toBe(false);
          expect(f.find('fleet-travel-transit').text).toContain(`1/1 · Группа #${side.fleetId}`);
          // Target and source both exclude travelling members; total own counts still include them.
          click('campaign-production'); click(`system-${to}`); click('campaign-production'); click('production-fleets');
          expect(f.find('fleet-candidates-title').text).toBe('СВОБОДНЫЕ КОРАБЛИ: 0');
          expect(f.find('fleet-disband').interactive).toBe(false);
          click('fleet-travel'); expect(f.find('fleet-travel-title').text).toContain(': 0');
          expect(f.find('fleet-travel-count').text).toContain('1/20');
          click('production-travel'); expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
          expect(f.find('travel-transit-title').text).toContain(': 2');
          click('production-fleets'); click('fleet-travel');
          end(); checkShips(side, to, [fuel, fuel]);
          click('campaign-side-switch'); // Observe arrival without granting another action window.
          click('production-fleets'); click('fleet-travel');
          expect(f.find('fleet-travel-transit').text).toBe('Групп в пути нет.');
          expect(f.find('fleet-travel-current').text).toContain(`Группа #${side.fleetId}`);
          click('fleet-travel-send', 'NOT_ACTIVE_FACTION');
          click('campaign-production'); click('campaign-side-switch');
        }
      }
      expect(current().turn).toBe(55);
      expect(current().treasuries).toEqual({ blue: { credits: 230, minerals: 286 }, red: { credits: 230, minerals: 286 } });
      budgetCheckpoint(55, 2);
      for (const side of sides) {
        checkShips(side, side.home, [2, 2]);
        click(`system-${side.home}`); click('campaign-production'); click('production-fleets');
        const before = structuredClone(current()), old = capture('fleet-disband'); click('fleet-disband'); inert(old);
        expect(current()).toEqual({ ...before, fleets: { lastFleetId: 2,
          items: before.fleets.items.filter(fleet => fleet.id !== side.fleetId) } });
        expect(f.find('fleet-candidates-title').text).toBe('СВОБОДНЫЕ КОРАБЛИ: 2');
        expect(f.find('fleet-disband').interactive).toBe(false);
        click('production-travel');
        for (const id of side.ids) {
          expect(f.find('travel-ship').text).toContain(`#${id}`);
          expect(f.find('travel-fuel').text).toContain('2/3'); expect(f.find('travel-send').interactive).toBe(true);
          expect(f.find('travel-limit').text).not.toContain('Группа #');
          if (id === side.ids[0]) click('travel-ships-next');
        }
        click('campaign-production'); end();
      }
      expect(current().turn).toBe(57); expect(current().fleets).toEqual({ lastFleetId: 2, items: [] });
      expect(current().treasuries).toEqual({ blue: { credits: 248, minerals: 296 }, red: { credits: 248, minerals: 296 } });
      budgetCheckpoint(57, 2);
      expect(current().production).toEqual({ lastOrderId: 4, orders: [], completed: [] });
      expect(current().ships.map(ship => [ship.id, ship.systemId, ship.fuel])).toEqual([[1, 'sol', 2], [2, 'sol', 2], [3, 'vega', 2], [4, 'vega', 2]]);
      const receipts = spy.mock.results.flatMap(({ value }) => {
        const result = value as domain.SessionResult;
        return result.ok && result.endTurnEconomy?.upkeep.dueCredits ? [result.endTurnEconomy] : [];
      });
      for (const side of sides) {
        const own = receipts.filter(receipt => receipt.factionId === side.faction);
        expect(own.map(receipt => receipt.turn)).toEqual(side.faction === 'blue' ? [45, 47, 49, 51, 53, 55] : [46, 48, 50, 52, 54, 56]);
        expect(own.map(receipt => receipt.upkeep.paidCredits)).toEqual([2, 2, 2, 2, 2, 2]);
        expect(own.reduce((sum, receipt) => sum + receipt.upkeep.paidCredits, 0)).toBe(12);
      }
      expect(load).toHaveBeenCalledTimes(reads); expect(repositoryLoad).toHaveBeenCalledTimes(reads);
      expect(repositoryLoad).toHaveBeenCalled(); expect(storage.getItem).toHaveBeenCalled();
      expect([...contents]).toEqual(originalContents); expect(storage.setItem).not.toHaveBeenCalled();
      oldCallbacks.forEach(inert);
      click('system-sol'); click('campaign-production'); click('production-fleets'); click('fleet-travel');
      const oldPanel = f.find('fleet-travel-panel');
      click('campaign-new'); click('campaign-cancel');
      expect(current().ships).toHaveLength(4); oldCallbacks.forEach(inert);
      click('campaign-new'); click('campaign-confirm'); oldCallbacks.forEach(inert);
      expect(oldPanel.destroyed).toBe(true); expect(current()).toEqual(domain.createCampaignSession());
      expect(f.find('campaign-system-name').text).toBe('Сол');
      expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
      click('campaign-production'); click('production-fleets');
      expect(f.find('fleet-selection-count').text).toContain('Выбрано: 0/10');
      click('fleet-travel'); expect(f.find('fleet-travel-count').text).toContain('0/20');
      expect(f.find('fleet-travel-send').interactive).toBe(false);
      click('campaign-menu'); const confirm = capture('campaign-confirm'); click('campaign-confirm');
      expect(f.start).toHaveBeenCalledExactlyOnceWith('MenuScene');
      expect(f.nodes.every(node => node.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
      f.scene.create(); inert(confirm); oldCallbacks.forEach(inert);
      expect(current()).toEqual(domain.createCampaignSession());
      expect(f.nodes.filter(node => !node.destroyed && node.name === 'campaign-panel')).toHaveLength(1);
      expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
      expect([...contents]).toEqual(originalContents); expect(storage.setItem).not.toHaveBeenCalled();
    } finally {
      f.events.emit('shutdown'); vi.unstubAllGlobals();
      expect(f.nodes.every(node => node.destroyed)).toBe(true);
      expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')).toEqual(originalStorage);
    }
  });

  it('starts with one panel, six systems and a blue home', () => {
    const f = fixture();
    expect(f.nodes.filter(node => node.name.startsWith('system-'))).toHaveLength(6);
    expect(f.details()).toContain('Синий союз');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.find('campaign-income').text).toContain('+10 кредитов · +5 минералов');
  });

  it('keeps hidden enemy and barren properties out of rendered details/markers', () => {
    const f = fixture();
    for (const id of ['vega', 'rift']) {
      f.click(`system-${id}`);
      expect(f.details()).toBe('Не разведана\nВладелец: неизвестен\nПригодность: неизвестна');
      expect(f.find(`system-${id}`).text.startsWith('○')).toBe(true);
    }
  });

  it('shows domain rejection and never accepts its state', () => {
    const spy = observeRunCommands();
    const f = fixture(); f.click('system-eden'); f.click('campaign-colonize');
    expect(f.message()).toBe('Система не разведана');
    const before = spy.mock.calls[0][0];
    f.click('campaign-explore');
    expect(spy.mock.calls[1][0]).toBe(before);
    expect(spy.mock.calls[1][1]).toEqual({ kind: 'explore', factionId: 'blue', systemId: 'eden', expectedTurn: 1 });
    expect(f.details()).toContain('Нет колонии');
    f.click('campaign-colonize');
    expect(spy.mock.calls[2][0]).not.toBe(before);
    expect(f.details()).toContain('Синий союз');
  });

  it('clears feedback and hides selected-system knowledge on side switch, without resetting the party', () => {
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    f.click('campaign-side-switch');
    expect(f.find('campaign-side').text).toBe('Красная лига');
    expect(f.message()).toBe(''); expect(f.details()).toContain('Владелец: неизвестен');
    expect(f.find('system-eden').text.startsWith('○')).toBe(true);
    f.click('campaign-side-switch'); expect(f.details()).toContain('Синий союз');
  });

  it('executes commands as the selected red side and supports return to blue perspective', () => {
    const f = fixture(); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('system-nexus');
    f.click('campaign-explore'); f.click('campaign-colonize');
    expect(f.details()).toContain('Красная лига');
    f.click('campaign-side-switch'); expect(f.details()).toContain('неизвестен');
  });

  it.each(['new', 'menu'] as const)('cancels %s, disables background commands, preserves the party', action => {
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    f.click(`campaign-${action}`);
    for (const name of ['campaign-explore', 'campaign-colonize', 'campaign-end-turn', 'campaign-side-switch', 'system-vega', 'campaign-new', 'campaign-menu']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    f.click('campaign-cancel'); expect(f.details()).toContain('Синий союз');
    expect(f.start).not.toHaveBeenCalled();
  });

  it('resets the party, side, selection and message after confirmation only', () => {
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    f.click('campaign-end-turn');
    f.click('campaign-side-switch'); f.click('campaign-new'); f.click('campaign-confirm');
    expect(f.find('campaign-side').text).toBe('Синий союз');
    expect(f.find('campaign-system-name').text).toBe('Сол');
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.find('campaign-income').text).toContain('+10 кредитов · +5 минералов');
    f.click('system-eden'); expect(f.details()).toContain('неизвестен');
    expect(f.nodes.filter(node => node.name === 'campaign-panel' && !node.destroyed)).toHaveLength(1);
  });

  it('ESC cancels pending confirmation; otherwise requests exit, never immediately loses the party', () => {
    const f = fixture(); f.keyboard.emit('keydown-ESC');
    expect(f.message()).toContain('Выйти в меню'); expect(f.start).not.toHaveBeenCalled();
    f.keyboard.emit('keydown-ESC'); expect(f.start).not.toHaveBeenCalled();
    f.click('campaign-new'); f.keyboard.emit('keydown-ESC');
    expect(f.find('campaign-new').interactive).toBe(true);
  });

  it('cleans up on exit and re-entry, with stale callbacks inert', () => {
    const f = fixture(); const stale = f.find('campaign-new').listeners('pointerdown')[0] as () => void;
    f.click('campaign-menu'); const confirm = f.find('campaign-confirm').listeners('pointerdown')[0] as () => void;
    confirm(); stale(); confirm();
    expect(f.start).toHaveBeenCalledTimes(1); expect(f.start).toHaveBeenCalledWith('MenuScene');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    expect(f.nodes.every(node => node.destroyed)).toBe(true);
    f.scene.create(); stale(); confirm();
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.find('campaign-system-name').text).toBe('Сол');
    f.events.emit('shutdown'); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
  });

  it('replaces old widgets instead of retaining interactive callbacks after every render', () => {
    const f = fixture(); const old = f.find('system-eden');
    const stale = old.listeners('pointerdown')[0] as () => void;
    f.click('system-vega'); stale();
    expect(f.find('campaign-system-name').text).toBe('Вега');
    expect(old.destroyed).toBe(true);
    expect(f.nodes.filter(node => node.name.startsWith('system-') && !node.destroyed)).toHaveLength(6);
  });

  it('shows projected income immediately, pays once and retains the observed side on end turn', () => {
    const spy = observeRunCommands();
    const f = fixture(); f.click('system-eden'); f.click('campaign-explore'); f.click('campaign-colonize');
    expect(f.find('campaign-income').text).toContain('+20 кредитов · +10 минералов');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    const oldEnd = f.find('campaign-end-turn').listeners('pointerdown')[0] as () => void;
    oldEnd(); oldEnd();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[2][1]).toEqual({ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    expect(f.find('campaign-turn').text).toBe('Ход 2 · Красная лига');
    expect(f.find('campaign-side').text).toBe('Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 120\nМинералы: 60');
    expect(f.find('campaign-turn-hint').text).toContain('Ход другой стороны');
    f.click('campaign-end-turn');
    expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 120\nМинералы: 60');
    f.click('campaign-side-switch');
    expect(f.message()).toBe('');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.find('campaign-income').text).toContain('+10 кредитов · +5 минералов');
    f.click('campaign-end-turn'); oldEnd();
    expect(f.find('campaign-turn').text).toBe('Ход 3 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 110\nМинералы: 55');
    f.click('campaign-side-switch');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 120\nМинералы: 60');
  });

  it.each(['campaign-explore', 'campaign-colonize', 'campaign-end-turn'])('switching observation does not authorize %s for an inactive side', button => {
    const spy = observeRunCommands();
    const f = fixture(); f.click('campaign-side-switch'); f.click('system-nexus');
    f.click(button);
    expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(spy.mock.results[0].value).toMatchObject({ ok: false, code: 'NOT_ACTIVE_FACTION' });
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.details()).toContain('неизвестен');
  });

  it('uses the displayed expected turn, rejects a stale command and refreshes without income', () => {
    // Simulate a state advance outside this rendered panel; not the normal synchronous UI path.
    const state = domain.createCampaignSession();
    seedSession(state);
    const spy = observeRunCommands();
    const f = fixture(); state.turn = 3;
    f.click('campaign-end-turn');
    expect(spy.mock.calls[0][1]).toEqual({ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
    expect(f.message()).toContain('Номер хода изменился');
    expect(f.find('campaign-turn').text).toBe('Ход 3 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    f.click('campaign-end-turn');
    expect(spy.mock.calls[1][1]).toEqual({ kind: 'endTurn', factionId: 'blue', expectedTurn: 3 });
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 110\nМинералы: 55');
  });

  it.each(['credits', 'minerals'] as const)('shows %s overflow without replacing state or paying partial income', resource => {
    const state = domain.createCampaignSession(); state.treasuries.blue[resource] = domain.MAX_RESOURCE;
    const before = structuredClone(state);
    seedSession(state);
    const spy = observeRunCommands();
    const f = fixture(), treasury = f.find('campaign-treasury').text;
    f.click('campaign-end-turn'); f.click('campaign-end-turn');
    expect(f.message()).toContain('Доход превысит предел');
    expect(f.find('campaign-treasury').text).toBe(treasury);
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(spy.mock.calls[1][0]).toBe(state); expect(state).toEqual(before);
  });

  it('shows the terminal turn error without income or side advance', () => {
    const state = domain.createCampaignSession(); state.turn = domain.MAX_TURN;
    seedSession(state);
    const f = fixture(); f.click('campaign-side-switch'); f.click('campaign-end-turn');
    expect(f.message()).toContain('Достигнут предел номера хода');
    expect(f.find('campaign-turn').text).toBe(`Ход ${domain.MAX_TURN} · Красная лига`);
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
  });

  it('does not reveal opponent resources even after exploring its colony', () => {
    const state = domain.createCampaignSession();
    state.galaxy.systems.find(system => system.id === 'vega')!.exploredBy.push('blue');
    state.treasuries.red = { credits: 987654321, minerals: 876543210 };
    seedSession(state);
    const f = fixture(); f.click('system-vega');
    expect(f.details()).toContain('Красная лига');
    const visibleText = () => f.nodes.filter(node => !node.destroyed).map(node => node.text).join('\n');
    expect(visibleText()).not.toContain('987654321'); expect(visibleText()).not.toContain('876543210');
    f.click('campaign-side-switch'); expect(visibleText()).toContain('987654321');
    f.click('campaign-side-switch'); expect(visibleText()).not.toContain('987654321');
  });

  it('makes old end-turn callbacks inert after reset and scene restart, even when turn is again 1', () => {
    const f = fixture(); const oldEnd = f.find('campaign-end-turn').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); f.click('campaign-confirm'); oldEnd();
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    f.click('campaign-menu'); f.click('campaign-confirm'); f.scene.create(); oldEnd();
    expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
  });

  function productionFixture(funded = true) {
    let ship = createDesign('fighter');
    ship = installComponent(ship, 'engine_1', createComponent('engine'));
    const invalid = createDesign('fighter'); invalid.name = 'Неполный проект';
    const choices: catalog.ProductionChoice[] = [
      { design: ship, source: 'Библиотека', quote: getProductionQuote(ship), issue: '' },
      { design: invalid, source: 'Библиотека', issue: 'Нужен двигатель' }
    ];
    const load = vi.spyOn(catalog, 'loadProductionCatalog').mockImplementation(() => ({ choices: structuredClone(choices), notice: 'Снимок библиотеки' }));
    const state = domain.createCampaignSession();
    if (funded) state.treasuries = { blue: { credits: 10000, minerals: 10000 }, red: { credits: 10000, minerals: 10000 } };
    seedSession(state);
    const spy = observeRunCommands();
    const f = fixture(); expect(load).not.toHaveBeenCalled(); f.click('campaign-production');
    return { ...f, choices, load, spy, state };
  }

  it('opens production lazily, shows quote and never turns selection into an order', () => {
    const f = productionFixture();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.find('production-quote').text).toContain('159 кр. / 9 мин.');
    expect(f.find('production-quote').text).toContain('4 своих ходов');
    expect(f.find('production-source').text).toBe('Библиотека · 1/2');
    f.click('production-next'); expect(f.find('production-quote').text).toBe('Нужен двигатель');
    expect(f.find('production-enqueue').interactive).toBe(false); f.click('production-enqueue');
    expect(f.spy).not.toHaveBeenCalled();
    f.click('production-prev'); f.click('production-refresh'); expect(f.load).toHaveBeenCalledTimes(2);
    f.click('campaign-production'); f.click('campaign-production'); expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('captures the quoted design and makes the old enqueue callback inert after payment', () => {
    const f = productionFixture();
    const callback = f.find('production-enqueue').listeners('pointerdown')[0] as () => void;
    const shown = f.find('production-design').text;
    f.choices[0].design.name = 'Changed externally';
    callback(); callback();
    expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toMatchObject({ kind: 'enqueueProduction', expectedTurn: 1, factionId: 'blue', systemId: 'sol' });
    expect(f.find('production-order-1').text).toContain(shown);
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 9841\nМинералы: 9991');
    expect(f.message()).toContain('Заказ оплачен');
  });

  it('shows insufficient resources without adding an order', () => {
    const f = productionFixture(false); f.click('production-enqueue');
    expect(f.message()).toContain('Недостаточно ресурсов');
    expect(f.find('production-queue-title').text).toContain('0/3');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 100\nМинералы: 50');
  });

  it('shows queue-full rejection without partial payment and cancellation frees a slot', () => {
    const f = productionFixture();
    for (let i = 0; i < 3; i++) f.click('production-enqueue');
    const treasury = f.find('campaign-treasury').text;
    f.click('production-enqueue'); expect(f.message()).toContain('Очередь колонии заполнена');
    expect(f.find('campaign-treasury').text).toBe(treasury);
    f.click('production-cancel-2'); expect(f.find('production-queue-title').text).toContain('2/3');
    expect(f.message()).toContain('Возврат');
  });

  it('shows partial progress and prorated refund, cancelling once without advancing time', () => {
    const f = productionFixture(); f.click('production-enqueue'); f.click('campaign-end-turn');
    expect(f.find('production-progress-1').text).toContain('готово 1/4 · осталось 3');
    expect(f.find('production-cancel-1').text).toContain('+119 кр. / +6 мин.');
    f.click('production-cancel-1'); expect(f.message()).toBe('Сейчас ход другой стороны');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch');
    const cancel = f.find('production-cancel-1').listeners('pointerdown')[0] as () => void;
    cancel(); const calls = f.spy.mock.calls.length; cancel(); expect(f.spy).toHaveBeenCalledTimes(calls);
    expect(f.find('campaign-turn').text).toContain('Ход 3');
    expect(f.find('campaign-treasury').text).toBe('Кредиты: 9970\nМинералы: 10002');
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('shows completed records without turning them into deployed ships', () => {
    const f = productionFixture(); f.click('production-enqueue');
    for (let i = 0; i < 7; i++) { f.click('campaign-end-turn'); if (i < 6) f.click('campaign-side-switch'); }
    expect(f.find('production-completed-title').text).toContain('ГОТОВО К РАЗМЕЩЕНИЮ: 1');
    expect(f.find('production-completed').text).toContain('#1');
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('does not show own-colony controls or leak queued designs under another perspective', () => {
    const f = productionFixture(); f.click('production-enqueue');
    f.click('campaign-side-switch');
    expect(f.find('production-unavailable').text).toContain('Чужие очереди недоступны');
    const liveNames = f.nodes.filter(n => !n.destroyed).map(n => n.name);
    expect(liveNames).not.toContain('production-enqueue'); expect(liveNames).not.toContain('production-order-1');
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production');
    f.click('production-enqueue'); expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('blocks every production control during confirmation, ESC cancels then closes production', () => {
    const f = productionFixture(); f.click('production-enqueue'); f.click('campaign-new');
    for (const name of ['campaign-production', 'production-enqueue', 'production-refresh', 'production-next', 'production-cancel-1']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-queue-title').text).toContain('1/3');
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('does not execute callbacks from a closed/refreshed/reset production panel', () => {
    const f = productionFixture();
    const old = f.find('production-enqueue').listeners('pointerdown')[0] as () => void;
    f.click('production-refresh'); old(); expect(f.spy).not.toHaveBeenCalled();
    const next = f.find('production-enqueue').listeners('pointerdown')[0] as () => void;
    f.click('campaign-production'); next(); expect(f.spy).not.toHaveBeenCalled();
    f.click('campaign-new'); f.click('campaign-confirm'); old(); next();
    expect(f.spy).not.toHaveBeenCalled(); expect(f.find('campaign-turn').text).toContain('Ход 1');
    f.click('campaign-production'); expect(f.load).toHaveBeenCalledTimes(3);
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
  });

  it('sends captured expectedTurn for enqueue and displays stale rejection', () => {
    const f = productionFixture(); f.state.turn = 3;
    f.click('production-enqueue'); expect(f.message()).toContain('Номер хода изменился');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ expectedTurn: 1 });
    expect(f.find('production-queue-title').text).toContain('0/3');
  });

  it('paginates all completed records and clamps the page after changing perspective', () => {
    const f = productionFixture();
    f.state.production.lastOrderId = 3;
    f.state.production.completed = [1, 2, 3].map(id => ({ id, factionId: 'blue', systemId: 'sol', design: f.choices[0].design }));
    f.click('production-refresh'); expect(f.find('production-completed').text).toContain('1/3');
    f.click('production-completed-next'); f.click('production-completed-next');
    expect(f.find('production-completed').text).toContain('3/3'); expect(f.find('production-completed-next').interactive).toBe(false);
    f.click('campaign-side-switch'); f.click('campaign-side-switch');
    expect(f.find('production-completed').text).toContain('1/3');
  });

  it('shows refund overflow without removing the order and rejects a stale cancellation', () => {
    const f = productionFixture(); f.click('production-enqueue');
    const result = f.spy.mock.results[0].value;
    if (!result.ok) throw Error('fixture');
    result.state.treasuries.blue.credits = domain.MAX_RESOURCE;
    f.click('production-refresh'); f.click('production-cancel-1');
    expect(f.message()).toContain('Возврат превысит предел');
    expect(f.find('production-queue-title').text).toContain('1/3');
    result.state.turn = 3; f.click('production-cancel-1');
    expect(f.message()).toContain('Номер хода изменился');
    expect(f.find('production-queue-title').text).toContain('1/3');
  });

  it('fits long names with an ellipsis after the order ID without changing the paid design', () => {
    const f = productionFixture();
    const name = `Ш\n${'Ш'.repeat(78)}`;
    f.choices[0].design.name = name; f.state.production.lastOrderId = 999999998;
    f.click('production-refresh');
    expect(f.find('production-design').text).not.toContain('\n');
    expect(f.find('production-design').text).toMatch(/^Ш Ш.*…$/);
    expect(f.find('production-design').width).toBeLessThanOrEqual(435);
    f.click('production-enqueue');
    const label = f.find('production-order-999999999');
    expect(label.text).toMatch(/^#999999999 Ш Ш.*…$/); expect(label.width).toBeLessThanOrEqual(435);
    expect(f.spy.mock.calls[0][1]).toMatchObject({ design: { name } });
  });

  function deploymentFixture(count = 3) {
    const f = productionFixture();
    f.state.production.lastOrderId = count;
    f.state.production.completed = Array.from({ length: count }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol',
      design: { ...structuredClone(f.choices[0].design), name: `Готовый ${i + 1}` } }));
    f.click('production-refresh'); return f;
  }

  it('disables deployment without completed records and shows an empty ship list', () => {
    const f = productionFixture();
    expect(f.find('production-deploy').interactive).toBe(false); f.click('production-deploy');
    expect(f.spy).not.toHaveBeenCalled(); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    expect(f.find('production-ships-prev').interactive).toBe(false);
    expect(f.find('production-ships-next').interactive).toBe(false);
    expect(f.nodes.some(n => !n.destroyed && n.name === 'production-deploy')).toBe(false);
  });

  it('deploys the displayed ID exactly once with captured payload and no payment or turn change', () => {
    const f = deploymentFixture(); f.click('production-completed-next');
    const callback = f.find('production-deploy').listeners('pointerdown')[0] as () => void;
    const treasury = f.find('campaign-treasury').text, turn = f.find('campaign-turn').text;
    callback(); callback();
    expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'deployProduction', factionId: 'blue', systemId: 'sol', expectedTurn: 1, orderId: 2 });
    expect(f.find('campaign-treasury').text).toBe(treasury); expect(f.find('campaign-turn').text).toBe(turn);
    expect(f.message()).toBe('Корабль размещён в колонии.');
    expect(f.find('production-completed').text).toContain('#3 Готовый 3');
    f.click('production-toggle-ships'); expect(f.find('production-ship').text).toBe('1/1 · #2 Готовый 2');
    expect(f.find('production-ships-hint').text).toContain('1/100');
  });

  it('clamps completed pages after removing the last record, and opens the latest deployed ship', () => {
    const f = deploymentFixture(); f.click('production-completed-next'); f.click('production-completed-next');
    f.click('production-deploy'); expect(f.find('production-completed').text).toContain('2/2 · #2');
    f.click('production-deploy'); expect(f.find('production-completed').text).toContain('1/1 · #1');
    f.click('production-deploy'); expect(f.find('production-deploy').interactive).toBe(false);
    f.click('production-toggle-ships'); expect(f.find('production-ship').text).toContain('3/3 · #1');
    f.click('production-ships-prev'); expect(f.find('production-ship').text).toContain('2/3 · #2');
    f.click('production-ships-prev'); expect(f.find('production-ship').text).toContain('1/3 · #3');
    expect(f.find('production-ships-prev').interactive).toBe(false);
    f.click('production-ships-next'); expect(f.find('production-ship').text).toContain('2/3');
    f.click('production-toggle-ships'); expect(f.find('production-completed').text).toBe('Готовых записей пока нет.');
  });

  it('rejects deployment by an inactive observer without consuming ready records', () => {
    const f = deploymentFixture(1); f.click('campaign-end-turn'); f.click('production-deploy');
    expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('production-completed').text).toContain('#1');
    f.click('production-toggle-ships'); expect(f.find('production-ships-title').text).toContain(': 0');
  });

  it('shows SHIP_LIMIT without removing completed and paginates 100 existing ships', () => {
    const f = deploymentFixture(1); f.state.production.lastOrderId = 101;
    f.state.ships = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(f.state.production.completed[0]), fuel: 3, id: i + 2 }));
    f.click('production-refresh'); expect(f.find('production-deploy-hint').text).toContain('100/100');
    f.click('production-deploy'); expect(f.message()).toBe('Достигнут предел стратегических кораблей стороны');
    expect(f.find('production-completed').text).toContain('#1');
    f.click('production-toggle-ships');
    for (let i = 1; i < 100; i++) f.click('production-ships-next');
    expect(f.find('production-ship').text).toContain('100/100 · #101');
    expect(f.find('production-ships-next').interactive).toBe(false);
  });

  it('shows stale turn or vanished completed rejection instead of deploying a different record', () => {
    const f = deploymentFixture(); f.state.turn = 3; f.click('production-deploy');
    expect(f.message()).toContain('Номер хода изменился');
    f.state.production.completed.shift(); f.click('production-deploy');
    expect(f.message()).toBe('Готовый проект не найден в колонии');
    expect(f.find('production-completed').text).toContain('#2');
    expect(f.find('production-toggle-ships').text).toBe('Корабли: 0');
  });

  it('hides enemy records and resets ship pages on perspective or colony change', () => {
    const f = deploymentFixture(3);
    f.state.ships = f.state.production.completed.splice(0).map(record => ({ ...record, fuel: 3 }));
    const eden = f.state.galaxy.systems.find(s => s.id === 'eden')!; eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    f.state.production.lastOrderId = 4;
    f.state.ships.push({ ...structuredClone(f.state.ships[0]), id: 4, systemId: 'eden', design: { ...f.choices[0].design, name: 'Эдемский' } });
    f.click('production-refresh'); f.click('production-toggle-ships'); f.click('production-ships-next');
    expect(f.find('production-ship').text).toContain('2/3');
    f.click('campaign-side-switch');
    expect(f.nodes.filter(n => !n.destroyed).some(n => ['production-ship', 'production-deploy', 'production-toggle-ships'].includes(n.name))).toBe(false);
    expect(f.nodes.filter(n => !n.destroyed).some(n => n.text.includes('Готовый'))).toBe(false);
    f.click('campaign-side-switch'); f.click('production-toggle-ships'); expect(f.find('production-ship').text).toContain('1/3');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('1/1 · #4 Эдемский');
    expect(f.find('production-ships-hint').text).toContain('4/100');
  });

  it('deploys a red project through the UI of its own colony', () => {
    const f = deploymentFixture(1); f.state.production.completed[0].factionId = 'red'; f.state.production.completed[0].systemId = 'vega';
    f.click('campaign-end-turn'); f.click('campaign-side-switch');
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-deploy');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'deployProduction', factionId: 'red', expectedTurn: 2, systemId: 'vega', orderId: 1 });
    f.click('production-toggle-ships'); expect(f.find('production-ship').text).toContain('#1');
  });

  it('blocks deployment/navigation while pending and ESC cancels without losing ready or ships', () => {
    const f = deploymentFixture(); f.click('production-deploy'); f.click('campaign-new');
    for (const name of ['production-deploy', 'production-toggle-ships', 'production-completed-next']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-completed').text).toContain('1/2');
    f.click('production-toggle-ships'); f.click('campaign-menu');
    expect(f.find('production-toggle-ships').interactive).toBe(false);
    expect(f.find('production-ships-prev').interactive).toBe(false);
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-ship').text).toContain('#1');
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
  });

  it.each(['production-completed-next', 'production-refresh', 'production-toggle-ships', 'campaign-side-switch', 'campaign-production'])('makes old deploy inert after %s', action => {
    const f = deploymentFixture(); const old = f.find('production-deploy').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('clears ships/pages on reset and destroys deployment callbacks and child roots on exit/reentry', () => {
    const f = deploymentFixture(); const old = f.find('production-deploy').listeners('pointerdown')[0] as () => void;
    f.click('production-deploy'); f.click('production-toggle-ships');
    f.click('campaign-new'); f.click('campaign-confirm'); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    f.click('campaign-production'); expect(f.find('production-deploy').interactive).toBe(false);
    f.click('production-toggle-ships'); expect(f.find('production-ships-title').text).toContain(': 0');
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production');
    expect(f.find('production-completed').text).toBe('Готовых записей пока нет.');
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'production-panel')).toHaveLength(1);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
  });

  it('fits long ready and deployed names without changing the deployed design', () => {
    const f = deploymentFixture(1); f.state.production.completed[0].design.name = 'Ш'.repeat(80);
    f.state.production.lastOrderId = 999999999; f.state.production.completed[0].id = 999999999;
    f.click('production-refresh'); expect(f.find('production-completed').width).toBeLessThanOrEqual(570);
    expect(f.find('production-completed').text).toMatch(/#999999999 Ш.*…$/);
    f.click('production-deploy'); f.click('production-toggle-ships');
    expect(f.find('production-ship').width).toBeLessThanOrEqual(745);
    expect(f.find('production-ship').text).toMatch(/#999999999 Ш.*…$/);
    expect(f.spy.mock.results[0].value.state.ships[0].design.name).toBe('Ш'.repeat(80));
  });

  it('excludes an in-transit ship from both colony lists but counts it in the faction cap', () => {
    const f = deploymentFixture(1), eden = f.state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    f.state.ships = [{ ...f.state.production.completed[0], fuel: 2, transit: { destinationId: 'eden', remainingTurns: 1 } }];
    f.state.production.completed = [];
    f.click('production-refresh'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    expect(f.find('production-ships-hint').text).toContain('1/100');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-toggle-ships');
    expect(f.find('production-ship').text).toBe('Размещённых кораблей пока нет.');
    f.click('campaign-end-turn'); expect(f.find('production-ship').text).toContain('#1 Готовый 1');
  });

  function travelFixture(count = 3) {
    const f = deploymentFixture(count);
    f.state.ships = f.state.production.completed.splice(0).map(record => ({ ...record, fuel: 3 }));
    const eden = f.state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = 'blue'; eden.exploredBy = ['blue'];
    f.click('production-travel'); return f;
  }

  it.each([0, 2, 100])('shows the actual endTurn receipt for %i ships, not the following forecast', count => {
    const f = travelFixture(count);
    f.state.treasuries.blue = { credits: 5, minerals: 5 };
    const before = structuredClone(f.state), paid = Math.min(25, count);
    f.click('campaign-end-turn');
    const result = f.spy.mock.results[f.spy.mock.results.length - 1].value as domain.SessionResult;
    if (!result.ok || !result.endTurnEconomy) throw Error('Expected endTurn receipt');
    expect(f.message()).toBe(`Ход передан. Доход: +20 кр. / +10 мин. Содержание: ${paid}/${count} кр. Дефицит: ${count - paid} кр. (без долга).`);
    expect(result.endTurnEconomy.treasuryAfter).toEqual({ credits: 25 - paid, minerals: 15 });
    expect(result.state.ships).toEqual(before.ships); expect(result.state.turn).toBe(2);
    const preview = domain.getCampaignSessionView(result.state, 'blue').economyForecast;
    if (!preview.ok) throw Error(preview.code);
    if (count === 100) expect(preview.upkeep.paidCredits).toBe(20); // Receipt paid25, subsequent forecast pays20.
    expect(f.state).toEqual(before);
    f.click('campaign-end-turn'); expect(f.message()).toContain('Сейчас ход другой стороны');
    f.events.emit('shutdown');
  });

  it('opens travel without reading the catalog again or changing the state', () => {
    const f = travelFixture(), before = structuredClone(f.state), reads = f.load.mock.calls.length;
    expect(f.find('travel-destination').text).toBe('Цель 1/1: Эдем');
    expect(f.find('travel-ships-title').text).toContain(': 3');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.find('travel-count').text).toContain('3/100');
    f.click('production-travel'); f.click('production-travel');
    expect(f.load).toHaveBeenCalledTimes(reads); expect(f.spy).not.toHaveBeenCalled(); expect(f.state).toEqual(before);
  });

  it('shows empty-tank refusal without changing ships, and labels the colony refuel boundary', () => {
    const f = travelFixture(1); f.state.ships[0].fuel = 0;
    const before = structuredClone(f.state);
    expect(f.find('travel-rule').text).toContain('Расход: 1 топливо');
    expect(f.find('travel-limit').text).toContain('только в своей колонии');
    f.click('travel-send');
    expect(f.message()).toContain('Недостаточно стратегического топлива');
    expect(f.state).toEqual(before); expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.find('travel-ship').text).toContain('#1');
  });

  function refuelFixture(count = 3) {
    const f = travelFixture(count);
    f.state.ships.forEach((ship, i) => { ship.fuel = i % 3; });
    f.click('production-travel'); f.click('production-travel');
    return f;
  }

  function fleetFixture(count = 4) {
    const f = travelFixture(count);
    f.click('production-fleets');
    const selectTwo = () => { f.click('fleet-select'); f.click('fleet-candidate-next'); f.click('fleet-select'); };
    return { ...f, selectTwo };
  }

  function fleetTravelFixture(count = 4) {
    const f = fleetFixture(count);
    for (let i = 0; i < Math.min(20, Math.floor(count / 2)); i++) {
      f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create');
    }
    f.click('fleet-travel');
    const current = () => (f.scene as unknown as { campaign: domain.CampaignSession }).campaign;
    return { ...f, current };
  }

  it('opens exclusive fleet routes, preserves selected group and captures one send without rereading catalog', () => {
    const f = fleetTravelFixture(), before = structuredClone(f.current()), reads = f.load.mock.calls.length;
    expect(f.find('fleet-travel-current').text).toContain('2/2 · Группа #2');
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/1: Эдем');
    expect(f.find('fleet-travel-fuel').text).toContain('3/3');
    expect(f.nodes.some(n => !n.destroyed && ['fleet-create', 'fleet-disband', 'travel-panel', 'production-enqueue'].includes(n.name))).toBe(false);
    const old = f.find('fleet-travel-send').listeners('pointerdown')[0] as () => void;
    const calls = f.spy.mock.calls.length; old(); old();
    expect(f.spy).toHaveBeenCalledTimes(calls + 1);
    expect(f.spy.mock.calls[calls][1]).toEqual({ kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 2, destinationId: 'eden' });
    expect(f.current().treasuries).toEqual(before.treasuries); expect(f.current().turn).toBe(before.turn);
    expect(f.current().ships.map(s => s.design)).toEqual(before.ships.map(s => s.design));
    expect(f.current().ships.map(s => s.fuel)).toEqual([3, 3, 2, 2]);
    expect(f.find('fleet-travel-current').text).toContain('1/1 · Группа #1');
    expect(f.find('fleet-travel-transit').text).toContain('1/1 · Группа #2');
    expect(f.find('fleet-travel-route').text).toContain('Сол → Эдем');
    expect(f.find('fleet-travel-count').text).toContain('2/20');
    expect(f.load).toHaveBeenCalledTimes(reads);
  });

  it('pages all own trips and clamps them on arrival, even when viewing the destination', () => {
    const f = fleetTravelFixture(6);
    f.click('fleet-travel-prev'); f.click('fleet-travel-send');
    f.click('fleet-travel-send'); f.click('fleet-travel-send');
    expect(f.find('fleet-travel-transit').text).toContain('1/3 · Группа #1');
    f.click('fleet-travel-transit-next'); expect(f.find('fleet-travel-transit').text).toContain('Группа #2');
    f.click('fleet-travel-transit-next'); expect(f.find('fleet-travel-transit').text).toContain('3/3 · Группа #3');
    expect(f.find('fleet-travel-send').interactive).toBe(false);
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-title').text).toContain(': 0'); expect(f.find('fleet-travel-transit-title').text).toContain(': 3');
    f.click('campaign-end-turn');
    expect(f.find('fleet-travel-transit').text).toBe('Групп в пути нет.');
    expect(f.find('fleet-travel-current').text).toContain('1/3 · Группа #1');
    expect(f.find('fleet-travel-fuel').text).toContain('2/3');
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/1: Сол');
    const before = structuredClone(f.current()); f.click('fleet-travel-send');
    expect(f.message()).toBe('Сейчас ход другой стороны'); expect(f.current()).toEqual(before);
    f.click('fleet-travel'); expect(f.find('fleet-member-fuel').text).toContain('2/3');
  });

  it.each([0, 1])('keeps send clickable for an empty member %i and refuels through existing individual UI', emptyIndex => {
    const f = fleetTravelFixture(2); f.current().ships[emptyIndex].fuel = 0;
    f.click('fleet-travel'); f.click('fleet-travel');
    expect(f.find('fleet-travel-fuel').text).toContain('0/3 · Без топлива: 1/2');
    const before = structuredClone(f.current()); f.click('fleet-travel-send');
    expect(f.message()).toContain('Недостаточно топлива'); expect(f.current()).toEqual(before);
    f.click('production-travel'); if (emptyIndex) f.click('travel-ships-next'); f.click('travel-refuel');
    f.click('production-fleets'); f.click('fleet-travel'); f.click('fleet-travel-send');
    expect(f.current().ships.map(s => s.fuel)).toEqual([2, 2]);
    expect(f.current().treasuries.blue).toEqual({ credits: before.treasuries.blue.credits - 15, minerals: before.treasuries.blue.minerals - 6 });
  });

  it.each(['empty', 'no-target'] as const)('disables fleet send for %s without issuing a command', reason => {
    const f = fleetTravelFixture(reason === 'empty' ? 0 : 2);
    if (reason === 'no-target') { f.current().galaxy.systems.find(s => s.id === 'eden')!.ownerId = null; f.click('fleet-travel'); f.click('fleet-travel'); }
    const before = structuredClone(f.current()), calls = f.spy.mock.calls.length;
    expect(f.find('fleet-travel-send').interactive).toBe(false); f.click('fleet-travel-send');
    expect(f.spy).toHaveBeenCalledTimes(calls); expect(f.current()).toEqual(before);
    expect(f.find(reason === 'empty' ? 'fleet-travel-current' : 'fleet-travel-destination').text).toContain(reason === 'empty' ? 'Нет групп' : 'Нет соседних');
  });

  it('offers only own adjacent targets and sends the captured second destination from Eden', () => {
    const f = fleetTravelFixture();
    f.current().ships.forEach(s => { s.systemId = 'eden'; });
    f.current().fleets.items.forEach(g => { g.systemId = 'eden'; });
    const nexus = f.current().galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'blue'; nexus.exploredBy = ['blue'];
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/2: Сол');
    f.click('fleet-travel-destination-next'); expect(f.find('fleet-travel-destination').text).toContain('2/2:');
    f.click('fleet-travel-next'); expect(f.find('fleet-travel-destination').text).toBe('Цель 1/2: Сол');
    f.click('fleet-travel-destination-next'); f.click('fleet-travel-send');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'eden', fleetId: 2, destinationId: 'nexus' });
    expect(f.find('fleet-travel-destination').text).toBe('Цель 1/2: Сол');
  });

  it.each(['stale', 'missing', 'moving', 'target-lost', 'source-moved'] as const)('rejects captured fleet send after %s without UI-side state mutation', reason => {
    const f = fleetTravelFixture(2), state = f.current();
    const expected = { stale: 'STALE_TURN', missing: 'FLEET_NOT_FOUND', moving: 'FLEET_IN_TRANSIT', 'target-lost': 'NOT_OWN_COLONY', 'source-moved': 'FLEET_NOT_FOUND' };
    if (reason === 'stale') state.turn = 3;
    if (reason === 'missing') state.fleets.items = [];
    if (reason === 'moving') state.ships.forEach(s => { s.transit = { destinationId: 'eden', remainingTurns: 1 }; });
    if (reason === 'target-lost') state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    if (reason === 'source-moved') { state.fleets.items[0].systemId = 'eden'; state.ships.forEach(s => { s.systemId = 'eden'; }); }
    const before = structuredClone(state); f.click('fleet-travel-send');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value).toMatchObject({ ok: false, code: expected[reason] });
    expect(f.current()).toEqual(before);
  });

  it('keeps routes on failed endTurn and hides enemy groups and routes for the other observer', () => {
    const f = fleetTravelFixture(2); f.click('fleet-travel-send');
    f.current().treasuries.blue.credits = domain.MAX_RESOURCE;
    const before = structuredClone(f.current()); f.click('campaign-end-turn'); expect(f.current()).toEqual(before);
    expect(f.find('fleet-travel-transit-title').text).toContain(': 1');
    f.click('campaign-side-switch');
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-count').text).toContain('0/20'); expect(f.find('fleet-travel-transit-title').text).toContain(': 0');
    expect(f.nodes.filter(n => !n.destroyed).map(n => n.text).join(' ')).not.toContain('Группа #1');
  });

  it('sends a red group through the same controls and never advances it on blue endTurn', () => {
    const f = fleetTravelFixture(2), state = f.current();
    state.ships.forEach(s => { s.factionId = 'red'; s.systemId = 'vega'; });
    Object.assign(state.fleets.items[0], { factionId: 'red', systemId: 'vega' });
    Object.assign(state.galaxy.systems.find(s => s.id === 'nexus')!, { ownerId: 'red', exploredBy: ['red'] });
    state.turn = 2;
    f.click('campaign-side-switch'); f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    f.click('fleet-travel-send'); expect(f.current().ships.every(s => s.transit?.destinationId === 'nexus' && s.fuel === 2)).toBe(true);
    // A valid pending red trip may coexist with an active blue turn.
    f.current().turn = 3; f.click('campaign-side-switch'); f.click('campaign-end-turn');
    expect(f.current().ships.every(s => s.transit)).toBe(true);
    f.click('campaign-side-switch'); f.click('production-fleets'); f.click('fleet-travel'); f.click('campaign-end-turn');
    expect(f.current().ships.every(s => s.systemId === 'nexus' && !s.transit)).toBe(true);
  });

  it('blocks route controls during pending, invalidates old handlers and unwinds ESC one view at a time', () => {
    const f = fleetTravelFixture(4), old = f.find('fleet-travel-send').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); const calls = f.spy.mock.calls.length;
    for (const name of ['fleet-travel', 'fleet-travel-send', 'fleet-travel-prev', 'fleet-travel-destination-next', 'fleet-travel-transit-next']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    old(); expect(f.spy).toHaveBeenCalledTimes(calls);
    f.keyboard.emit('keydown-ESC'); expect(f.find('fleet-travel-current').text).toContain('Группа #2');
    f.keyboard.emit('keydown-ESC'); expect(f.find('fleet-current').text).toContain('Группа #2');
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-enqueue')).toBeDefined();
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
    f.keyboard.emit('keydown-ESC'); expect(f.find('campaign-confirm')).toBeDefined();
  });

  it('clears group draft on routes, destroys nested panels on reset and reenters with no route state', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-travel'); f.click('fleet-travel');
    expect(f.find('fleet-selection-count').text).toContain('Выбрано: 0/10');
    f.selectTwo(); f.click('fleet-create'); f.click('fleet-travel'); f.click('fleet-travel-send');
    const old = f.find('fleet-travel-transit-prev');
    f.click('campaign-new'); f.click('campaign-confirm'); expect(old.destroyed).toBe(true);
    f.click('campaign-production'); f.click('production-fleets'); f.click('fleet-travel');
    expect(f.find('fleet-travel-count').text).toContain('0/20');
    f.click('campaign-menu'); f.click('campaign-confirm'); expect(f.nodes.every(n => n.destroyed)).toBe(true);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0); f.scene.create();
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.scene).toMatchObject({ fleetTravelOpen: false, fleetDestinationIndex: 0, fleetTransitPage: 0 });
  });

  it('browses twenty own groups at the ship cap and safely displays the maximum fleet ID', () => {
    const f = fleetTravelFixture(100), state = f.current();
    // Keep the domain cap and exercise the largest valid fleet ID.
    state.fleets.items[state.fleets.items.length - 1].id = 1_000_000_000; state.fleets.lastFleetId = 1_000_000_000;
    f.click('fleet-travel'); f.click('fleet-travel');
    expect(f.find('fleet-travel-count').text).toContain('20/20');
    expect(f.find('fleet-travel-count').text).toContain('100/100');
    expect(f.find('fleet-travel-current').text).toContain('#1000000000');
    expect(f.find('fleet-travel-current').width).toBeLessThanOrEqual(745);
    f.click('fleet-travel-send'); expect(f.find('fleet-travel-transit').text).toContain('#1000000000');
    expect(f.current().fleets.items).toHaveLength(20);
  });

  it('hides an API-sent group at both endpoints, preserves total cap and shows it after arrival', () => {
    const f = fleetFixture(2); f.selectTwo(); f.click('fleet-create');
    const old = f.find('fleet-disband').listeners('pointerdown')[0] as () => void;
    // Preserve coverage of the direct scene boundary independently of the send UI.
    (f.scene as unknown as { execute: (command: domain.SessionCommand) => void }).execute({
      kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden'
    });
    const calls = f.spy.mock.calls.length; old(); expect(f.spy).toHaveBeenCalledTimes(calls);
    expect(f.message()).toContain('Группа отправлена');
    expect(f.find('fleet-count').text).toContain('КОЛОНИИ: 0 · У стороны: 1/20');
    expect(f.find('fleet-disband').interactive).toBe(false); expect(f.find('fleet-candidates-title').text).toContain(': 0');
    expect(f.find('fleet-limit').text).toContain('Маршруты');
    f.click('production-travel'); expect(f.find('travel-transit-title').text).toContain(': 2');
    expect(f.find('travel-count').text).toContain('2/100');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-disband').interactive).toBe(false);
    f.click('campaign-end-turn'); expect(f.find('fleet-current').text).toContain('Группа #1');
    expect(f.find('fleet-member-fuel').text).toContain('2/3');
    f.click('fleet-disband'); expect(f.message()).toBe('Сейчас ход другой стороны');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('production-fleets');
    f.click('fleet-disband'); expect(f.find('fleet-candidates-title').text).toContain(': 2');
  });

  it('rejects captured disband when the same group started travelling without a UI redraw', () => {
    const f = fleetFixture(2); f.selectTwo(); f.click('fleet-create');
    const grouped = f.spy.mock.results[0].value.state as domain.CampaignSession;
    const moving = domain.executeSessionCommand(grouped, { kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden' });
    if (!moving.ok) throw Error(moving.code);
    Object.assign(f.scene, { campaign: moving.state });
    f.click('fleet-disband');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value).toMatchObject({ ok: false, code: 'FLEET_IN_TRANSIT' });
    expect(f.find('fleet-current').text).toBe('Групп в этой колонии нет.');
    expect(moving.state.fleets.items).toHaveLength(1);
  });

  it('clamps the displayed group when another group departs and clears all trips/groups on reset', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create');
    expect(f.find('fleet-current').text).toContain('2/2 · Группа #2');
    (f.scene as unknown as { execute: (command: domain.SessionCommand) => void }).execute({
      kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden'
    });
    expect(f.find('fleet-current').text).toContain('1/1 · Группа #2');
    expect(f.find('fleet-member').text).toContain('#3');
    f.click('campaign-new'); f.click('campaign-confirm'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-count').text).toContain('0/20');
    f.click('production-travel'); expect(f.find('travel-transit-title').text).toContain(': 0');
  });

  it('opens exclusive group view without commands or catalog reads; empty controls are disabled', () => {
    const f = fleetFixture(0), before = structuredClone(f.state), reads = f.load.mock.calls.length;
    expect(f.find('fleet-candidate').text).toBe('Нет свободных стоящих кораблей.');
    expect(f.find('fleet-current').text).toBe('Групп в этой колонии нет.');
    for (const name of ['fleet-select', 'fleet-create', 'fleet-clear', 'fleet-disband', 'fleet-next', 'fleet-member-next']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    expect(f.nodes.some(n => !n.destroyed && ['travel-panel', 'production-enqueue'].includes(n.name))).toBe(false);
    f.click('production-fleets'); expect(f.find('production-enqueue')).toBeDefined();
    f.click('production-fleets'); expect(f.find('fleet-panel')).toBeDefined();
    expect(f.state).toEqual(before); expect(f.spy).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(reads);
  });

  it('captures the displayed ordered membership once, without payment or copying ship designs', () => {
    const f = fleetFixture(), before = structuredClone(f.state), reads = f.load.mock.calls.length;
    f.click('fleet-candidate-next'); f.click('fleet-select');
    expect(f.find('fleet-create').interactive).toBe(false);
    f.click('fleet-candidate-prev'); f.click('fleet-select');
    const old = f.find('fleet-create').listeners('pointerdown')[0] as () => void;
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'createFleet', factionId: 'blue', systemId: 'sol', expectedTurn: 1, shipIds: [2, 1] });
    const next = f.spy.mock.results[0].value.state;
    expect(next).toEqual({ ...before, fleets: { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [2, 1] }] } });
    expect(f.find('fleet-selection-count').text).toContain('Выбрано: 0/10');
    expect(f.find('fleet-candidate').text).toContain('#3');
    expect(f.find('fleet-member').text).toContain('#2'); f.click('fleet-member-next'); expect(f.find('fleet-member').text).toContain('#1');
    expect(f.find('fleet-member-next').interactive).toBe(false);
    expect(f.load).toHaveBeenCalledTimes(reads); expect(f.state).toEqual(before);
  });

  it('limits selection to ten, allows deselection and clear without changing membership', () => {
    const f = fleetFixture(12);
    for (let i = 0; i < 10; i++) { f.click('fleet-select'); f.click('fleet-candidate-next'); }
    expect(f.find('fleet-selection-count').text).toContain('10/10'); expect(f.find('fleet-select').interactive).toBe(false);
    f.click('fleet-select'); f.click('fleet-candidate-prev'); expect(f.find('fleet-select').interactive).toBe(true);
    f.click('fleet-select'); expect(f.find('fleet-selection-count').text).toContain('9/10');
    f.click('fleet-select'); f.click('fleet-clear');
    expect(f.find('fleet-selection-count').text).toContain('0/10'); expect(f.spy).not.toHaveBeenCalled();
  });

  it('browses multiple groups, disbands the captured last group once and clamps member/group pages', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create');
    expect(f.find('fleet-current').text).toContain('2/2 · Группа #2');
    f.click('fleet-member-next'); expect(f.find('fleet-member').text).toContain('2/2');
    f.click('fleet-prev'); expect(f.find('fleet-member').text).toContain('1/2'); f.click('fleet-next');
    const old = f.find('fleet-disband').listeners('pointerdown')[0] as () => void;
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(3);
    expect(f.spy.mock.calls[2][1]).toEqual({ kind: 'disbandFleet', factionId: 'blue', systemId: 'sol', expectedTurn: 1, fleetId: 2 });
    expect(f.find('fleet-current').text).toContain('1/1 · Группа #1'); expect(f.find('fleet-member').text).toContain('1/2');
    expect(f.find('fleet-count').text).toContain('У стороны: 1/20');
    f.click('fleet-disband'); expect(f.find('fleet-disband').interactive).toBe(false);
    expect(f.find('fleet-candidates-title').text).toContain(': 4');
    const next = f.spy.mock.results[3].value.state;
    expect(next.fleets).toEqual({ lastFleetId: 2, items: [] }); expect(next.ships).toEqual(f.state.ships);
  });

  it('shows group membership in travel, refuels a member and allows send only after UI disband', () => {
    const f = fleetFixture(2); f.state.ships[0].fuel = 1;
    f.selectTwo(); f.click('fleet-create'); f.click('production-travel');
    expect(f.find('travel-limit').text).toContain('Группа #1');
    f.click('travel-send'); expect(f.message()).toContain('сначала расформируйте');
    f.click('travel-refuel'); expect(f.find('travel-fuel').text).toContain('3/3');
    f.click('production-fleets'); expect(f.find('fleet-member-fuel').text).toContain('3/3');
    f.click('fleet-disband'); f.click('production-travel'); f.click('travel-send');
    expect(f.find('travel-transit').text).toContain('#1');
    f.click('production-fleets'); expect(f.find('fleet-candidates-title').text).toContain(': 1');
  });

  it('creates and disbands red groups without exposing blue groups or global counter', () => {
    const f = fleetFixture();
    f.state.ships.slice(2).forEach(ship => { ship.factionId = 'red'; ship.systemId = 'vega'; ship.design.name = 'Красный'; });
    f.selectTwo(); f.click('fleet-create'); f.click('campaign-end-turn'); f.click('campaign-side-switch');
    expect(f.nodes.some(n => !n.destroyed && n.name === 'fleet-panel')).toBe(false);
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-count').text).toContain('У стороны: 0/20');
    f.selectTwo(); f.click('fleet-create'); expect(f.find('fleet-current').text).toContain('Группа #2');
    expect(f.find('fleet-member').text).toContain('Красный');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'createFleet', factionId: 'red', expectedTurn: 2, systemId: 'vega', shipIds: [3, 4] });
    f.click('fleet-disband'); expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'disbandFleet', factionId: 'red', expectedTurn: 2, systemId: 'vega', fleetId: 2 });
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value.state.fleets.items).toHaveLength(1);
  });

  it('filters members, transit and other colonies out of candidates and shows colony-specific groups', () => {
    const f = fleetFixture(8);
    f.state.ships[2].transit = { destinationId: 'eden', remainingTurns: 1 };
    f.state.ships.slice(3, 6).forEach(ship => { ship.systemId = 'eden'; });
    f.state.fleets = { lastFleetId: 2, items: [
      { id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] },
      { id: 2, factionId: 'blue', systemId: 'eden', shipIds: [4, 5] }
    ] };
    f.click('production-fleets'); f.click('production-fleets');
    expect(f.find('fleet-candidates-title').text).toContain(': 2'); expect(f.find('fleet-candidate').text).toContain('#7');
    expect(f.find('fleet-count').text).toContain('КОЛОНИИ: 1 · У стороны: 2/20');
    f.click('fleet-select'); f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-candidate').text).toContain('#6'); expect(f.find('fleet-current').text).toContain('Группа #2');
    expect(f.find('fleet-selection-count').text).toContain('0/10');
  });

  it.each(['eden', 'rift', 'vega'])('does not expose group controls in unavailable colony %s', id => {
    const f = fixture(); f.click(`system-${id}`); f.click('campaign-production');
    expect(f.find('production-unavailable')).toBeDefined();
    expect(f.nodes.some(n => !n.destroyed && ['production-fleets', 'fleet-panel'].includes(n.name))).toBe(false);
  });

  it.each(['stale', 'vanished', 'moved', 'transit', 'grouped'] as const)('rejects changed captured membership: %s', change => {
    const f = fleetFixture(); f.selectTwo();
    if (change === 'stale') f.state.turn = 3;
    if (change === 'vanished') f.state.ships.shift();
    if (change === 'moved') f.state.ships[0].systemId = 'eden';
    if (change === 'transit') f.state.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 };
    if (change === 'grouped') f.state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 3] }] };
    const before = structuredClone(f.state); f.click('fleet-create');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ shipIds: [1, 2], expectedTurn: 1 });
    expect(f.spy.mock.results[0].value).toMatchObject({ ok: false, code: change === 'stale' ? 'STALE_TURN' : change === 'grouped' ? 'SHIP_IN_FLEET' : change === 'transit' ? 'SHIP_IN_TRANSIT' : 'SHIP_NOT_FOUND' });
    expect(f.state).toEqual(before);
    expect(f.find('fleet-selection-count').text).toContain(change === 'stale' ? '2/10' : '1/10');
  });

  it('shows missing captured group refusal, then refreshes empty group/member pages', () => {
    const f = fleetFixture();
    f.state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] }] };
    f.click('production-fleets'); f.click('production-fleets'); f.state.fleets.items = [];
    f.click('fleet-disband'); expect(f.message()).toContain('Своя группа не найдена');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ fleetId: 1 }); expect(f.find('fleet-disband').interactive).toBe(false);
    expect(f.find('fleet-member').text).toBe('Нет участников для просмотра.');
  });

  it('keeps inactive create/disband clickable for domain refusal and clears selection on successful endTurn', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('campaign-end-turn');
    expect(f.find('fleet-selection-count').text).toContain('0/10');
    f.click('fleet-candidate-prev'); f.selectTwo(); f.click('fleet-create'); expect(f.message()).toBe('Сейчас ход другой стороны');
    expect(f.find('fleet-selection-count').text).toContain('2/10'); f.click('fleet-disband'); expect(f.message()).toBe('Сейчас ход другой стороны');
  });

  it.each(['fleet-limit', 'id-limit'] as const)('shows domain %s without clearing the valid draft', limit => {
    const f = fleetFixture(42);
    if (limit === 'fleet-limit') f.state.fleets = { lastFleetId: 20, items: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, factionId: 'blue', systemId: 'sol', shipIds: [i * 2 + 1, i * 2 + 2] })) };
    else f.state.fleets.lastFleetId = 1_000_000_000;
    f.click('production-fleets'); f.click('production-fleets'); f.selectTwo();
    expect(f.find('fleet-create').interactive).toBe(true); f.click('fleet-create');
    expect(f.spy.mock.results[0].value).toMatchObject({ ok: false, code: limit === 'fleet-limit' ? 'FLEET_LIMIT' : 'FLEET_ID_LIMIT' });
    expect(f.find('fleet-selection-count').text).toContain('2/10');
  });

  it.each(['fleet-clear', 'fleet-candidate-prev', 'production-fleets', 'production-travel', 'campaign-production', 'campaign-side-switch', 'campaign-new'])('makes old create inert after %s', action => {
    const f = fleetFixture(); f.selectTwo(); const old = f.find('fleet-create').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('blocks all group controls while pending, restores draft on cancel, then ESC closes one layer', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create'); f.click('fleet-candidate-prev'); f.selectTwo();
    f.click('campaign-new');
    for (const name of ['fleet-select', 'fleet-create', 'fleet-clear', 'fleet-disband', 'fleet-candidate-prev', 'fleet-next', 'fleet-member-next', 'production-fleets', 'production-travel']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    expect(f.spy).toHaveBeenCalledTimes(1);
    f.keyboard.emit('keydown-ESC'); expect(f.find('fleet-selection-count').text).toContain('2/10');
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-enqueue')).toBeDefined();
    f.click('production-fleets'); expect(f.find('fleet-selection-count').text).toContain('0/10');
    f.keyboard.emit('keydown-ESC'); f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
  });

  it('destroys group callbacks on reset/exit and reenters with one handler, empty groups and draft', () => {
    const f = fleetFixture(); f.selectTwo(); f.click('fleet-create');
    const old = f.find('fleet-disband').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); f.click('campaign-confirm'); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    f.click('campaign-production'); f.click('production-fleets'); expect(f.find('fleet-count').text).toContain('0/20');
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production'); f.click('production-fleets');
    expect(f.find('fleet-selection-count').text).toContain('0/10'); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'fleet-panel')).toHaveLength(1);
  });

  it('fits long member/candidate names and large IDs without changing snapshots', () => {
    const f = fleetFixture(2); const name = `Ш\n${'Ш'.repeat(78)}`;
    f.state.production.lastOrderId = 1_000_000_000;
    f.state.ships.forEach((ship, i) => { ship.id = 999999999 + i; ship.design.name = name; });
    f.state.fleets.lastFleetId = 999999999;
    f.click('production-fleets'); f.click('production-fleets');
    expect(f.find('fleet-candidate').text).toMatch(/#999999999 Ш Ш.*…$/); expect(f.find('fleet-candidate').width).toBeLessThanOrEqual(745);
    f.selectTwo(); f.click('fleet-create');
    expect(f.find('fleet-current').text).toContain('#1000000000'); expect(f.find('fleet-current').width).toBeLessThanOrEqual(540);
    expect(f.find('fleet-member').text).toMatch(/#999999999 Ш Ш.*…$/); expect(f.find('fleet-member').width).toBeLessThanOrEqual(590);
    expect(f.spy.mock.results[0].value.state.ships.every((ship: { design: { name: string } }) => ship.design.name === name)).toBe(true);
  });

  it('keeps grouped ships visible and individually refuelable, but shows the grouped-send refusal', () => {
    const f = refuelFixture(2);
    f.state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: 'blue', systemId: 'sol', shipIds: [1, 2] }] };
    const before = structuredClone(f.state);
    f.click('travel-send'); expect(f.message()).toContain('сначала расформируйте');
    expect(f.state).toEqual(before); expect(f.find('travel-ship').text).toContain('#1');
    expect(f.find('travel-count').text).toContain('2/100');
    f.click('travel-refuel'); expect(f.find('travel-fuel').text).toContain('3/3');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value.state.fleets).toEqual(before.fleets);
    f.click('travel-send'); expect(f.message()).toContain('сначала расформируйте');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    f.click('campaign-new'); f.click('campaign-confirm');
    f.click('campaign-end-turn');
    expect(f.spy.mock.results[f.spy.mock.results.length - 1].value.state.fleets).toEqual({ lastFleetId: 0, items: [] });
  });

  it('shows each stationed tank and full price, including a disabled full tank', () => {
    const f = refuelFixture();
    for (const [fuel, price] of [[0, '15 кр. / 6 мин.'], [1, '10 кр. / 4 мин.'], [2, '5 кр. / 2 мин.']] as const) {
      expect(f.find('travel-fuel').text).toContain(`Топливо: ${fuel}/3`);
      expect(f.find('travel-refuel-quote').text).toContain(price);
      expect(f.find('travel-refuel').interactive).toBe(true);
      if (fuel < 2) f.click('travel-ships-next');
    }
    f.click('travel-refuel');
    expect(f.find('travel-fuel').text).toContain('3/3 · Бак полон');
    expect(f.find('travel-refuel-quote').text).toContain('+0 · Цена: 0 кр. / 0 мин.');
    expect(f.find('travel-refuel').interactive).toBe(false);
    f.click('travel-refuel'); expect(f.spy).toHaveBeenCalledTimes(1);
  });

  it('refuels the captured displayed ID once, preserving page, snapshot, turn and catalog', () => {
    const f = refuelFixture(), reads = f.load.mock.calls.length;
    f.click('travel-ships-next');
    const old = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    const before = structuredClone(f.state);
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 2 });
    const next = f.spy.mock.results[0].value.state as domain.CampaignSession;
    expect(next).toEqual({ ...before, ships: before.ships.map(ship => ship.id === 2 ? { ...ship, fuel: 3 } : ship),
      treasuries: { ...before.treasuries, blue: { credits: before.treasuries.blue.credits - 10, minerals: before.treasuries.blue.minerals - 4 } } });
    expect(f.find('travel-ship').text).toContain('2/3 · #2');
    expect(f.find('campaign-treasury').text).toContain(`Кредиты: ${next.treasuries.blue.credits}`);
    expect(f.message()).toBe('Корабль заправлен. Ресурсы списаны.'); expect(f.load).toHaveBeenCalledTimes(reads);
    expect(f.state).toEqual(before);
  });

  it.each(['credits', 'minerals'] as const)('keeps an affordable-looking refuel atomic when %s is insufficient', resource => {
    const f = refuelFixture(1); f.state.treasuries.blue[resource] = 0;
    const before = structuredClone(f.state); f.click('travel-refuel');
    expect(f.message()).toBe('Недостаточно ресурсов для полной заправки');
    expect(f.state).toEqual(before); expect(f.find('travel-fuel').text).toContain('0/3');
    expect(f.find('travel-refuel-quote').text).toContain('15 кр. / 6 мин.');
  });

  it('refuels even without an adjacent destination, but not without a stationed ship', () => {
    const f = refuelFixture(1); f.state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-send').interactive).toBe(false); expect(f.find('travel-refuel').interactive).toBe(true);
    f.click('travel-refuel'); expect(f.find('travel-fuel').text).toContain('3/3');
  });

  it('never offers refuel for a travelling ship and refreshes fuel on arrival at the target', () => {
    const f = refuelFixture(1); f.click('travel-refuel'); f.click('travel-send');
    expect(f.find('travel-refuel').interactive).toBe(false);
    expect(f.find('travel-fuel').text).toBe('Топливо: нет выбранного корабля');
    expect(f.find('travel-refuel-quote').text).toContain('недоступна');
    f.click('travel-refuel'); expect(f.spy).toHaveBeenCalledTimes(2);
    f.click('campaign-end-turn'); f.click('campaign-production'); f.click('system-eden');
    f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-fuel').text).toContain('2/3');
    expect(f.find('travel-refuel-quote').text).toContain('5 кр. / 2 мин.');
    f.click('travel-refuel'); expect(f.message()).toBe('Сейчас ход другой стороны');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('production-travel');
    f.click('travel-refuel');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'refuelShip', factionId: 'blue', expectedTurn: 3, systemId: 'eden', shipId: 1 });
    expect(f.find('travel-fuel').text).toContain('3/3');
  });

  it.each(['stale', 'vanished', 'moved', 'transit', 'full'] as const)('rejects a changed captured ship: %s, never refuels a replacement', change => {
    const f = refuelFixture();
    if (change === 'stale') f.state.turn = 3;
    if (change === 'vanished') f.state.ships.shift();
    if (change === 'moved') f.state.ships[0].systemId = 'eden';
    if (change === 'transit') f.state.ships[0].transit = { destinationId: 'eden', remainingTurns: 1 };
    if (change === 'full') f.state.ships[0].fuel = 3;
    const before = structuredClone(f.state); f.click('travel-refuel');
    expect(f.spy.mock.calls[0][1]).toMatchObject({ expectedTurn: 1, shipId: 1, systemId: 'sol' });
    expect(f.spy.mock.results[0].value).toMatchObject({ ok: false, code: change === 'stale' ? 'STALE_TURN'
      : change === 'full' ? 'FUEL_FULL' : change === 'transit' ? 'SHIP_IN_TRANSIT' : 'SHIP_NOT_FOUND' });
    expect(f.state).toEqual(before);
  });

  it('switches to red fuel/price and refuels red without exposing blue ships', () => {
    const f = refuelFixture(1); f.state.production.lastOrderId = 2;
    f.state.ships.push({ ...structuredClone(f.state.ships[0]), id: 2, factionId: 'red', systemId: 'vega', fuel: 2,
      design: { ...f.choices[0].design, name: 'Красный бак' } });
    f.click('campaign-end-turn'); f.click('campaign-side-switch');
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-refuel')).toHaveLength(0);
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-fuel').text).toContain('2/3'); expect(f.find('travel-refuel-quote').text).toContain('5 кр. / 2 мин.');
    f.click('travel-refuel'); expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toEqual({ kind: 'refuelShip', factionId: 'red', expectedTurn: 2, systemId: 'vega', shipId: 2 });
    const next = f.spy.mock.results[f.spy.mock.results.length - 1].value.state as domain.CampaignSession;
    expect(next.ships[0].fuel).toBe(0); expect(next.ships[1].fuel).toBe(3);
    expect(next.treasuries.red).toEqual({ credits: f.state.treasuries.red.credits - 5, minerals: f.state.treasuries.red.minerals - 2 });
    f.click('campaign-side-switch'); f.click('campaign-production'); f.click('system-sol'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-fuel').text).toContain('0/3');
    expect(f.nodes.some(n => !n.destroyed && n.text.includes('Красный бак'))).toBe(false);
  });

  it.each(['travel-ships-next', 'production-travel', 'campaign-production', 'campaign-side-switch', 'campaign-new'])('old refuel is inert after %s', action => {
    const f = refuelFixture(), old = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('blocks refuel during confirmations and destroys it on ESC, reset, exit and reentry', () => {
    const f = refuelFixture(), old = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    f.click('campaign-new'); expect(f.find('travel-refuel').interactive).toBe(false);
    f.click('travel-refuel'); old(); expect(f.spy).not.toHaveBeenCalled();
    f.keyboard.emit('keydown-ESC'); expect(f.find('travel-refuel').interactive).toBe(true);
    const closing = f.find('travel-refuel').listeners('pointerdown')[0] as () => void;
    f.keyboard.emit('keydown-ESC'); closing(); expect(f.spy).not.toHaveBeenCalled();
    f.click('production-travel'); f.click('campaign-new'); f.click('campaign-confirm');
    f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-refuel').interactive).toBe(false); expect(f.find('travel-fuel').text).toContain('нет выбранного');
    f.click('campaign-menu'); f.click('campaign-confirm'); old(); closing();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production'); f.click('production-travel'); old();
    expect(f.find('travel-refuel').interactive).toBe(false); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-panel')).toHaveLength(1);
  });

  it('keeps fuel/price independent of a long name and clamps after the selected ship disappears', () => {
    const f = refuelFixture(), name = 'Ш'.repeat(80);
    f.state.ships[2].design.name = name; f.click('travel-ships-next'); f.click('travel-ships-next');
    expect(f.find('travel-ship').width).toBeLessThanOrEqual(745);
    expect(f.find('travel-fuel').text).toContain('2/3'); expect(f.find('travel-refuel-quote').width).toBeLessThanOrEqual(570);
    f.click('travel-refuel'); expect(f.spy.mock.results[0].value.state.ships[2].design.name).toBe(name);
    f.click('travel-send'); expect(f.find('travel-ship').text).toContain('2/2 · #2');
    expect(f.find('travel-fuel').text).toContain('1/3'); expect(f.find('travel-refuel-quote').text).toContain('10 кр. / 4 мин.');
  });

  it('sends exactly the displayed ship and destination with captured turn without charging', () => {
    const f = travelFixture(); f.click('travel-ships-next');
    const old = f.find('travel-send').listeners('pointerdown')[0] as () => void;
    const treasury = f.find('campaign-treasury').text;
    old(); old(); expect(f.spy).toHaveBeenCalledTimes(1);
    expect(f.spy.mock.calls[0][1]).toEqual({ kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 2, destinationId: 'eden' });
    expect(f.find('travel-ship').text).toContain('2/2 · #3');
    expect(f.find('travel-transit').text).toContain('#2 Готовый 2');
    expect(f.find('travel-route').text).toContain('Сол → Эдем');
    expect(f.find('campaign-treasury').text).toBe(treasury); expect(f.find('campaign-turn').text).toContain('Ход 1');
    expect(f.message()).toContain('Корабль отправлен');
  });

  it('clamps ship/trip pages, selects the new trip and disables sends after all depart', () => {
    const f = travelFixture(); f.click('travel-ships-next'); f.click('travel-ships-next'); f.click('travel-send');
    expect(f.find('travel-ship').text).toContain('2/2 · #2'); expect(f.find('travel-transit').text).toContain('#3');
    f.click('travel-send'); expect(f.find('travel-transit').text).toContain('#2');
    f.click('travel-send'); expect(f.find('travel-send').interactive).toBe(false);
    const calls = f.spy.mock.calls.length; f.click('travel-send'); expect(f.spy).toHaveBeenCalledTimes(calls);
    expect(f.find('travel-ships-prev').interactive).toBe(false); expect(f.find('travel-ships-next').interactive).toBe(false);
    expect(f.find('travel-transit').text).toContain('1/3 · #1');
    f.click('travel-transit-next'); f.click('travel-transit-next'); expect(f.find('travel-transit').text).toContain('3/3 · #3');
    expect(f.find('travel-transit-next').interactive).toBe(false);
    f.click('travel-transit-prev'); expect(f.find('travel-transit').text).toContain('2/3 · #2');
    f.click('campaign-end-turn'); expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.find('travel-transit-prev').interactive).toBe(false);
  });

  it('shows arrival in target and sends back along the reverse lane on the next own turn', () => {
    const f = travelFixture(1); f.click('travel-send'); f.click('campaign-end-turn');
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch');
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-ship').text).toContain('#1'); expect(f.find('travel-destination').text).toBe('Цель 1/1: Сол');
    f.click('travel-send'); expect(f.find('travel-route').text).toContain('Эдем → Сол');
    expect(f.spy.mock.calls[f.spy.mock.calls.length - 1][1]).toMatchObject({ expectedTurn: 3, systemId: 'eden', destinationId: 'sol' });
  });

  it('offers only neighbouring own colonies, supports destination paging and resets selection', () => {
    const f = travelFixture(1); const nexus = f.state.galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'blue'; nexus.exploredBy = ['blue']; f.state.ships[0].systemId = 'eden';
    f.click('campaign-production'); f.click('system-eden'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-destination').text).toBe('Цель 1/2: Сол');
    f.click('travel-destination-next'); expect(f.find('travel-destination').text).toBe('Цель 2/2: Узел');
    expect(f.find('travel-destination-next').interactive).toBe(false);
    f.click('travel-destination-prev'); expect(f.find('travel-destination').text).toContain('Сол');
    f.click('travel-destination-next'); f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-destination').text).toContain('Сол');
    f.click('travel-destination-next'); f.click('travel-send'); expect(f.find('travel-route').text).toContain('Эдем → Узел');
  });

  it.each(['neutral', 'enemy', 'unknown'] as const)('disables travel without a valid neighbouring own destination: %s', kind => {
    const f = travelFixture(1), eden = f.state.galaxy.systems.find(s => s.id === 'eden')!;
    eden.ownerId = kind === 'enemy' ? 'red' : null;
    eden.exploredBy = kind === 'unknown' ? [] : kind === 'enemy' ? ['red', 'blue'] : ['blue'];
    f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-destination').text).toBe('Нет соседних собственных колоний.');
    expect(f.find('travel-send').interactive).toBe(false); f.click('travel-send'); expect(f.spy).not.toHaveBeenCalled();
  });

  it('does not permit sending ready records without deployed ships', () => {
    const f = deploymentFixture(1); f.click('production-travel');
    expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
    expect(f.find('travel-send').interactive).toBe(false);
  });

  it('shows inactive rejection without removing the ship or creating a trip', () => {
    const f = travelFixture(1); f.click('campaign-end-turn'); f.click('travel-send');
    expect(f.message()).toBe('Сейчас ход другой стороны'); expect(f.find('travel-ship').text).toContain('#1');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
  });

  it('shows stale or vanished ship errors rather than selecting a replacement', () => {
    const f = travelFixture(); f.state.turn = 3; f.click('travel-send');
    expect(f.message()).toContain('Номер хода изменился'); expect(f.spy.mock.calls[0][1]).toMatchObject({ expectedTurn: 1 });
    f.state.ships.shift(); f.click('travel-send'); expect(f.message()).toContain('Свой корабль не найден');
    expect(f.find('travel-ship').text).toContain('#2');
  });

  it('domain rejects a captured destination which is no longer owned', () => {
    const f = travelFixture(1); f.state.galaxy.systems.find(s => s.id === 'eden')!.ownerId = null;
    f.click('travel-send'); expect(f.message()).toBe('Перелёт доступен только в свою колонию');
    expect(f.find('travel-send').interactive).toBe(false); expect(f.find('travel-ship').text).toContain('#1');
  });

  it('keeps the trip visible when endTurn overflows and when an opponent ends their turn', () => {
    const f = travelFixture(1); f.click('travel-send');
    const current = f.spy.mock.results[0].value.state as domain.CampaignSession;
    current.treasuries.blue.credits = domain.MAX_RESOURCE;
    f.click('campaign-end-turn'); expect(f.message()).toContain('Доход превысит предел');
    expect(f.find('travel-route').text).toContain('Сол → Эдем');
    current.treasuries.blue.credits = 0; current.turn = 2;
    f.click('campaign-side-switch'); f.click('campaign-end-turn'); f.click('campaign-side-switch'); f.click('production-travel');
    expect(f.find('travel-transit').text).toContain('#1');
  });

  it('renders only red ships/routes after switching and sends red to its own neighbour', () => {
    const f = travelFixture(1), nexus = f.state.galaxy.systems.find(s => s.id === 'nexus')!;
    nexus.ownerId = 'red'; nexus.exploredBy = ['red', 'blue'];
    f.state.production.lastOrderId = 2;
    f.state.ships.push({ ...structuredClone(f.state.ships[0]), id: 2, factionId: 'red', systemId: 'vega', design: { ...f.choices[0].design, name: 'Красный' } });
    f.click('campaign-end-turn'); f.click('campaign-side-switch');
    expect(f.nodes.filter(n => !n.destroyed).some(n => n.name.startsWith('travel-'))).toBe(false);
    f.click('campaign-production'); f.click('system-vega'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-ship').text).toContain('#2 Красный'); expect(f.find('travel-count').text).toContain('1/100');
    f.click('travel-send'); expect(f.find('travel-route').text).toContain('Вега → Узел');
    f.click('campaign-side-switch'); f.click('campaign-production'); f.click('system-sol'); f.click('campaign-production'); f.click('production-travel');
    expect(f.find('travel-transit').text).toBe('Кораблей в пути нет.');
    expect(f.nodes.filter(n => !n.destroyed).some(n => n.text.includes('Красный'))).toBe(false);
  });

  it.each(['travel-ships-next', 'production-travel', 'campaign-production', 'campaign-side-switch', 'campaign-new'])('old send callback is inert after %s', action => {
    const f = travelFixture(), old = f.find('travel-send').listeners('pointerdown')[0] as () => void;
    f.click(action); old(); expect(f.spy).not.toHaveBeenCalled();
  });

  it('blocks all travel controls while pending and ESC closes one level at a time', () => {
    const f = travelFixture(); f.click('travel-send'); f.click('travel-send'); f.click('campaign-new');
    for (const name of ['travel-send', 'travel-ships-next', 'travel-destination-next', 'travel-transit-prev', 'travel-transit-next', 'production-travel']) {
      expect(f.find(name).interactive).toBe(false); f.click(name);
    }
    expect(f.spy).toHaveBeenCalledTimes(2);
    f.keyboard.emit('keydown-ESC'); expect(f.find('travel-transit')).toBeDefined();
    f.keyboard.emit('keydown-ESC'); expect(f.find('production-enqueue')).toBeDefined();
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-panel')).toHaveLength(0);
    f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined(); expect(f.start).not.toHaveBeenCalled();
  });

  it('clears travel state and callbacks on reset and shutdown/reentry', () => {
    const f = travelFixture(), old = f.find('travel-send').listeners('pointerdown')[0] as () => void;
    f.click('travel-ships-next'); f.click('travel-send'); f.click('campaign-new'); f.click('campaign-confirm'); old();
    expect(f.spy).toHaveBeenCalledTimes(1);
    f.click('campaign-production'); f.click('production-travel'); expect(f.find('travel-count').text).toContain('0/100');
    f.click('campaign-menu'); f.click('campaign-confirm'); old();
    expect(f.nodes.every(n => n.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
    f.scene.create(); f.click('campaign-production'); f.click('production-travel'); old();
    expect(f.find('travel-ship').text).toBe('Нет кораблей для отправки.');
    expect(f.nodes.filter(n => !n.destroyed && n.name === 'travel-panel')).toHaveLength(1);
    expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
  });

  it('fits large IDs and long names without modifying the snapshot in either list', () => {
    const f = travelFixture(1), name = `Ш\n${'Ш'.repeat(78)}`;
    f.state.production.lastOrderId = 999999999; f.state.ships[0].id = 999999999; f.state.ships[0].design.name = name;
    f.click('production-travel'); f.click('production-travel');
    expect(f.find('travel-ship').width).toBeLessThanOrEqual(745); expect(f.find('travel-ship').text).toMatch(/#999999999 Ш Ш.*…$/);
    f.click('travel-send'); expect(f.find('travel-transit').width).toBeLessThanOrEqual(745);
    expect(f.spy.mock.results[0].value.state.ships[0].design.name).toBe(name);
  });

  describe('S3.21 budget UI', () => {
    type Harness = ReturnType<typeof fixture>;
    // Diagnostic access only: these bounded fixtures are not the paid acceptance cycles above.
    const runtime = (f: Harness) => f.scene as unknown as {
      campaign: domain.CampaignSession; budgetOpen: boolean; productionOpen: boolean;
      travelOpen: boolean; fleetsOpen: boolean; fleetTravelOpen: boolean;
      fleetShipIds: number[]; fleetCandidatePage: number; fleetPage: number; fleetMemberPage: number;
      fleetDestinationIndex: number; fleetTransitPage: number;
      render: () => void; execute: (command: domain.SessionCommand) => void;
    };
    const live = (f: Harness, name: string) => f.nodes.filter(node => !node.destroyed && node.name === name);
    const capture = (f: Harness, name: string) => {
      const callback = f.find(name).listeners('pointerdown')[0] as () => void;
      expect(callback).toBeTypeOf('function'); return callback;
    };
    const successFields = ['budget-ships', 'budget-due', 'budget-paid', 'budget-shortfall', 'budget-after'];
    const budgetText = (f: Harness) => f.nodes.filter(node => !node.destroyed && node.name.startsWith('budget-'))
      .map(node => [node.name, node.text]);
    const currentView = (f: Harness, side: 'blue' | 'red' = 'blue') => domain.getCampaignSessionView(runtime(f).campaign, side);
    function freeze<T>(value: T): T {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(child => freeze(child)); Object.freeze(value);
      }
      return value;
    }
    function diagnosticState(blue = 0, red = 0) {
      const state = domain.createCampaignSession(), design = createCombatDesign('fighter');
      state.production.lastOrderId = blue + red;
      state.ships = Array.from({ length: blue + red }, (_, index) => ({ id: index + 1,
        factionId: index < blue ? 'blue' : 'red', systemId: index < blue ? 'sol' : 'vega',
        fuel: index % 4, design: structuredClone(design) }));
      return state;
    }
    function budgetFixture(state = domain.createCampaignSession()) {
      expect(domain.campaignSessionSchema.safeParse(state).success).toBe(true);
      seedSession(state);
      const commands = observeRunCommands();
      const load = vi.spyOn(catalog, 'loadProductionCatalog');
      return { ...fixture(), state, commands, load };
    }
    function expectProjection(f: Harness, view: domain.CampaignSessionView) {
      expect(f.find('budget-title').text).toBe(`БЮДЖЕТ · ${view.galaxy.factionId === 'blue' ? 'Синий союз' : 'Красная лига'}`);
      expect(f.find('budget-context').text).toBe(view.activeFactionId === view.galaxy.factionId
        ? 'Прогноз завершения текущего хода' : 'Условный прогноз своего хода · сейчас ход другой стороны');
      expect(f.find('budget-treasury').text).toBe(`Сейчас: ${view.treasury.credits} кр. / ${view.treasury.minerals} мин.`);
      expect(f.find('budget-income').text).toBe(`Валовой доход: +${view.income.credits} кр. / +${view.income.minerals} мин.`);
      const forecast = view.economyForecast;
      if (!forecast.ok) {
        expect(f.find('budget-error').text).toBe(forecast.code === 'TURN_LIMIT'
          ? 'TURN_LIMIT: достигнут предел номера хода. Расчёт не будет выполнен.'
          : 'RESOURCE_LIMIT: валовой доход превысит предел ресурсов. Списание не исправляет переполнение.');
        for (const name of successFields) expect(live(f, name), name).toHaveLength(0);
      } else {
        expect(live(f, 'budget-error')).toHaveLength(0);
        expect(f.find('budget-ships').text).toBe(`Кораблей на содержании: ${forecast.upkeep.shipCount}`);
        expect(f.find('budget-due').text).toBe(`Начислено: ${forecast.upkeep.dueCredits} кр.`);
        expect(f.find('budget-paid').text).toBe(`Будет списано: ${forecast.upkeep.paidCredits} кр.`);
        expect(f.find('budget-shortfall').text).toBe(`Дефицит: ${forecast.upkeep.shortfallCredits} кр. (без долга)`);
        expect(f.find('budget-after').text).toBe(`Остаток после расчёта: ${forecast.treasuryAfter.credits} кр. / ${forecast.treasuryAfter.minerals} мин.`);
        expect(f.find('budget-rule').text).toContain('груп');
        expect(f.find('budget-rule').text).toContain('перелёт');
        expect(f.find('budget-rule').text).toContain('не долг');
        expect(f.find('budget-note').text).toBe('Это прогноз, не квитанция. Фактический платёж — в сообщении справа.');
      }
    }
    function expectExclusiveBudget(f: Harness) {
      expect(runtime(f).budgetOpen).toBe(true);
      expect(live(f, 'campaign-budget-panel')).toHaveLength(1);
      expect(live(f, 'production-panel')).toHaveLength(0);
      expect(f.nodes.filter(node => !node.destroyed && node.name.startsWith('system-'))).toHaveLength(0);
    }

    describe('S3.22 integrated diagnostic budget turns (not earned cycles)', () => {
      function integrated(side: 'blue' | 'red') {
        // Deliberately preloaded limit fleet and paid FIFO; all commands/results below are real.
        const enemy: 'blue' | 'red' = side === 'blue' ? 'red' : 'blue';
        const home: 'sol' | 'vega' = side === 'blue' ? 'sol' : 'vega';
        const target = side === 'blue' ? 'eden' : 'nexus', enemyTarget = side === 'blue' ? 'nexus' : 'eden';
        const state = diagnosticState(side === 'blue' ? 100 : 3, side === 'red' ? 100 : 3);
        state.turn = side === 'blue' ? 1 : 2;
        for (const [id, faction] of [[target, side], [enemyTarget, enemy]] as const) {
          const colony = state.galaxy.systems.find(system => system.id === id)!;
          colony.ownerId = faction; colony.exploredBy = [faction];
        }
        const ownIds = state.ships.filter(ship => ship.factionId === side).map(ship => ship.id);
        const enemyIds = state.ships.filter(ship => ship.factionId === enemy).map(ship => ship.id);
        for (const ship of state.ships) {
          ship.fuel = 0;
          if (ownIds.slice(0, 3).includes(ship.id)) ship.fuel = 1;
          if (ship.factionId === enemy) ship.transit = { destinationId: enemyTarget, remainingTurns: 1 };
        }
        state.fleets = { lastFleetId: 1, items: [{ id: 1, factionId: enemy,
          systemId: side === 'blue' ? 'vega' : 'sol', shipIds: enemyIds.slice(0, 2) }] };
        const record: domain.CampaignSession['production']['completed'][number] = {
          id: 104, factionId: side, systemId: home, design: structuredClone(state.ships[0].design)
        };
        state.production = { lastOrderId: 107, orders: [
          { ...structuredClone(record), remainingTurns: 1 },
          { ...structuredClone(record), id: 105, remainingTurns: 4 },
          { ...structuredClone(record), id: 106, factionId: enemy, systemId: side === 'blue' ? 'vega' : 'sol', remainingTurns: 1 }
        ], completed: [{ ...structuredClone(record), id: 107 }] };
        state.treasuries[side] = { credits: 5, minerals: 5 };
        const f = budgetFixture(freeze(state)), current = () => runtime(f).campaign;
        if (side === 'red') f.click('campaign-side-switch');
        f.click('campaign-budget');
        const execute = (command: domain.SessionCommand) => {
          const input = freeze(current()), before = structuredClone(input), calls = f.commands.mock.calls.length;
          runtime(f).execute(command);
          expect(f.commands).toHaveBeenCalledTimes(calls + 1);
          expect(f.commands.mock.calls[calls]).toEqual([before, command]);
          const result = f.commands.mock.results[calls].value as domain.SessionResult;
          expect(result.ok).toBe(true); if (!result.ok) throw Error(result.message);
          expect(current()).toBe(result.state); expect(input).toEqual(before);
          expectExclusiveBudget(f); return result;
        };
        const treasury = structuredClone(current().treasuries);
        for (const command of [
          { kind: 'createFleet', shipIds: ownIds.slice(0, 2) },
          { kind: 'sendFleet', fleetId: 2, destinationId: target },
          { kind: 'sendShip', shipId: ownIds[2], destinationId: target }
        ] as const) {
          const result = execute({ ...command, factionId: side, expectedTurn: state.turn, systemId: home });
          expect(result).not.toHaveProperty('endTurnEconomy');
          expect(current().treasuries).toEqual(treasury);
          expectBudgetOracle(f, current(), side, 100, 2);
        }
        const assertAdvance = (before: domain.CampaignSession) => {
          const { remainingTurns: _remaining, ...completed } = before.production.orders[0];
          expect(current().production).toEqual({ lastOrderId: 107, orders: before.production.orders.slice(1),
            completed: [...before.production.completed, completed] });
          expect(current().production.orders.find(order => order.id === 105)?.remainingTurns).toBe(4);
          expect(current().ships).toEqual(before.ships.map(ship => {
            if (ship.factionId !== side || !ship.transit) return ship;
            const { transit, ...stationary } = ship; return { ...stationary, systemId: transit.destinationId };
          }));
          expect(current().fleets).toEqual({ ...before.fleets, items: before.fleets.items.map(fleet =>
            fleet.factionId === side ? { ...fleet, systemId: target } : fleet) });
          expect(current().ships.filter(ship => ship.factionId === side && ship.systemId === target)).toHaveLength(3);
          expect(current().ships).toHaveLength(103); expect(current().turn).toBe(before.turn + 1);
          expect(domain.getCampaignSessionView(current(), enemy)).toEqual({ ...domain.getCampaignSessionView(before, enemy),
            turn: before.turn + 1, activeFactionId: enemy });
          expect(current().ships.map(ship => ship.design)).toEqual(before.ships.map(ship => ship.design));
          expect(domain.campaignSessionSchema.safeParse(current()).success).toBe(true);
          expect(f.load).not.toHaveBeenCalled();
        };
        return { f, current, execute, assertAdvance, side, enemy, home, ownIds } as const;
      }

      it.each(['blue', 'red'] as const)('settles %s deficit with FIFO, grouped/free arrivals, pending guards and no carried debt', side => {
        const { f, current, execute, assertAdvance, enemy } = integrated(side);
        try {
          const forecast = expectBudgetOracle(f, current(), side, 100, 2);
          expect(forecast.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 25, shortfallCredits: 75 });
          const before = structuredClone(current()), input = freeze(current());
          const oldEnd = capture(f, 'campaign-end-turn'), oldBudget = capture(f, 'campaign-budget');
          const calls = f.commands.mock.calls.length;
          f.click('campaign-new');
          for (const name of ['campaign-end-turn', 'campaign-budget', 'campaign-side-switch', 'campaign-production']) {
            expect(f.find(name).interactive).toBe(false); f.click(name);
          }
          oldEnd(); oldBudget(); expect(f.commands).toHaveBeenCalledTimes(calls); expect(current()).toBe(input);
          f.click('campaign-cancel'); expectBudgetOracle(f, current(), side, 100, 2);
          f.click('campaign-end-turn'); oldEnd(); oldBudget();
          expect(f.commands).toHaveBeenCalledTimes(calls + 1); expect(input).toEqual(before);
          const result = f.commands.mock.results[calls].value as domain.SessionResult;
          if (!result.ok) throw Error(result.message);
          const { ok: _ok, ...predicted } = forecast;
          expect(result.endTurnEconomy).toEqual({ ...predicted, factionId: side, turn: before.turn });
          expect(current()).toBe(result.state); expect(current().treasuries[side]).toEqual({ credits: 0, minerals: 15 });
          assertAdvance(before); expectExclusiveBudget(f);
          const next = expectBudgetOracle(f, current(), side, 100, 2);
          expect(next.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 20, shortfallCredits: 80 });
          const receipt = 'Ход передан. Доход: +20 кр. / +10 мин. Содержание: 25/100 кр. Дефицит: 75 кр. (без долга).';
          expect(f.message()).toBe(receipt);
          f.click('campaign-budget'); expect(f.message()).toBe(receipt);
          f.click('campaign-budget'); expect(f.message()).toBe(receipt);
          const settled = current(); f.click('campaign-end-turn');
          expect(f.commands.mock.results.at(-1)?.value).toMatchObject({ ok: false, code: 'NOT_ACTIVE_FACTION' });
          expect(current()).toBe(settled); expectBudgetOracle(f, current(), side, 100, 2);
          f.click('campaign-side-switch'); expectBudgetOracle(f, current(), enemy, 3, 2);
          f.click('campaign-end-turn'); f.click('campaign-side-switch');
          expect(current().treasuries[side]).toEqual({ credits: 0, minerals: 15 });
          expectBudgetOracle(f, current(), side, 100, 2);
          const repeated = execute({ kind: 'endTurn', factionId: side, expectedTurn: current().turn });
          expect(repeated.endTurnEconomy?.upkeep).toEqual({ shipCount: 100, dueCredits: 100, paidCredits: 20, shortfallCredits: 80 });
          expect(current().treasuries[side]).toEqual({ credits: 0, minerals: 25 });
          expect(current().production.orders.find(order => order.id === 105)?.remainingTurns).toBe(3);
          expect(current().ships.filter(ship => ship.factionId === side)).toEqual(settled.ships.filter(ship => ship.factionId === side));
          expect(f.load).not.toHaveBeenCalled();
        } finally { f.events.emit('shutdown'); }
      });

      it.each([
        { side: 'blue', resource: 'credits' }, { side: 'red', resource: 'credits' },
        { side: 'blue', resource: 'minerals' }, { side: 'red', resource: 'minerals' }
      ] as const)('rejects gross $resource cap atomically for $side and recovers through real refuelling', ({ side, resource }) => {
        const { f, current, execute, assertAdvance, home, ownIds } = integrated(side);
        try {
          const fields = successFields.map(name => f.find(name));
          // Explicit diagnostic boundary, not earned funds. Gross exceeds cap by one;
          // for credits the hypothetical post-upkeep balance would fit, but must still fail.
          current().treasuries[side] = { credits: 100, minerals: 50 };
          current().treasuries[side][resource] = domain.MAX_RESOURCE - (resource === 'credits' ? 19 : 9);
          runtime(f).render(); expectProjection(f, currentView(f, side));
          expect(currentView(f, side).economyForecast).toEqual({ ok: false, code: 'RESOURCE_LIMIT' });
          expect(fields.every(node => node.destroyed)).toBe(true);
          const input = freeze(current()), before = structuredClone(input), calls = f.commands.mock.calls.length;
          const oldEnd = capture(f, 'campaign-end-turn');
          f.click('campaign-end-turn'); oldEnd();
          expect(f.commands).toHaveBeenCalledTimes(calls + 1);
          const failure = f.commands.mock.results[calls].value as domain.SessionResult;
          expect(failure).toMatchObject({ ok: false, code: 'RESOURCE_LIMIT' });
          expect(failure).not.toHaveProperty('state'); expect(failure).not.toHaveProperty('endTurnEconomy');
          expect(current()).toBe(input); expect(input).toEqual(before); expectExclusiveBudget(f);
          expectProjection(f, currentView(f, side)); expect(f.message()).toContain('Доход превысит предел');
          // A stationary fourth ship can spend 15/6 without touching the already sent three.
          execute({ kind: 'refuelShip', factionId: side, expectedTurn: before.turn, systemId: home, shipId: ownIds[3] });
          expect(current().treasuries[side]).toEqual({ credits: before.treasuries[side].credits - 15, minerals: before.treasuries[side].minerals - 6 });
          expect(current().ships).toEqual(before.ships.map(ship => ship.id === ownIds[3] ? { ...ship, fuel: 3 } : ship));
          expect(current().production).toEqual(before.production); expect(current().fleets).toEqual(before.fleets);
          expect(current().turn).toBe(before.turn);
          const forecast = expectBudgetOracle(f, current(), side, 100, 2), recovered = structuredClone(current());
          expect(forecast.upkeep.paidCredits).toBe(100);
          expect(forecast.treasuryAfter).toEqual(resource === 'credits'
            ? { credits: domain.MAX_RESOURCE - 114, minerals: 54 } : { credits: 5, minerals: domain.MAX_RESOURCE - 5 });
          const result = execute({ kind: 'endTurn', factionId: side, expectedTurn: recovered.turn });
          const { ok: _ok, ...predicted } = forecast;
          expect(result.endTurnEconomy).toEqual({ ...predicted, factionId: side, turn: recovered.turn });
          expect(current().treasuries[side]).toEqual(forecast.treasuryAfter); assertAdvance(recovered);
          // A successful receipt must not be replaced by the following (possibly failing) forecast.
          expectProjection(f, currentView(f, side));
          expect(currentView(f, side).economyForecast.ok).toBe(resource === 'credits');
          const receipt = 'Ход передан. Доход: +20 кр. / +10 мин. Содержание: 100/100 кр. Дефицит: 0 кр. (без долга).';
          expect(f.message()).toBe(receipt);
          f.click('campaign-budget'); expect(f.message()).toBe(receipt);
          f.click('campaign-budget'); expect(f.message()).toBe(receipt);
          expect(f.load).not.toHaveBeenCalled();
        } finally { f.events.emit('shutdown'); }
      });
    });

    it('starts on the map and toggles an exclusive budget without commands or catalog loading', () => {
      const f = budgetFixture(), before = structuredClone(f.state), message = f.message();
      expect(runtime(f).budgetOpen).toBe(false); expect(live(f, 'campaign-budget-panel')).toHaveLength(0);
      expect(f.find('system-sol')).toBeDefined(); expect(f.find('campaign-budget').interactive).toBe(true);
      expect(f.find('campaign-production').interactive).toBe(true);
      f.click('campaign-budget'); expectExclusiveBudget(f); expectProjection(f, currentView(f));
      expect(f.find('budget-after').text).toBe('Остаток после расчёта: 110 кр. / 55 мин.');
      expect(f.message()).toBe(message);
      f.click('campaign-budget'); expect(runtime(f).budgetOpen).toBe(false);
      expect(live(f, 'campaign-budget-panel')).toHaveLength(0); expect(f.find('system-sol')).toBeDefined();
      expect(f.message()).toBe(message); expect(f.state).toEqual(before);
      expect(f.commands).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
    });

    it.each([
      { side: 'blue', turn: 1 }, { side: 'red', turn: 1 },
      { side: 'blue', turn: 2 }, { side: 'red', turn: 2 }
    ] as const)('shows only $side budget on turn $turn, active or hypothetical, across side switches', ({ side, turn }) => {
      const state = diagnosticState(2, 7); state.turn = turn;
      state.treasuries.blue = { credits: 123456, minerals: 234567 };
      state.treasuries.red = { credits: 765432, minerals: 654321 };
      const f = budgetFixture(state), before = structuredClone(state);
      if (side === 'red') f.click('campaign-side-switch');
      f.click('campaign-budget'); expectProjection(f, currentView(f, side)); expectExclusiveBudget(f);
      const enemy = side === 'blue' ? 'red' : 'blue';
      const shown = f.nodes.filter(node => !node.destroyed).map(node => node.text).join('\n');
      expect(shown).not.toContain(String(state.treasuries[enemy].credits));
      expect(shown).not.toContain(String(state.treasuries[enemy].minerals));
      expect(shown).not.toContain(`Кораблей на содержании: ${side === 'blue' ? 7 : 2}`);
      f.click('campaign-side-switch'); expectExclusiveBudget(f); expectProjection(f, currentView(f, enemy));
      f.click('campaign-side-switch'); expectProjection(f, currentView(f, side));
      expect(f.find('campaign-end-turn').interactive).toBe(true);
      expect(state).toEqual(before); expect(f.commands).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
    });

    it.each([
      { side: 'blue', selection: 'vega', enemy: true }, { side: 'blue', selection: 'nexus', enemy: false },
      { side: 'red', selection: 'sol', enemy: true }, { side: 'red', selection: 'eden', enemy: false }
    ] as const)('ignores selected $selection ownership/visibility for the $side forecast', ({ side, selection, enemy }) => {
      const state = diagnosticState(2, 7);
      if (enemy) state.galaxy.systems.find(system => system.id === selection)!.exploredBy.push(side);
      const f = budgetFixture(state);
      if (side === 'red') f.click('campaign-side-switch');
      f.click(`system-${selection}`); const details = f.details();
      expect(details).toContain(enemy ? (side === 'blue' ? 'Красная лига' : 'Синий союз') : 'неизвестен');
      f.click('campaign-budget'); expectExclusiveBudget(f); expectProjection(f, currentView(f, side));
      expect(f.details()).toBe(details); expect(f.load).not.toHaveBeenCalled();
    });

    it.each([
      { count: 0, paid: 0, shortfall: 0, after: 25 },
      { count: 2, paid: 2, shortfall: 0, after: 23 },
      { count: 100, paid: 25, shortfall: 75, after: 0 }
    ])('renders the explicit $count-ship budget fixture, including partial payment without debt', ({ count, paid, shortfall, after }) => {
      const state = diagnosticState(count), eden = state.galaxy.systems.find(system => system.id === 'eden')!;
      eden.ownerId = 'blue'; eden.exploredBy = ['blue']; state.treasuries.blue = { credits: 5, minerals: 5 };
      const f = budgetFixture(state); f.click('campaign-budget'); expectProjection(f, currentView(f));
      expect(f.find('budget-ships').text).toBe(`Кораблей на содержании: ${count}`);
      expect(f.find('budget-due').text).toBe(`Начислено: ${count} кр.`);
      expect(f.find('budget-paid').text).toBe(`Будет списано: ${paid} кр.`);
      expect(f.find('budget-shortfall').text).toBe(`Дефицит: ${shortfall} кр. (без долга)`);
      expect(f.find('budget-after').text).toBe(`Остаток после расчёта: ${after} кр. / 15 мин.`);
      expect(f.commands).not.toHaveBeenCalled();
    });

    it('keeps frozen state and library unchanged and never aliases the rendered forecast back to state', () => {
      const state = diagnosticState(2, 3), before = structuredClone(state);
      const storage = { getItem: vi.fn(() => null), setItem: vi.fn() } satisfies StoragePort;
      vi.stubGlobal('localStorage', storage);
      try {
        const project = structuredClone(state.ships[0].design), f = budgetFixture(freeze(state));
        const views = vi.spyOn(domain, 'getCampaignSessionView');
        f.click('campaign-budget'); const text = budgetText(f);
        const projected = views.mock.results[views.mock.results.length - 1].value as domain.CampaignSessionView;
        expect(projected.treasury).not.toBe(state.treasuries.blue);
        expect(projected.ships[0].design).not.toBe(state.ships[0].design);
        if (!projected.economyForecast.ok) throw Error(projected.economyForecast.code);
        expect(projected.economyForecast.treasuryAfter).not.toBe(projected.treasury);
        expect(projected.economyForecast.income).not.toBe(projected.income);
        projected.treasury.credits = 999; projected.economyForecast.upkeep.paidCredits = 999;
        projected.economyForecast.treasuryAfter.credits = 999; projected.ships[0].design.name = 'Projection only';
        expect(budgetText(f)).toEqual(text); expect(state).toEqual(before);
        f.click('campaign-budget'); f.click('campaign-budget'); expect(budgetText(f)).toEqual(text);
        f.click('campaign-side-switch'); f.click('campaign-side-switch'); expect(budgetText(f)).toEqual(text);
        expect(state.ships[0].design).toEqual(project); expect(runtime(f).campaign).toBe(state);
        expect(f.load).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled(); expect(f.commands).not.toHaveBeenCalled();
      } finally { vi.unstubAllGlobals(); }
    });

    it('renders a synthetic SessionView verbatim without deriving budget numbers from ships or treasury', async () => {
      const { BudgetPanel } = await import('../src/ui/BudgetPanel');
      const f = fixture(); f.events.emit('shutdown');
      // Intentionally inconsistent with empty ships and treasury: a renderer must trust its projection.
      const view = domain.getCampaignSessionView(domain.createCampaignSession(), 'blue');
      view.income = { credits: 17, minerals: 9 };
      view.economyForecast = { ok: true, income: { credits: 17, minerals: 9 },
        upkeep: { shipCount: 37, dueCredits: 73, paidCredits: 50, shortfallCredits: 23 },
        treasuryAfter: { credits: 123, minerals: 456 } };
      const before = structuredClone(view), panel = new BudgetPanel(f.scene, freeze(view));
      expectProjection(f, view); expect(live(f, 'campaign-budget-panel')).toHaveLength(1);
      expect(view).toEqual(before); expect(view.ships).toEqual([]); expect(view).not.toHaveProperty('treasuries');
      panel.destroy(); panel.destroy(); expect(f.nodes.every(node => node.destroyed)).toBe(true);
    });

    it('preserves the actual paid25 receipt while showing the following paid20 forecast', () => {
      const f = travelFixture(100); f.state.treasuries.blue = { credits: 5, minerals: 5 };
      f.click('campaign-end-turn');
      const receipt = 'Ход передан. Доход: +20 кр. / +10 мин. Содержание: 25/100 кр. Дефицит: 75 кр. (без долга).';
      expect(f.message()).toBe(receipt);
      f.click('campaign-budget'); expectExclusiveBudget(f); expectProjection(f, currentView(f));
      expect(f.message()).toBe(receipt); expect(f.find('budget-paid').text).toBe('Будет списано: 20 кр.');
      expect(f.find('budget-shortfall').text).toBe('Дефицит: 80 кр. (без долга)');
      f.click('campaign-budget'); expect(f.message()).toBe(receipt);
      f.click('campaign-budget'); expect(f.message()).toBe(receipt);
      const before = structuredClone(runtime(f).campaign), forecast = budgetText(f);
      expect(f.find('campaign-end-turn').interactive).toBe(true); f.click('campaign-end-turn');
      expect(f.message()).toBe('Сейчас ход другой стороны'); expectExclusiveBudget(f);
      expect(budgetText(f)).toEqual(forecast); expect(runtime(f).campaign).toEqual(before);
    });

    it('reprojects after real deploy, refuel and colonize commands while keeping the budget open', () => {
      const state = diagnosticState(1); state.ships[0].fuel = 0;
      state.production.lastOrderId = 3;
      const record = { id: 2, factionId: 'blue' as const, systemId: 'sol' as const, design: structuredClone(state.ships[0].design) };
      state.production.completed = [record]; state.production.orders = [{ ...structuredClone(record), id: 3, remainingTurns: 1 }];
      const f = budgetFixture(state); f.click('system-eden'); f.click('campaign-budget');
      expectProjection(f, currentView(f)); expect(f.find('budget-ships').text).toBe('Кораблей на содержании: 1');
      const execute = (command: domain.SessionCommand) => {
        const before = structuredClone(runtime(f).campaign), input = runtime(f).campaign;
        runtime(f).execute(command);
        expect(input).toEqual(before); expectExclusiveBudget(f); expectProjection(f, currentView(f));
        expect(f.commands.mock.results[f.commands.mock.results.length - 1].value).toMatchObject({ ok: true });
      };
      // No production controls are mounted in budget mode; exercise the real scene/session command boundary.
      execute({ kind: 'deployProduction', factionId: 'blue', expectedTurn: 1, systemId: 'sol', orderId: 2 });
      expect(f.find('budget-ships').text).toBe('Кораблей на содержании: 2');
      expect(runtime(f).campaign.treasuries.blue).toEqual({ credits: 100, minerals: 50 });
      execute({ kind: 'refuelShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 1 });
      expect(f.find('budget-treasury').text).toBe('Сейчас: 85 кр. / 44 мин.');
      expect(f.find('budget-after').text).toBe('Остаток после расчёта: 93 кр. / 49 мин.');
      f.click('campaign-explore'); expectExclusiveBudget(f); expectProjection(f, currentView(f));
      f.click('campaign-colonize'); expectExclusiveBudget(f); expectProjection(f, currentView(f));
      expect(f.message()).toBe('Колония основана.');
      expect(f.find('budget-income').text).toBe('Валовой доход: +20 кр. / +10 мин.');
      expect(f.find('budget-after').text).toBe('Остаток после расчёта: 103 кр. / 54 мин.');
      const beforeEnd = currentView(f).economyForecast; f.click('campaign-end-turn');
      expectExclusiveBudget(f); expectProjection(f, currentView(f));
      const result = f.commands.mock.results[f.commands.mock.results.length - 1].value as domain.SessionResult;
      if (!result.ok || !beforeEnd.ok) throw Error('Expected successful economy');
      const { ok: _ok, ...budget } = beforeEnd;
      expect(result.endTurnEconomy).toEqual({ ...budget, factionId: 'blue', turn: 1 });
      expect(result.state.production.completed.map(item => item.id)).toEqual([3]);
      expect(f.find('budget-ships').text).toBe('Кораблей на содержании: 2');
      expect(state.production.completed).toEqual([record]); expect(f.load).not.toHaveBeenCalled();
    });

    it('counts free ships and grouped members exactly once before transit, in transit and after arrival', () => {
      const f = travelFixture(4), snapshots = f.state.ships.map(ship => structuredClone(ship.design));
      const reads = f.load.mock.calls.length;
      f.click('campaign-budget');
      const execute = (command: domain.SessionCommand) => {
        runtime(f).execute(command); expectExclusiveBudget(f); expectProjection(f, currentView(f));
        expect(f.find('budget-ships').text).toBe('Кораблей на содержании: 4');
        expect(f.find('budget-due').text).toBe('Начислено: 4 кр.');
        expect(f.spy.mock.results[f.spy.mock.results.length - 1].value).toMatchObject({ ok: true });
      };
      execute({ kind: 'createFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipIds: [1, 2] });
      execute({ kind: 'sendFleet', factionId: 'blue', expectedTurn: 1, systemId: 'sol', fleetId: 1, destinationId: 'eden' });
      execute({ kind: 'sendShip', factionId: 'blue', expectedTurn: 1, systemId: 'sol', shipId: 3, destinationId: 'eden' });
      expect(runtime(f).campaign.ships.filter(ship => ship.transit)).toHaveLength(3);
      execute({ kind: 'endTurn', factionId: 'blue', expectedTurn: 1 });
      expect(runtime(f).campaign.ships.filter(ship => ship.transit)).toHaveLength(0);
      expect(runtime(f).campaign.ships.filter(ship => ship.systemId === 'eden')).toHaveLength(3);
      expect(runtime(f).campaign.fleets.items[0].systemId).toBe('eden');
      expect(runtime(f).campaign.ships.map(ship => ship.design)).toEqual(snapshots);
      expect(f.load).toHaveBeenCalledTimes(reads);
    });

    it.each(['credits', 'minerals'] as const)('clears stale successful fields on gross %s overflow and restores them after recovery', resource => {
      const state = diagnosticState(2), f = budgetFixture(state);
      f.click('campaign-budget'); expectProjection(f, currentView(f));
      const oldFields = successFields.map(name => f.find(name));
      // Diagnostic external state change followed by redraw, not an earned treasury.
      state.treasuries.blue[resource] = domain.MAX_RESOURCE - (resource === 'credits' ? 9 : 4);
      const before = structuredClone(state); runtime(f).render();
      expectProjection(f, currentView(f)); expect(oldFields.every(node => node.destroyed)).toBe(true);
      expect(f.find('campaign-end-turn').interactive).toBe(true); f.click('campaign-end-turn');
      expect(f.commands.mock.results[0].value).toMatchObject({ ok: false, code: 'RESOURCE_LIMIT' });
      expect(runtime(f).campaign).toBe(state); expect(state).toEqual(before); expectExclusiveBudget(f);
      expectProjection(f, currentView(f)); expect(f.message()).toContain('Доход превысит предел');
      state.treasuries.blue[resource] = 0; runtime(f).render(); expectProjection(f, currentView(f));
      expect(live(f, 'budget-error')).toHaveLength(0);
      for (const name of successFields) expect(live(f, name)).toHaveLength(1);
    });

    it.each(['credits', 'minerals'] as const)('accepts the exact gross %s cap without suppressing endTurn', resource => {
      const state = diagnosticState(2);
      state.treasuries.blue[resource] = domain.MAX_RESOURCE - (resource === 'credits' ? 10 : 5);
      const f = budgetFixture(state); f.click('campaign-budget'); expectProjection(f, currentView(f));
      expect(live(f, 'budget-error')).toHaveLength(0); expect(f.find('campaign-end-turn').interactive).toBe(true);
      f.click('campaign-end-turn'); expectExclusiveBudget(f);
      const result = f.commands.mock.results[0].value as domain.SessionResult;
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error(result.message);
      expect(result.state.treasuries.blue[resource]).toBe(domain.MAX_RESOURCE - (resource === 'credits' ? 2 : 0));
      expectProjection(f, currentView(f)); // The next forecast may now overflow; it is not the receipt.
    });

    it('prioritizes TURN_LIMIT over gross overflow, removes success fields and retains inactive command refusal', () => {
      const state = diagnosticState(2, 3), f = budgetFixture(state);
      f.click('campaign-budget'); expectProjection(f, currentView(f));
      state.turn = domain.MAX_TURN;
      state.treasuries.blue.credits = domain.MAX_RESOURCE; state.treasuries.red.minerals = domain.MAX_RESOURCE;
      runtime(f).render(); expectProjection(f, currentView(f));
      const before = structuredClone(state);
      expect(f.find('campaign-end-turn').interactive).toBe(true); f.click('campaign-end-turn');
      expect(f.commands.mock.results[0].value).toMatchObject({ ok: false, code: 'NOT_ACTIVE_FACTION' });
      expectProjection(f, currentView(f)); f.click('campaign-side-switch');
      expectExclusiveBudget(f); expectProjection(f, currentView(f, 'red'));
      expect(f.find('campaign-end-turn').interactive).toBe(true); f.click('campaign-end-turn');
      expect(f.commands.mock.results[1].value).toMatchObject({ ok: false, code: 'TURN_LIMIT' });
      expect(f.message()).toBe('Достигнут предел номера хода'); expectProjection(f, currentView(f, 'red'));
      expect(runtime(f).campaign).toBe(state); expect(state).toEqual(before);
      state.turn = 2; state.treasuries.red.minerals = 0; runtime(f).render();
      expectProjection(f, currentView(f, 'red')); expect(live(f, 'budget-error')).toHaveLength(0);
    });

    it.each(['campaign-new', 'campaign-menu'])('blocks budget and existing background controls while %s is pending', request => {
      const f = budgetFixture(); f.click('campaign-budget');
      const oldToggle = capture(f, 'campaign-budget'), oldEnd = capture(f, 'campaign-end-turn');
      const before = structuredClone(f.state), text = budgetText(f); f.click(request);
      for (const name of ['campaign-budget', 'campaign-production', 'campaign-side-switch', 'campaign-explore',
        'campaign-colonize', 'campaign-end-turn', 'campaign-new', 'campaign-menu']) {
        expect(f.find(name).interactive, name).toBe(false); f.click(name);
      }
      oldToggle(); oldEnd(); expectExclusiveBudget(f); expect(budgetText(f)).toEqual(text);
      expect(f.find('campaign-cancel').interactive).toBe(true); expect(f.find('campaign-confirm').interactive).toBe(true);
      f.click('campaign-cancel'); expectExclusiveBudget(f); expect(budgetText(f)).toEqual(text);
      expect(f.find('campaign-budget').interactive).toBe(true); expect(f.state).toEqual(before);
      expect(f.commands).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    });

    it.each(['campaign-side-switch', 'campaign-end-turn', 'campaign-budget'])('disposes old budget and command callbacks after %s redraw', action => {
      const f = budgetFixture(); f.click('campaign-budget');
      const callbacks = ['campaign-budget', 'campaign-production', 'campaign-end-turn', 'campaign-side-switch']
        .map(name => capture(f, name));
      f.click(action); const before = structuredClone(runtime(f).campaign), text = budgetText(f);
      const commands = f.commands.mock.calls.length, open = runtime(f).budgetOpen;
      callbacks.forEach(callback => callback());
      expect(f.commands).toHaveBeenCalledTimes(commands); expect(f.load).not.toHaveBeenCalled();
      expect(runtime(f).budgetOpen).toBe(open); expect(runtime(f).campaign).toEqual(before); expect(budgetText(f)).toEqual(text);
    });

    it.each(['queue', 'single routes', 'group routes'] as const)('closes %s when opening budget and returns to production without restoring routes', mode => {
      const f = mode === 'group routes' ? fleetTravelFixture(2) : travelFixture(2);
      if (mode === 'queue') f.click('production-travel');
      const reads = f.load.mock.calls.length, before = structuredClone(runtime(f).campaign);
      const old = capture(f, mode === 'group routes' ? 'fleet-travel-send' : mode === 'queue' ? 'production-enqueue' : 'travel-send');
      const calls = f.spy.mock.calls.length;
      f.click('campaign-budget'); expectExclusiveBudget(f); old();
      expect(runtime(f)).toMatchObject({ productionOpen: false, travelOpen: false, fleetsOpen: false, fleetTravelOpen: false });
      for (const name of ['travel-panel', 'fleet-panel', 'fleet-travel-panel']) expect(live(f, name)).toHaveLength(0);
      f.click('campaign-production'); expect(runtime(f).budgetOpen).toBe(false);
      expect(live(f, 'campaign-budget-panel')).toHaveLength(0); expect(f.find('production-enqueue')).toBeDefined();
      expect(live(f, 'production-panel')).toHaveLength(1);
      expect(f.load).toHaveBeenCalledTimes(reads); expect(f.spy).toHaveBeenCalledTimes(calls);
      expect(runtime(f).campaign).toEqual(before);
    });

    it('clears the membership draft and all group pages when budget replaces groups', () => {
      const f = fleetFixture(4); f.selectTwo(); const before = structuredClone(runtime(f).campaign);
      expect(runtime(f).fleetShipIds).toEqual([1, 2]); const old = capture(f, 'fleet-create');
      f.click('campaign-budget'); old(); expectExclusiveBudget(f);
      expect(runtime(f)).toMatchObject({ fleetShipIds: [], fleetCandidatePage: 0, fleetPage: 0, fleetMemberPage: 0,
        fleetDestinationIndex: 0, fleetTransitPage: 0, fleetsOpen: false, fleetTravelOpen: false });
      f.click('campaign-production'); f.click('production-fleets');
      expect(f.find('fleet-create').interactive).toBe(false); expect(runtime(f).fleetShipIds).toEqual([]);
      expect(runtime(f).campaign).toEqual(before); expect(f.spy).not.toHaveBeenCalled();
    });

    it('passes budgetOpen to PanelState and closes budget through the current selection callback', async () => {
      const panels = await import('../src/ui/CampaignPanel'), Original = panels.CampaignPanel;
      // Observe constructor arguments while preserving the real renderer and its disposed guards.
      const constructors = vi.spyOn(panels, 'CampaignPanel').mockImplementation(function (...args) { return new Original(...args); });
      const f = budgetFixture();
      expect(constructors.mock.calls[constructors.mock.calls.length - 1][2]).toMatchObject({ budgetOpen: false });
      f.click('campaign-budget');
      const args = constructors.mock.calls[constructors.mock.calls.length - 1];
      expect(args[2]).toMatchObject({ budgetOpen: true }); expect(args[1]).not.toHaveProperty('treasuries');
      expect(args[1].ships).toEqual([]);
      // No map marker is mounted in budget mode; invoke the current scene callback directly.
      args[3].select('eden'); expect(runtime(f).budgetOpen).toBe(false);
      expect(live(f, 'campaign-budget-panel')).toHaveLength(0); expect(f.find('system-eden')).toBeDefined();
      expect(f.find('campaign-system-name').text).toBe('Эдем'); expect(f.commands).not.toHaveBeenCalled();
    });

    it('uses Escape for pending cancellation first, then budget to map, then menu confirmation', () => {
      const f = budgetFixture(); f.click('campaign-budget'); f.click('campaign-new');
      f.keyboard.emit('keydown-ESC'); expectExclusiveBudget(f); expect(live(f, 'campaign-confirm')).toHaveLength(0);
      f.keyboard.emit('keydown-ESC'); expect(runtime(f).budgetOpen).toBe(false);
      expect(f.find('system-sol')).toBeDefined(); expect(live(f, 'campaign-confirm')).toHaveLength(0);
      f.keyboard.emit('keydown-ESC'); expect(f.message()).toContain('Выйти в меню?');
      expect(f.find('campaign-confirm').interactive).toBe(true); expect(f.start).not.toHaveBeenCalled();
      f.keyboard.emit('keydown-ESC'); expect(f.find('system-sol')).toBeDefined();
      expect(f.commands).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
    });

    it('resets budget to the initial map and prevents old callbacks reopening it at turn1', () => {
      const f = budgetFixture(diagnosticState(2)); f.click('campaign-budget');
      const oldToggle = capture(f, 'campaign-budget'), oldEnd = capture(f, 'campaign-end-turn');
      f.click('campaign-new'); f.click('campaign-confirm'); oldToggle(); oldEnd();
      expect(runtime(f).budgetOpen).toBe(false); expect(live(f, 'campaign-budget-panel')).toHaveLength(0);
      expect(f.find('system-sol')).toBeDefined(); expect(f.find('campaign-turn').text).toBe('Ход 1 · Синий союз');
      f.click('campaign-budget'); expectExclusiveBudget(f); expectProjection(f, currentView(f));
      expect(f.find('budget-ships').text).toBe('Кораблей на содержании: 0');
      expect(f.commands).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
    });

    it.each(['shutdown', 'menu'] as const)('destroys budget on %s and reenters with one panel and one Escape listener', exit => {
      const f = budgetFixture(); f.click('campaign-budget');
      const oldToggle = capture(f, 'campaign-budget'), oldEnd = capture(f, 'campaign-end-turn');
      if (exit === 'menu') { f.click('campaign-menu'); f.click('campaign-confirm'); }
      else f.events.emit('shutdown');
      expect(runtime(f).budgetOpen).toBe(false); expect(runtime(f).campaign).toBeUndefined();
      expect(f.nodes.every(node => node.destroyed)).toBe(true); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(0);
      oldToggle(); oldEnd(); expect(f.nodes.every(node => node.destroyed)).toBe(true);
      f.scene.create(); oldToggle(); oldEnd(); expect(runtime(f).budgetOpen).toBe(false);
      expect(f.find('system-sol')).toBeDefined(); expect(live(f, 'campaign-budget-panel')).toHaveLength(0);
      f.click('campaign-budget'); expectExclusiveBudget(f); expectProjection(f, currentView(f));
      expect(live(f, 'campaign-panel')).toHaveLength(1); expect(f.keyboard.listenerCount('keydown-ESC')).toBe(1);
      expect(f.commands).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
    });
  });
});
