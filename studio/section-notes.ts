/** What a section's title says on hover, where no one catalog field describes the section. */
const SECTION_HINTS = {
  profile: 'What this profile is called, and what kind it is.',
  system: 'What the model is told, and the conditions that decide which lines go out.',
  modelPolicy: 'Which model runs by default, and whether it can be switched.',
  generation: 'How this model writes its reply.',
  limits: 'What a message may carry.',
  patterns: 'Where this detector gets its patterns.',
  allow: 'What this detector lets pass.',
  detector: 'The detector you define: what it is called and its key.',
  contract: 'What this tool takes and returns.',
  agent: 'The agent this tool runs.',
  toolPolicy: 'Who can call this tool, and whether it asks first.',
  connection: 'How the studio reaches this provider.',
} as const;

/**
 * What a section of the studio's profile editor says that the catalog doc
 * of the field it edits does not: how the editor works, and what the
 * studio does. The catalog doc is on the field's hover; a note never repeats it.
 */
const SECTION_NOTES = {
  models: 'Add a model here, then select its binding in the tree to configure it.',
  'models.decision': 'A decision uses one model. Select its binding in the tree to configure it.',
  decisionModel: 'This binding answers the questions configured under Decision.',
  slots: "Each slot's picker sets what the preview sends. It is not saved in the profile.",
  context: 'Preview is what the studio sends as the page. It is not saved in the profile.',
  compaction: "The studio's chat compacts only before a turn.",
  quota: 'Studio runs are not counted.',
  'detect.mixed': 'Actions differ by boundary.',
  'detect.source.theorem': "Theorem's patterns only.",
  'detect.source.mine': 'Your patterns only.',
  'detect.source.both': "Theorem's patterns and yours.",
  'detect.own': 'Detectors you define.',
  'detect.try': 'Sample text is not saved.',
  'detect.try.off': 'Set to Ignore at every boundary tested. Nothing reads the sample.',
  'traces.storage': "Your host's trace store uses these. The studio's stores nothing.",
  'tools.host': 'What the host runs. Each call names one.',
  'tool.test.http': 'Sends one real {method} request with the sample input.',
  'tool.test.mcp': 'Asks the server which tools it has.',
  'tool.host': 'What a call runs, and what the console says it does.',
  'tool.headers': 'Headers are saved in the profile, so keep secrets under Auth.',
  'tool.auth':
    'The studio stores no credential: at a sign-in gate you type one for that call only.',
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

export { SECTION_HINTS, sectionNote };
