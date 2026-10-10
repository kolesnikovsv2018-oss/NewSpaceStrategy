import { writeFile } from 'node:fs/promises';
import { baselineMatrix, runBaseline, summarizeBaseline, verifyBaseline, BASELINE_VERSION, type BaselineRun } from '../diagnostics/conquestBaseline';

export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log('yarn baseline:conquest --output <new-file.json>\n54 оплаченные партии до 200 ходов + 4 boundary до 8; файл не перезаписывается.');
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--output' || !args[1].endsWith('.json')) {
    console.error('Требуется --output <new-file.json>');
    return 1;
  }
  const runs: BaselineRun[] = [];
  const verification: { id: string; repeat: 'passed'; roundTrip: 'passed' | 'no-checkpoint-before-stop' }[] = [];
  for (const input of baselineMatrix()) {
    const run = runBaseline(input);
    verification.push({ id: input.id, ...verifyBaseline(run) });
    runs.push(run);
    console.error(`${input.id}: ${run.status}, ходов ${run.turnsExecuted}, боёв ${run.battles.length}`);
  }
  await writeFile(args[1], JSON.stringify({ format: 'orion-conquest-baseline', schemaVersion: BASELINE_VERSION,
    summary: summarizeBaseline(runs), verification, runs }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify(summarizeBaseline(runs), null, 2));
  return runs.some(run => run.status === 'executor-error') ? 1 : 0;
}
