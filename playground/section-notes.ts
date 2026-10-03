/** The note under each section of the playground's profile editor. */
const SECTION_NOTES = {
  profile: 'Who this agent is and what kind of thing it makes.',
  system:
    'Wrap what must not leak in {private: …}; only that is guarded. With none, the whole prompt is.',
  models: 'Add a model here, then select its binding in the tree to configure it.',
  'models.decision': 'A decision uses one model. Select its binding in the tree to configure it.',
  policy: 'Which model runs by default, and how many steps a turn may take.',
  decisionModel: 'This binding answers the questions configured under Decision.',
  model: 'Where this model runs and what it goes by.',
  generation: 'How long, how varied, and whether its thinking is summarized.',
  conversationState: 'Who carries the conversation between steps.',
  efforts: 'Named thinking levels a turn can ask for.',
  accepts: 'What someone can send the agent.',
  limits: 'How much they can send at once.',
  slots: "The playground's chat picks none; your host passes one with each turn.",
  promptCache: 'Reuses the start of a prompt it has seen.',
  compaction:
    "The agent summarises its own older history. The playground's chat compacts before a turn; after one, your host runs it.",
  'image.output': 'How generated images come back.',
  'image.references': 'Images sent with every turn, ahead of the ones the user attaches.',
  'speech.voice': 'How speech sounds, and the format it comes in.',
  'live.ingress': 'What the session listens to.',
  'live.voice': 'How the agent sounds, and whether it may choose when to speak.',
  'live.session': 'Lets a dropped session pick up where it left off.',
  'live.compression': 'Trims older turns once a session grows past the trigger.',
  'live.transcripts': 'Text copies of what is said, both ways.',
  'live.voiceActivity': 'How the model hears speech start and stop.',
  shape: 'Free text, or JSON held to a schema.',
  repair: 'Checks each reply against the schema and hands what fails back to the model.',
  streaming: 'How a reply arrives, and whether its thinking shows.',
  resumption: 'Picks a reply back up after it stops short.',
  steering: 'Lets you add to a turn while it runs.',
  block: "What a reply can't carry.",
  givenUrls: 'Where an image or link may point beyond what the model was given.',
  input: 'Applied to what comes in before the model sees it.',
  redact: 'Masked in what comes in.',
  canary: "A fresh token in each turn's system prompt, so a leaked prompt shows.",
  egress: 'Checks each reply before anyone sees it.',
  network:
    'Where HTTP and MCP tools may reach from your host. Playground runs reach public hosts only.',
  taint: "What tools may still do once a turn has read a remote tool's result.",
  quota: "Your host enforces this. Playground runs aren't counted against it.",
  traces: "Each run's trace comes back on its own stream.",
  'traces.keep': 'What each trace holds.',
  'traces.scrub': 'Stripped before a trace is stored.',
  'traces.storage': "Your host's trace store uses these. The playground's stores nothing.",
  tools: 'What the agent can call. Built-in tools are turned on per model.',
  'tools.host': 'What the host runs. Each call names one.',
  'tools.loading': 'A T2 tool stays hidden until the loader tool names it.',
  'tool.test.http': 'Sends one real {method} request with the sample input.',
  'tool.test.mcp': 'Asks the server which tools it has.',
  tool: "What the model calls, and what it's told the tool does.",
  'tool.host': 'What a call runs, and what the console says it does.',
  'tool.contract': 'What it takes and gives back, as JSON Schema.',
  'tool.activity':
    "What the chat says while a call runs and once it's done. {field} fills from the call, {results.0.name} steps into a list, and {field|text} shows the text when it's empty.",
  'tool.stub': 'The playground has no code to run, so a function tool answers with this.',
  'tool.request':
    'Where each call goes. Headers are saved in the profile, so keep secrets under Auth.',
  'tool.mapping': 'Which input fields fill the URL and the body.',
  'tool.server':
    'The MCP server and the tool on it. Headers are saved in the profile, so keep secrets under Auth.',
  'tool.auth':
    "The credential sent with each call. The playground holds none, so a tool that needs one can't sign in here.",
  'tool.policy': 'What it may change, when it asks first, and when the model sees it.',
  'decision.contract': 'What this decision is called on every trace. The model never sees it.',
  'decision.state':
    "The JSON every question is asked about. It's filled in the preview, not saved.",
  'decision.questions': 'Asked together in one call, answered in this order.',
  connection: 'Kept in this tab. Sent directly to the provider.',
} as const;

type SectionId = keyof typeof SECTION_NOTES;

/** The note for `id`, each `{name}` in `fill` replaced by its value. */
function sectionNote(id: SectionId, fill: Readonly<Record<string, string>> = {}): string {
  let note: string = SECTION_NOTES[id];
  for (const [name, value] of Object.entries(fill)) note = note.replaceAll(`{${name}}`, value);
  return note;
}

export type { SectionId };
export { SECTION_NOTES, sectionNote };
