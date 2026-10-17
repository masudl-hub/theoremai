import { z } from 'zod';

/** Any value JSON can hold. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.json();
export const jsonObjectSchema: z.ZodRecord<z.ZodString, z.ZodType<JsonValue>> = z.record(
  z.string(),
  jsonValueSchema,
);
