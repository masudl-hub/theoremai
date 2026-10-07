/**
 * What a section of the playground's profile editor says that the catalog doc
 * of the field it edits does not: how the editor works, and what the
 * playground does. The catalog doc is on the field's hover; a note never repeats it.
 */
const SECTION_NOTES = {
  models: 'Add a model here, then select its binding in the tree to configure it.',
  'models.decision': 'A decision uses one model. Select its binding in the tree to configure it.',
  decisionModel: 'This binding answers the questions configured under Decision.',
  slots: "Each slot's picker sets what the preview sends. It is not saved in the profile.",
  context: 'Preview is what the playground sends as the page. It is not saved in the profile.',
  compaction: "The playground's chat compacts only before a turn.",
  quota: 'Playground runs are not counted.',
  'detect.mixed': 'Actions differ by boundary.',
  'detect.source.theorem': "Theorem's patterns only.",
  'detect.source.mine': 'Your patterns only.',
  'detect.source.both': "Theorem's patterns and yours.",
  'detect.own': 'Detectors you define.',
  'detect.try': 'Sample text is not saved.',
  'detect.try.off': 'Set to Ignore at every boundary tested. Nothing reads the sample.',
  'traces.storage': "Your host's trace store uses these. The playground's stores nothing.",
  'tools.host': 'What the host runs. Each call names one.',
  'tool.test.http': 'Sends one real {method} request with the sample input.',
  'tool.test.mcp': 'Asks the server which tools it has.',
  'tool.host': 'What a call runs, and what the console says it does.',
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
