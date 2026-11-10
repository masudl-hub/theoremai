/**
 * Where a schema refused a value, as text. Every issue keeps its whole path.
 *
 * why: zod's `flatten()` keys each issue by the first segment of its path and drops the rest,
 * so a bad key inside `action.save` read as a bad `action`.
 *
 * @module
 */

/** One schema issue: the place in the value, and what was wrong there. */
export type SchemaIssue = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

/** A failure's `details` when a schema refuses a value. */
export type SchemaIssueDetails = {
  /** Issues on the value itself. */
  formErrors: string[];
  /** Issues by top-level field. A line names the place below that field first: `save.from: …`. */
  fieldErrors: Record<string, string[]>;
};

/** A path as dotted text; empty at the root. */
export function issuePath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/** The details of a refused value, keyed like zod's `flatten()` but with no part of a path lost. */
export function schemaIssueDetails(issues: readonly SchemaIssue[]): SchemaIssueDetails {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const { path, message } of issues) {
    const [field, ...below] = path;
    if (field === undefined) {
      formErrors.push(message);
      continue;
    }
    const line = below.length > 0 ? `${issuePath(below)}: ${message}` : message;
    const key = String(field);
    fieldErrors[key] = [...(fieldErrors[key] ?? []), line];
  }
  return { formErrors, fieldErrors };
}
