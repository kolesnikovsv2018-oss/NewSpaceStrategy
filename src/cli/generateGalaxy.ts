/// <reference types="node" />

import { randomInt } from 'node:crypto';
import { link, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { generateGalaxy } from '../domain/galaxyGenerator.ts';
import {
  GALAXY_GENERATOR_VERSION,
  GALAXY_PROFILE_ID,
  encodeGalaxyMap,
  type GalaxyMap
} from '../domain/galaxyMap.ts';

interface CliOptions {
  worldCount: number;
  participantCount: number;
  seed?: number;
  outputPath: string;
}

type CliParseResult =
  | { ok: true; options: CliOptions }
  | { ok: true; help: true }
  | { ok: false; message: string };

type FileWriteResult =
  | { ok: true; path: string }
  | { ok: false; code: 'OUTPUT_EXISTS' | 'OUTPUT_WRITE_FAILED'; message: string };

function parseInteger(value: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseArguments(args: string[]): CliParseResult {
  if (args.length === 1 && args[0] === '--help') return { ok: true, help: true };
  const values = new Map<string, string>();
  const allowed = new Set(['--world-count', '--participants', '--seed', '--output']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      return { ok: false, message: 'Аргументы должны быть уникальными парами --world-count, --participants, --seed, --output' };
    }
    values.set(key, value);
  }

  const worldCountValue = values.get('--world-count');
  const outputPath = values.get('--output');
  const worldCount = worldCountValue === undefined ? null : parseInteger(worldCountValue);
  const participantsValue = values.get('--participants');
  const participantCount = participantsValue === undefined ? 2 : parseInteger(participantsValue);
  const seedValue = values.get('--seed');
  const seed = seedValue === undefined ? undefined : parseInteger(seedValue);
  if (worldCount === null || participantCount === null || outputPath === undefined ||
      outputPath.length === 0 || extname(outputPath) !== '.json' ||
      (seedValue !== undefined && seed === null)) {
    return {
      ok: false,
      message: 'Обязательны --world-count и --output; --participants по умолчанию 2, --seed необязателен и должен быть целым числом'
    };
  }
  return {
    ok: true,
    options: {
      worldCount,
      participantCount,
      ...(typeof seed === 'number' ? { seed } : {}),
      outputPath
    }
  };
}

function usage(): string {
  return [
    'Использование:',
    '  yarn generate:galaxy --world-count <N> --output <file.json> [--participants <2..8>] [--seed <1..4294967295>]',
    'Параметры:',
    '  N: 3×P..256; один мир на участника плюс по две ближайшие гарантированные цели',
    '  P: 2..8; по умолчанию 2; профиль balanced-start-v1, политика initial-lanes-v1',
    '  --seed: при отсутствии создаётся один seed на границе CLI'
  ].join('\n');
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

async function cleanupTemporary(directory: string, filePath: string): Promise<string | null> {
  let failure: string | null = null;
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') failure = 'Не удалось удалить временный JSON';
  }
  try {
    await rmdir(directory);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') failure ??= 'Не удалось удалить временный каталог';
  }
  return failure;
}

async function writeJsonExclusively(outputPath: string, json: string): Promise<FileWriteResult> {
  const absolutePath = isAbsolute(outputPath) ? outputPath : resolve(outputPath);
  const parentDirectory = dirname(absolutePath);
  let temporaryDirectory: string | null = null;
  let temporaryFile = '';
  let published = false;
  try {
    const createdDirectory = await mkdtemp(join(parentDirectory, '.orion-galaxy-'));
    temporaryDirectory = createdDirectory;
    temporaryFile = join(createdDirectory, 'map.json');
    await writeFile(temporaryFile, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await link(temporaryFile, absolutePath);
    published = true;
    const cleanupFailure = await cleanupTemporary(createdDirectory, temporaryFile);
    temporaryDirectory = null;
    if (cleanupFailure) {
      return {
        ok: false,
        code: 'OUTPUT_WRITE_FAILED',
        message: `${cleanupFailure}; итоговый JSON уже опубликован и полностью записан: ${absolutePath}`
      };
    }
    return { ok: true, path: absolutePath };
  } catch (error) {
    const code = errorCode(error);
    const cleanupFailure = temporaryDirectory
      ? await cleanupTemporary(temporaryDirectory, temporaryFile)
      : null;
    if (published) {
      return {
        ok: false,
        code: 'OUTPUT_WRITE_FAILED',
        message: `JSON был опубликован, но операция завершилась ошибкой${cleanupFailure ? `: ${cleanupFailure}` : ''}`
      };
    }
    if (code === 'EEXIST') {
      return { ok: false, code: 'OUTPUT_EXISTS', message: `Файл уже существует: ${absolutePath}` };
    }
    return {
      ok: false,
      code: 'OUTPUT_WRITE_FAILED',
      message: `Не удалось записать JSON${code ? ` (${code})` : ''}${cleanupFailure ? `; ${cleanupFailure}` : ''}`
    };
  }
}

async function writeGeneratedMap(options: CliOptions, map: GalaxyMap, json: string): Promise<number> {
  const result = await writeJsonExclusively(options.outputPath, json);
  if (!result.ok) {
    process.stderr.write(`${result.code}: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(
    `Карта сохранена: ${result.path}; миров: ${map.worlds.length}; участников: ${map.participants.length}; seed: ${map.seed}\n`
  );
  return 0;
}

async function main(args: string[]): Promise<number> {
  const parsed = parseArguments(args);
  if (!parsed.ok) {
    process.stderr.write(`INVALID_ARGUMENTS: ${parsed.message}\n${usage()}\n`);
    return 2;
  }
  if ('help' in parsed) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const seed = parsed.options.seed ?? randomInt(1, 0x1_0000_0000);
  const generated = generateGalaxy({
    worldCount: parsed.options.worldCount,
    participantCount: parsed.options.participantCount,
    seed,
    generatorVersion: GALAXY_GENERATOR_VERSION,
    profileId: GALAXY_PROFILE_ID
  });
  if (!generated.ok) {
    process.stderr.write(`${generated.code}: ${generated.message}\n`);
    return 1;
  }

  const encoded = encodeGalaxyMap(generated.map);
  if (!encoded.ok) {
    process.stderr.write(`${encoded.code}: ${encoded.message}\n`);
    return 1;
  }
  return writeGeneratedMap(parsed.options, encoded.map, encoded.json);
}

process.exitCode = await main(process.argv.slice(2));
