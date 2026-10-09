import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeGalaxyMap, encodeGalaxyMap } from '../src/domain/galaxyMap';
import { generateBrowserGalaxy } from '../src/utils/BrowserGalaxyGenerator';

const temporaryDirectories: string[] = [];
const cliPath = resolve('src/cli/generateGalaxy.ts');

async function createOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orion-galaxy-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('galaxy generator CLI', () => {
  it('writes a real UTF-8 JSON file and reports success only after publication', async () => {
    const directory = await createOutputDirectory();
    const outputPath = join(directory, 'generated.json');
    const result = spawnSync(process.execPath, [
      cliPath, '--world-count', '6', '--participants', '2', '--seed', '12345', '--output', outputPath
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('seed: 12345');
    const contents = await readFile(outputPath, 'utf8');
    expect(contents).toContain('Участник');
    expect(contents).toContain('World');
    expect(contents).not.toContain('\\u');
    expect(decodeGalaxyMap(contents).ok).toBe(true);
    const browser = generateBrowserGalaxy(6, 12345);
    if (!browser.ok) throw new Error(browser.message);
    const encoded = encodeGalaxyMap(browser.map);
    if (!encoded.ok) throw new Error(encoded.message);
    expect(contents).toBe(encoded.json);
    expect(await readdir(directory)).toEqual(['generated.json']);
  });

  it('creates one seed at the CLI boundary when the seed is omitted', async () => {
    const directory = await createOutputDirectory();
    const outputPath = join(directory, 'generated.json');
    const result = spawnSync(process.execPath, [
      cliPath, '--world-count', '7', '--participants', '2', '--output', outputPath
    ], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const contents = await readFile(outputPath, 'utf8');
    const decoded = decodeGalaxyMap(contents);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.map.seed).toBeGreaterThan(0);
  });

  it('rejects collisions, invalid input and write failures without partial published JSON', async () => {
    const directory = await createOutputDirectory();
    const outputPath = join(directory, 'existing.json');
    await writeFile(outputPath, 'keep-me', 'utf8');
    const collision = spawnSync(process.execPath, [
      cliPath, '--world-count', '6', '--participants', '2', '--seed', '1', '--output', outputPath
    ], { encoding: 'utf8' });
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain('OUTPUT_EXISTS');
    expect(await readFile(outputPath, 'utf8')).toBe('keep-me');

    const invalid = spawnSync(process.execPath, [
      cliPath, '--world-count', '5', '--participants', '2', '--seed', '1',
      '--output', join(directory, 'invalid.json')
    ], { encoding: 'utf8' });
    expect(invalid.status).not.toBe(0);

    const invalidExtension = spawnSync(process.execPath, [
      cliPath, '--world-count', '6', '--participants', '2', '--seed', '1',
      '--output', join(directory, 'invalid.txt')
    ], { encoding: 'utf8' });
    expect(invalidExtension.status).not.toBe(0);
    expect(await readdir(directory)).toEqual(['existing.json']);

    const writeFailure = spawnSync(process.execPath, [
      cliPath, '--world-count', '6', '--participants', '2', '--seed', '1',
      '--output', join(directory, 'missing', 'map.json')
    ], { encoding: 'utf8' });
    expect(writeFailure.status).not.toBe(0);
    expect(writeFailure.stderr).toContain('OUTPUT_WRITE_FAILED');
  });
});
