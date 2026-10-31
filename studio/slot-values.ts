/** The values a slot's declaration lists, or undefined when it lists none a page could pick. */
export function choiceValues(decl: unknown): string[] | undefined {
  if (
    Array.isArray(decl) &&
    decl.length > 0 &&
    decl.every((value) => typeof value === 'string' && value.trim() !== '')
  ) {
    return decl;
  }
  const choices = isRecord(decl) ? decl.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const values: string[] = [];
  for (const choice of choices) {
    if (!isRecord(choice) || typeof choice.value !== 'string' || choice.value.trim() === '') {
      return undefined;
    }
    values.push(choice.value);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
