import { z } from 'zod';

const seedSchema = z.number().int().min(1).max(0xffffffff);
const streamIdSchema = z.string().min(1).max(128);

export function createSeededRandom(seed: number): () => number {
  let state = seedSchema.parse(seed);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export function createSeededRandomStream(seed: number, streamId: string): () => number {
  const parsedSeed = seedSchema.parse(seed);
  const parsedStreamId = streamIdSchema.parse(streamId);
  let hash = 2166136261;
  const key = `${parsedSeed}:${parsedStreamId}`;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  return createSeededRandom((hash >>> 0) || 1);
}