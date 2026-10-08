/**
 * A small project for the studio to open while a real one cannot load: three
 * tools and one profile that allows two of them.
 *
 * @module
 */

import { defineProfile, registerProfile, registerTool, z } from '../../mod.ts';

const PLANTS = [
  { id: 'fern', name: 'Boston fern', waterEveryDays: 3, light: 'shade' },
  { id: 'cactus', name: 'Barrel cactus', waterEveryDays: 21, light: 'sun' },
  { id: 'basil', name: 'Sweet basil', waterEveryDays: 2, light: 'sun' },
];

export default function register(): void {
  registerTool({
    type: 'function',
    name: 'list_plants',
    description: 'Lists the plants in the collection, with how often each needs water.',
    category: 'plants',
    access: 'read-only',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'auto',
    input: z.object({
      light: z.enum(['sun', 'shade']).optional().describe('Only plants that want this light.'),
    }),
    output: z.object({
      plants: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          waterEveryDays: z.number(),
          light: z.string(),
        }),
      ),
    }),
    handler: (input) => {
      const { light } = input as { light?: string };
      return { plants: PLANTS.filter((plant) => !light || plant.light === light) };
    },
  });

  registerTool({
    type: 'function',
    name: 'log_watering',
    description: 'Records that a plant was watered.',
    category: 'plants',
    access: 'read-write',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'always_confirm',
    input: z.object({
      plantId: z.string().describe('The id of the plant.'),
      millilitres: z.number().min(10).max(2000).describe('How much water it got.'),
    }),
    output: z.object({ plantId: z.string(), millilitres: z.number(), nextInDays: z.number() }),
    handler: (input) => {
      const { plantId, millilitres } = input as { plantId: string; millilitres: number };
      const plant = PLANTS.find((entry) => entry.id === plantId);
      if (!plant) throw new Error(`No plant with id ${plantId}`);
      return { plantId, millilitres, nextInDays: plant.waterEveryDays };
    },
  });

  registerTool({
    type: 'function',
    name: 'remove_plant',
    description: 'Removes a plant from the collection.',
    category: 'plants',
    access: 'destructive',
    paths: ['*'],
    loadTier: 'T0',
    permission: 'always_confirm',
    input: z.object({ plantId: z.string().describe('The id of the plant.') }),
    output: z.object({ removed: z.string() }),
    handler: (input) => ({ removed: (input as { plantId: string }).plantId }),
  });

  registerProfile(
    defineProfile({
      type: 'host',
      id: 'garden-desk',
      tools: { allow: ['list_plants', 'log_watering'] },
    }),
  );
}
