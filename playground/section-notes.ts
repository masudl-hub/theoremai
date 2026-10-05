/**
 * What a section of the playground's profile editor adds to the catalog doc
 * of the field it edits: how the editor works, and what the playground does.
 */
const SECTION_NOTES = {
  system:
    'Wrap what must not leak in {private: …}; only that is guarded. With none, the whole prompt is.',
  models: 'Add a model here, then select its binding in the tree to configure it.',
  'models.decision': 'A decision uses one model. Select its binding in the tree to configure it.',
  decisionModel: 'This binding answers the questions configured under Decision.',
  slots: "The playground's chat picks none.",
  compaction: "The playground's chat compacts only before a turn.",
  quota: "Playground runs aren't counted against it.",
  'detect.mixed': 'The boundaries have different actions. Open the row to see each.',
  'traces.storage': "Your host's trace store uses these. The playground's stores nothing.",
  'tools.host': 'What the host runs. Each call names one.',
  'tool.test.http': 'Sends one real {method} request with the sample input.',
  'tool.test.mcp': 'Asks the server which tools it has.',
  tool: "What the model calls, and what it's told the tool does.",
  'tool.host': 'What a call runs, and what the console says it does.',
  'tool.contract': 'What it takes and gives back, as JSON Schema.',
  'tool.headers': 'Headers are saved in the profile, so keep secrets under Auth.',
  'tool.auth': 'The playground stores no credential: at a sign-in gate you type one for that call only.',
  'decision.state': "The JSON every question is asked about. It's filled in the preview, not saved.",
  'decision.questions': 'Asked together in one call, answered in this order.',
  connection: 'Kept in this tab. Sent directly to the provider.',
} as const;

/** The note for `id`, each `{name}` in `fill` replaced by its value. */
function sectionNote(
  id: keyof typeof SECTION_NOTES,
  fill: Readonly<Record<string, string>> = {},
): string {
  let note: string = SECTION_NOTES[id];
  for (const [name, value] of Object.entries(fill)) note = note.replaceAll(`{${name}}`, value);
  return note;
}

export { sectionNote };
