/**
 * The default UI's words, as an Astryx i18n catalog under `@theorem.*` keys:
 * the same mechanism that words Astryx's own components (`@astryx.*`), so one
 * override table replaces any line on screen, per locale. Messages are ICU
 * (`{handle}`, `{n, plural, …}`); `params` names the values each one is given.
 * Failures are worded by the profile lexicon, not here.
 *
 * @module
 */

import { IntlMessageFormat } from 'intl-messageformat';
import type { ComposerDrawerSummary } from '../client/composer-drawer.ts';
import type { LiveState } from '../client/live/live-state.ts';
import type { TurnUsage, WorkStatus } from '../client/transcript-groups.ts';

type LabelEntry = { defaultMessage: string; description: string; params?: readonly string[] };

export const THEOREM_UI_CATALOG = {
  '@theorem.agent.handle': {
    defaultMessage: '@{handle}',
    description: "The agent's name above its messages, on the landing and in captions.",
    params: ['handle'],
  },

  '@theorem.chat.greeting': {
    defaultMessage: 'What are we working on?',
    description: 'Chat landing heading, before the first message.',
  },
  '@theorem.chat.loading': {
    defaultMessage: 'Loading…',
    description: 'Spinner label while the profile loads.',
  },
  '@theorem.chat.live_unsupported.title': {
    defaultMessage: "Live profiles aren't supported here",
    description: 'Shown when TheoremChat is pointed at a live profile.',
  },
  '@theorem.chat.live_unsupported.description': {
    defaultMessage: 'Use LiveRunner from @theoremjs/react/live.',
    description: 'Where to go instead, under the live-profile warning.',
  },

  '@theorem.composer.placeholder': {
    defaultMessage: 'Message @{handle}',
    description: 'Empty composer placeholder.',
    params: ['handle'],
  },
  '@theorem.composer.listening': {
    defaultMessage: 'Listening…',
    description: 'Composer placeholder while a voice note records.',
  },
  '@theorem.composer.attach': { defaultMessage: 'Attach files', description: 'Paperclip button.' },
  '@theorem.composer.record': {
    defaultMessage: 'Record voice',
    description: 'Microphone button, idle.',
  },
  '@theorem.composer.stop_recording': {
    defaultMessage: 'Stop recording',
    description: 'Microphone button, recording.',
  },
  '@theorem.composer.send_options': {
    defaultMessage: 'More send options',
    description: 'Menu button beside send.',
  },
  '@theorem.composer.model': {
    defaultMessage: 'Model',
    description: 'Model selector (screen readers).',
  },
  '@theorem.composer.effort': {
    defaultMessage: 'Effort',
    description: 'Effort selector (screen readers).',
  },
  '@theorem.composer.menu.queue': { defaultMessage: 'Queue', description: 'Send menu item.' },
  '@theorem.composer.menu.queue.description': {
    defaultMessage: 'Send it once this reply finishes.',
    description: 'Send menu item detail: the message waits its turn.',
  },
  '@theorem.composer.menu.steer': {
    defaultMessage: 'Steer this reply',
    description: 'Send menu item.',
  },
  '@theorem.composer.menu.steer.description': {
    defaultMessage: 'Add it to the reply in progress. The agent reads it at its next step.',
    description: 'Send menu item detail: the message joins the running reply instead of waiting.',
  },
  '@theorem.composer.menu.send_now': { defaultMessage: 'Send now', description: 'Send menu item.' },
  '@theorem.composer.menu.send_now.description': {
    defaultMessage: 'Stop this reply and send it instead.',
    description:
      'Send menu item detail: ends the running reply (or its wait for approval), then sends.',
  },
  '@theorem.composer.menu.stash': { defaultMessage: 'Stash', description: 'Send menu item.' },
  '@theorem.composer.menu.stash.description': {
    defaultMessage: 'Set it aside to send later.',
    description: 'Send menu item detail: the message waits in the composer until sent.',
  },
  '@theorem.composer.hint.stash-selected-draft.message': {
    defaultMessage: 'Replacing this?',
    description: 'Hint when the whole draft is selected and could be stashed.',
  },
  '@theorem.composer.hint.stash-selected-draft.action': {
    defaultMessage: 'Stash it',
    description: "The hint's button.",
  },
  '@theorem.composer.drawer.steer': {
    defaultMessage: 'steering',
    description: 'Drawer header when only steering messages wait.',
  },
  '@theorem.composer.drawer.queue': {
    defaultMessage: 'queued',
    description: 'Drawer header when only queued messages wait.',
  },
  '@theorem.composer.drawer.stash': {
    defaultMessage: 'stashed',
    description: 'Drawer header when only stashed messages wait.',
  },
  '@theorem.composer.drawer.attached': {
    defaultMessage: 'attached',
    description: 'Drawer header when only files wait.',
  },
  '@theorem.composer.drawer.steer.count': {
    defaultMessage: '{n} steering',
    description: 'One part of a mixed drawer header.',
    params: ['n'],
  },
  '@theorem.composer.drawer.queue.count': {
    defaultMessage: '{n} queued',
    description: 'One part of a mixed drawer header.',
    params: ['n'],
  },
  '@theorem.composer.drawer.stash.count': {
    defaultMessage: '{n} stashed',
    description: 'One part of a mixed drawer header.',
    params: ['n'],
  },
  '@theorem.composer.drawer.attached.count': {
    defaultMessage: '{n} attached',
    description: 'One part of a mixed drawer header.',
    params: ['n'],
  },
  '@theorem.composer.drawer.separator': {
    defaultMessage: ' · ',
    description: 'Between the parts of a mixed drawer header.',
  },
  '@theorem.composer.pending.steer': {
    defaultMessage: 'Steering',
    description: 'Badge on a waiting steering message.',
  },
  '@theorem.composer.pending.queue': {
    defaultMessage: 'Queued',
    description: 'Badge on a waiting queued message.',
  },
  '@theorem.composer.pending.stash': {
    defaultMessage: 'Stashed',
    description: 'Badge on a waiting stashed message.',
  },
  '@theorem.composer.pending.edit': {
    defaultMessage: 'Edit',
    description: 'Waiting message: back into the composer.',
  },
  '@theorem.composer.pending.queue_action': {
    defaultMessage: 'Queue',
    description: 'Stashed message: queue it.',
  },
  '@theorem.composer.pending.send_now': {
    defaultMessage: 'Send now',
    description: 'Waiting message: send it now.',
  },
  '@theorem.composer.pending.move_up': {
    defaultMessage: 'Move up',
    description: 'Waiting message: earlier.',
  },
  '@theorem.composer.pending.move_down': {
    defaultMessage: 'Move down',
    description: 'Waiting message: later.',
  },
  '@theorem.composer.pending.remove': {
    defaultMessage: 'Remove',
    description: 'Waiting message: discard.',
  },

  '@theorem.transcript.copy': { defaultMessage: 'Copy', description: 'Copy a message.' },
  '@theorem.transcript.copied': {
    defaultMessage: 'Copied',
    description: 'Right after copying a message.',
  },
  '@theorem.transcript.now': {
    defaultMessage: 'now',
    description: 'Message time during its first minute.',
  },
  '@theorem.transcript.interrupted': {
    defaultMessage: 'Interrupted',
    description: 'Message status: the person stopped its turn.',
  },
  '@theorem.transcript.generated_image': {
    defaultMessage: 'Generated image',
    description: 'Alt text for a generated image.',
  },
  '@theorem.transcript.generated_video': {
    defaultMessage: 'Generated video',
    description: 'Alt text for a generated video.',
  },
  '@theorem.transcript.open_generated_image': {
    defaultMessage: 'Open generated image',
    description: 'Opens the image full size.',
  },
  '@theorem.transcript.generating_image': {
    defaultMessage: 'Generating image',
    description: 'Placeholder while an image generates.',
  },
  '@theorem.transcript.sources': {
    defaultMessage: 'Sources',
    description: 'The row of source chips (screen readers).',
  },
  '@theorem.transcript.tool_input': {
    defaultMessage: 'Input',
    description: "A tool call's arguments, in its detail.",
  },
  '@theorem.transcript.tool_input_edited': {
    defaultMessage: 'Input (edited)',
    description: "A tool call's arguments after the user edited them on approval.",
  },
  '@theorem.transcript.tool_output': {
    defaultMessage: 'Output',
    description: "A tool call's result, in its detail.",
  },
  '@theorem.transcript.tool_error': {
    defaultMessage: 'Error',
    description: "A failed tool call's failure, in its detail.",
  },
  '@theorem.transcript.tokens': {
    defaultMessage: '{count, plural, one {# token} other {# tokens}}',
    description:
      "Tokens a reply used, under it, or an agent tool's called agent used, on its call row.",
    params: ['count'],
  },
  '@theorem.data.view': {
    defaultMessage: 'View as',
    description: 'Switch between tool data drawn by its shape and its JSON.',
  },
  '@theorem.data.shaped': {
    defaultMessage: 'Data',
    description: 'Tool data drawn as fields, sections and tables.',
  },
  '@theorem.data.json': { defaultMessage: 'JSON', description: 'Tool data as its raw JSON.' },
  '@theorem.data.item': {
    defaultMessage: 'Item {index}',
    description: 'A list row with no name of its own.',
    params: ['index'],
  },
  '@theorem.data.none': {
    defaultMessage: 'Empty',
    description: 'An empty list or object in tool data.',
  },
  '@theorem.data.yes': { defaultMessage: 'Yes', description: 'A true value in tool data.' },
  '@theorem.data.no': { defaultMessage: 'No', description: 'A false value in tool data.' },
  '@theorem.data.more': {
    defaultMessage: '{count} more — switch to JSON to see them',
    description: 'Rows past the shown ones, left to the JSON view.',
    params: ['count'],
  },
  '@theorem.data.large': {
    defaultMessage: 'Too large to lay out — showing the first {size} of its JSON',
    description: 'A payload too big to draw by its shape, shown as the start of its JSON.',
    params: ['size'],
  },
  '@theorem.transcript.copy_text.tool': {
    defaultMessage: 'Tool: {name}',
    description: 'A tool call in copied message text.',
    params: ['name'],
  },
  '@theorem.transcript.copy_text.media': {
    defaultMessage: '[{mimeType} media]',
    description: 'Media without a link, in copied message text.',
    params: ['mimeType'],
  },
  '@theorem.transcript.working': {
    defaultMessage: 'Working…',
    description: 'Turn status while running, start unknown.',
  },
  '@theorem.transcript.working_for': {
    defaultMessage: 'Working for {duration}',
    description: 'Turn status while running.',
    params: ['duration'],
  },
  '@theorem.transcript.worked': {
    defaultMessage: 'Worked',
    description: 'Turn status once done, duration unknown.',
  },
  '@theorem.transcript.worked_for': {
    defaultMessage: 'Worked for {duration}',
    description: 'Turn status once done.',
    params: ['duration'],
  },

  '@theorem.duration.milliseconds': {
    defaultMessage: '{ms}ms',
    description: 'Under a second.',
    params: ['ms'],
  },
  '@theorem.duration.belowTenth': {
    defaultMessage: '<0.1ms',
    description: 'Above zero but under a tenth of a millisecond, such as a quick guardrail check.',
  },
  '@theorem.duration.seconds': {
    defaultMessage: '{seconds}s',
    description: 'Under a minute.',
    params: ['seconds'],
  },
  '@theorem.duration.minutes': {
    defaultMessage: '{minutes}m',
    description: 'Whole minutes.',
    params: ['minutes'],
  },
  '@theorem.duration.minutes_seconds': {
    defaultMessage: '{minutes}m {seconds}s',
    description: 'Minutes and seconds.',
    params: ['minutes', 'seconds'],
  },

  '@theorem.gate.approval.title': {
    defaultMessage: '{agent} wants to {request}',
    description:
      "Approval card heading. {agent} is the agent's handle; {request} is what the call would do, e.g. 'check the weather'.",
    params: ['agent', 'request'],
  },
  '@theorem.gate.approval.title_no_agent': {
    defaultMessage: 'The agent wants to {request}',
    description: 'Approval card heading when the host names no agent.',
    params: ['request'],
  },
  '@theorem.gate.approval.use_tool': {
    defaultMessage: 'use {tool}',
    description:
      "The {request} in the heading when the tool sets no labels.request. {tool} is the tool's name in words.",
    params: ['tool'],
  },
  '@theorem.gate.approval.input': {
    defaultMessage: 'Details',
    description: 'Expands the arguments the tool would run with.',
  },
  '@theorem.gate.approval.deny': { defaultMessage: 'Reject', description: 'Approval card button.' },
  '@theorem.gate.approval.approve': {
    defaultMessage: 'Approve',
    description: 'Approval card button.',
  },
  '@theorem.gate.tag.bearer': { defaultMessage: 'bearer', description: 'Credential type tag.' },
  '@theorem.gate.tag.api_key': { defaultMessage: 'api_key', description: 'Credential type tag.' },
  '@theorem.gate.tag.oauth2': { defaultMessage: 'oauth2', description: 'Credential type tag.' },
  '@theorem.gate.auth.title': {
    defaultMessage: 'Sign in to use {tool}',
    description: "Credential card heading. {tool} is the tool's name in words.",
    params: ['tool'],
  },
  '@theorem.gate.auth.resource': {
    defaultMessage: 'Resource: {resource}',
    description: 'What the credential is for.',
    params: ['resource'],
  },
  '@theorem.gate.auth.no_oauth': {
    defaultMessage: 'No OAuth authorization endpoint is configured.',
    description: 'OAuth tool without an authorization URL.',
  },
  '@theorem.gate.auth.authorize': {
    defaultMessage: 'Authorize with provider',
    description: 'Opens the OAuth sign-in.',
  },
  '@theorem.gate.auth.provided': {
    defaultMessage: 'Credential provided for {slot}',
    description: 'After submitting a credential or finishing an OAuth sign-in.',
    params: ['slot'],
  },
  '@theorem.gate.auth.api_key': {
    defaultMessage: 'API key',
    description: 'Secret field label, API-key tools.',
  },
  '@theorem.gate.auth.bearer': {
    defaultMessage: 'Bearer token',
    description: 'Secret field label, bearer tools.',
  },
  '@theorem.gate.auth.secret_placeholder': {
    defaultMessage: "Secret for slot ''{slot}''",
    description: 'Secret field placeholder.',
    params: ['slot'],
  },
  '@theorem.gate.auth.secret_note': {
    defaultMessage: ' ',
    description:
      'Under the secret field: how the host handles the credential. Blank by default, since only the host knows; the playground says it is used for one call.',
  },
  '@theorem.gate.auth.submit': {
    defaultMessage: 'Submit & continue',
    description: 'Sends the credential.',
  },

  '@theorem.voice_note.name': {
    defaultMessage: 'voice.{format}',
    description: "A voice note's name, by audio format (webm, wav, mp3, m4a, ogg).",
    params: ['format'],
  },
  '@theorem.voice_note.unnamed': {
    defaultMessage: 'voice note',
    description: "A voice note's name when its format is unknown.",
  },
  '@theorem.voice_note.play': {
    defaultMessage: 'Play {name}',
    description: 'Voice note, paused.',
    params: ['name'],
  },
  '@theorem.voice_note.pause': {
    defaultMessage: 'Pause {name}',
    description: 'Voice note, playing.',
    params: ['name'],
  },
  '@theorem.voice_note.remove': {
    defaultMessage: 'Remove {name}',
    description: 'Unstages a voice note.',
    params: ['name'],
  },

  '@theorem.decision.state': {
    defaultMessage: 'State',
    description: 'The JSON a decision is asked about (field label).',
  },
  '@theorem.decision.state_size': {
    defaultMessage: '{size} of {limit}',
    description: "The state's size against the profile's limit, under the field.",
    params: ['size', 'limit'],
  },
  '@theorem.decision.view': {
    defaultMessage: 'Edit as',
    description: 'Switch between the state as fields and as JSON.',
  },
  '@theorem.decision.fields': {
    defaultMessage: 'Fields',
    description: 'The state edited field by field.',
  },
  '@theorem.decision.add_item': {
    defaultMessage: 'Add to {field}',
    description: 'Adds a row to a list in the state.',
    params: ['field'],
  },
  '@theorem.decision.remove_item': {
    defaultMessage: 'Remove {item}',
    description: 'Removes a row from a list in the state.',
    params: ['item'],
  },
  '@theorem.decision.add_value': {
    defaultMessage: 'Add a value',
    description: 'A list of words in the state, while it is empty.',
  },
  '@theorem.decision.invalid_json': {
    defaultMessage: 'Not valid JSON yet',
    description: "The state doesn't parse.",
  },
  '@theorem.decision.null_state': {
    defaultMessage: 'State can’t be null',
    description: 'The state is the JSON null.',
  },
  '@theorem.decision.too_large': {
    defaultMessage: 'Over the {limit} limit',
    description: "The state is larger than the profile's limit.",
    params: ['limit'],
  },
  '@theorem.decision.answers': {
    defaultMessage: 'Answers',
    description: 'The decision response column.',
  },
  '@theorem.decision.decide': {
    defaultMessage: 'Decide',
    description: 'Asks the questions about the state.',
  },
  '@theorem.decision.deciding': {
    defaultMessage: 'Deciding…',
    description: 'The decide button while it runs.',
  },
  '@theorem.decision.stop': {
    defaultMessage: 'Stop',
    description: 'Cancels the running decision.',
  },
  '@theorem.decision.confidence': {
    defaultMessage: '{percent} sure',
    description: "How sure the model is of a choice or score; percent is formatted, e.g. '92%'.",
    params: ['percent'],
  },
  '@theorem.decision.option': {
    defaultMessage: '{label}, {percent}',
    description: 'One option and its probability (screen readers); percent is formatted.',
    params: ['label', 'percent'],
  },
  '@theorem.decision.score_of': {
    defaultMessage: '{score} of {max}',
    description: 'A score on its scale from 0, e.g. 1.4 of 3.',
    params: ['score', 'max'],
  },
  '@theorem.decision.type.choice': {
    defaultMessage: 'Choice',
    description: 'A question that picks one label.',
  },
  '@theorem.decision.type.score': {
    defaultMessage: 'Score',
    description: 'A question that places the state on a scale.',
  },
  '@theorem.decision.type.noul': {
    defaultMessage: 'Noul',
    description: 'A question answered with one number.',
  },
  '@theorem.decision.tokens': {
    defaultMessage: '{count, plural, one {# token} other {# tokens}}',
    description: 'Input tokens the decision used, in the line under the answers.',
    params: ['count'],
  },

  '@theorem.host.tool': {
    defaultMessage: 'Tool',
    description: 'Picks which of the host’s tools to call (field label).',
  },
  '@theorem.host.request': {
    defaultMessage: 'Request',
    description: 'The input a tool call sends (card heading).',
  },
  '@theorem.host.response': {
    defaultMessage: 'Response',
    description: 'What a tool call returned (section heading).',
  },
  '@theorem.host.run': { defaultMessage: 'Run', description: 'Calls the tool with the request.' },
  '@theorem.host.image': {
    defaultMessage: 'Image the tool returned',
    description: 'Alt text for an image a tool returned beside its output.',
  },
  '@theorem.host.running': {
    defaultMessage: 'Running…',
    description: 'The run button while the call runs.',
  },
  '@theorem.host.stop': { defaultMessage: 'Stop', description: 'Cancels the running call.' },
  '@theorem.host.missing': {
    defaultMessage: 'Needs {fields}',
    description: 'Required fields the request is still missing, under the form.',
    params: ['fields'],
  },
  '@theorem.host.shortcut': {
    defaultMessage: '⌘↵ to run',
    description: 'The keyboard shortcut that runs the call, under the form.',
  },
  '@theorem.host.no_tools': {
    defaultMessage: 'This host has no tools yet',
    description: 'A host profile that allows no tools.',
  },
  '@theorem.host.earlier': {
    defaultMessage: 'Earlier calls',
    description: 'Heading over this page’s previous tool calls.',
  },
  '@theorem.host.kind.function': {
    defaultMessage: 'Function',
    description: 'A tool that runs a function on the host.',
  },
  '@theorem.host.kind.http': {
    defaultMessage: 'HTTP',
    description: 'A tool that calls an HTTP endpoint.',
  },
  '@theorem.host.kind.mcp': {
    defaultMessage: 'MCP',
    description: 'A tool served by an MCP server.',
  },
  '@theorem.tool.access.read-only': {
    defaultMessage: 'Read only',
    description: 'A tool that only reads.',
  },
  '@theorem.tool.access.read-write': {
    defaultMessage: 'Read and write',
    description: 'A tool that can change things.',
  },
  '@theorem.tool.access.destructive': {
    defaultMessage: 'Destructive',
    description: 'A tool that can delete or overwrite.',
  },
  '@theorem.host.status.running': {
    defaultMessage: 'Running',
    description: 'A tool call in progress.',
  },
  '@theorem.host.status.gate': {
    defaultMessage: 'Waiting',
    description: 'A tool call paused on approval or sign-in.',
  },
  '@theorem.host.status.complete': {
    defaultMessage: 'Done',
    description: 'A tool call that returned.',
  },
  '@theorem.host.status.error': {
    defaultMessage: 'Failed',
    description: 'A tool call that failed.',
  },
  '@theorem.host.status.cancel': {
    defaultMessage: 'Stopped',
    description: 'A tool call that was cancelled.',
  },

  '@theorem.panel.trace.name': {
    defaultMessage: 'Trace',
    description: 'Trace side panel (screen readers).',
  },
  '@theorem.panel.trace.show': {
    defaultMessage: 'Show trace',
    description: 'Trace panel toggle, closed.',
  },
  '@theorem.panel.trace.hide': {
    defaultMessage: 'Hide trace',
    description: 'Trace panel toggle, open.',
  },
  '@theorem.panel.trace.resize': {
    defaultMessage: 'Resize trace',
    description: 'Trace panel drag handle.',
  },
  '@theorem.panel.resize': {
    defaultMessage: 'Resize {name}',
    description: 'Drag handle for a named console panel.',
    params: ['name'],
  },
  '@theorem.panel.trace.empty.title': {
    defaultMessage: 'No trace yet',
    description: 'Empty trace panel.',
  },
  '@theorem.panel.trace.empty.description': {
    defaultMessage: 'Spans for each run will show here.',
    description: 'Empty trace panel.',
  },
  '@theorem.panel.trace.summary': {
    defaultMessage:
      '{traces, plural, one {# trace} other {# traces}} · {spans, plural, one {# span} other {# spans}}',
    description: 'Trace panel line under the search: how many traces and spans it holds.',
    params: ['traces', 'spans'],
  },
  '@theorem.panel.trace.separator': {
    defaultMessage: ' · ',
    description: 'Between facts on one trace panel line.',
  },
  '@theorem.panel.trace.search': {
    defaultMessage: 'Search spans',
    description: 'Trace panel search (screen readers).',
  },
  '@theorem.panel.trace.search.placeholder': {
    defaultMessage: 'Filter by type, status, model, text…',
    description: 'Trace panel search, empty.',
  },
  '@theorem.panel.trace.search.text': {
    defaultMessage: 'Any text',
    description: 'Search field matching any text a span holds.',
  },
  '@theorem.panel.trace.search.text.description': {
    defaultMessage: 'Names, values and stored text.',
    description: 'What the any-text search field matches.',
  },
  '@theorem.panel.trace.no_match': {
    defaultMessage: 'No spans match',
    description: 'Trace panel, when the search matches nothing.',
  },
  '@theorem.panel.trace.back': {
    defaultMessage: 'Back',
    description: 'Leaves an open span for its turn.',
  },
  '@theorem.panel.trace.show_text': {
    defaultMessage: 'Show text',
    description: 'Reveals stored text, JSON or messages.',
  },
  '@theorem.panel.trace.hide_text': {
    defaultMessage: 'Hide text',
    description: 'Hides revealed stored text.',
  },
  '@theorem.panel.trace.other': {
    defaultMessage: 'Other',
    description: 'Group for attributes the trace catalog does not name.',
  },
  '@theorem.panel.trace.yes': { defaultMessage: 'Yes', description: 'A true trace value.' },
  '@theorem.panel.trace.no': { defaultMessage: 'No', description: 'A false trace value.' },
  '@theorem.panel.trace.tokens': { defaultMessage: 'Tokens', description: 'Card of token counts.' },
  '@theorem.panel.trace.errors': {
    defaultMessage: 'Errors',
    description: 'Card counting failed spans.',
  },
  '@theorem.panel.trace.at_least': {
    defaultMessage: 'At least {value}',
    description: 'A total some calls did not report.',
    params: ['value'],
  },
  '@theorem.panel.trace.about': {
    defaultMessage: 'About {value}',
    description: 'A total with estimated counts.',
    params: ['value'],
  },
  '@theorem.panel.trace.offset': {
    defaultMessage: '+{duration}',
    description: 'When an event happened, after its span started.',
    params: ['duration'],
  },
  '@theorem.panel.trace.unit.milliseconds': {
    defaultMessage: 'ms',
    description: 'Unit of a search field in milliseconds.',
  },
  '@theorem.panel.trace.unit.seconds': {
    defaultMessage: 's',
    description: 'Unit of a search field in seconds.',
  },
  '@theorem.panel.trace.unit.usd': {
    defaultMessage: 'USD',
    description: 'Unit of a search field in US dollars.',
  },
  '@theorem.panel.trace.turn': {
    defaultMessage: '{label} {index} of {count}',
    description: 'Which root of the trace is shown: "Turn 2 of 3".',
    params: ['label', 'index', 'count'],
  },
  '@theorem.panel.trace.turns': {
    defaultMessage: 'Turns',
    description: 'List of every turn of the conversation; a row opens its turn.',
  },
  '@theorem.panel.trace.conversation': {
    defaultMessage: '{count, plural, one {# turn} other {# turns}}',
    description: 'Heading of the whole-conversation view: how many turns it holds.',
    params: ['count'],
  },
  '@theorem.panel.trace.conversation.back': {
    defaultMessage: 'All turns',
    description: 'Leaves a turn for the whole-conversation view.',
  },
  '@theorem.panel.trace.previous': {
    defaultMessage: 'Previous turn',
    description: 'Opens the turn before this one.',
  },
  '@theorem.panel.trace.next': {
    defaultMessage: 'Next turn',
    description: 'Opens the turn after this one.',
  },
  '@theorem.panel.trace.calls': {
    defaultMessage: 'Tool calls',
    description: "List of every call of a host's trace; a row opens its call.",
  },
  '@theorem.panel.trace.calls.count': {
    defaultMessage: '{count, plural, one {# tool call} other {# tool calls}}',
    description: "Heading of a host's whole-trace view: how many tool calls it holds.",
    params: ['count'],
  },
  '@theorem.panel.trace.calls.back': {
    defaultMessage: 'All tool calls',
    description: "Leaves a call for the host's whole-trace view.",
  },
  '@theorem.panel.trace.calls.previous': {
    defaultMessage: 'Previous call',
    description: 'Opens the tool call before this one.',
  },
  '@theorem.panel.trace.calls.next': {
    defaultMessage: 'Next call',
    description: 'Opens the tool call after this one.',
  },
  '@theorem.panel.trace.steps': {
    defaultMessage: 'Steps',
    description: 'Card counting the model and tool calls of a turn.',
  },
  '@theorem.panel.trace.steps.detail': {
    defaultMessage:
      '{calls, plural, one {# model call} other {# model calls}} · {tools, plural, one {# tool} other {# tools}}',
    description: 'Under the steps count: how many were model calls and tool calls.',
    params: ['calls', 'tools'],
  },
  '@theorem.panel.trace.failed': {
    defaultMessage: '{count} failed',
    description: 'Under the steps count, when some failed.',
    params: ['count'],
  },
  '@theorem.panel.trace.firstText': {
    defaultMessage: 'First text',
    description: 'Card: how long the person waited before any of the answer appeared.',
  },
  '@theorem.panel.trace.rate': {
    defaultMessage: '{rate} tokens/s',
    description: 'Under the first-text time: how fast the model wrote once it started.',
    params: ['rate'],
  },
  '@theorem.panel.trace.held': {
    defaultMessage: '{duration} held back',
    description:
      'Under the first-text time: how long guardrails held written text back before showing it.',
    params: ['duration'],
  },
  '@theorem.panel.trace.guardrails': {
    defaultMessage: 'Guardrails',
    description: 'Card: the time guardrail checks took in a turn.',
  },
  '@theorem.panel.trace.guardrails.passed': {
    defaultMessage: 'Passed: {checks}',
    description:
      'Under the guardrail checks that acted: the checks that let the text through, each with what it checked and its time.',
    params: ['checks'],
  },
  '@theorem.panel.trace.guardrails.from': {
    defaultMessage: 'from {tool}',
    description: 'A guardrail check: the tool the checked text came from.',
    params: ['tool'],
  },
  '@theorem.panel.trace.guardrails.tainted': {
    defaultMessage: 'Tainted',
    description:
      'A guardrail check: a tool that writes or deletes was called after the turn read remote content.',
  },
  '@theorem.panel.trace.guardrails.steered': {
    defaultMessage: 'Steered',
    description:
      'A guardrail check: a tool that writes or deletes was called after the turn read remote content that looked like instructions.',
  },
  '@theorem.panel.trace.guardrails.detail': {
    defaultMessage:
      '{checks, plural, one {# check} other {# checks}} · {flagged, plural, =0 {all passed} other {# acted}}',
    description:
      'Under the guardrail time: how many checks ran, and how many redacted, flagged or blocked.',
    params: ['checks', 'flagged'],
  },
  '@theorem.panel.trace.tokens.detail': {
    defaultMessage: '{input} in · {output} out',
    description: 'Under the token total: tokens read and written.',
    params: ['input', 'output'],
  },
  '@theorem.panel.trace.time': {
    defaultMessage: 'Where the time went',
    description: 'Bar splitting a turn into model, tool and other time.',
  },
  '@theorem.panel.trace.time.model': {
    defaultMessage: 'Model',
    description: 'Time spent waiting on the model.',
  },
  '@theorem.panel.trace.time.tools': {
    defaultMessage: 'Tools',
    description: 'Time spent running tools.',
  },
  '@theorem.panel.trace.time.guardrails': {
    defaultMessage: 'Guardrails',
    description: 'Time guardrail checks took: on the input, the stream and the answer.',
  },
  '@theorem.panel.trace.time.hooks': {
    defaultMessage: 'Hooks',
    description: "Time the host's turn hooks took.",
  },
  '@theorem.panel.trace.time.other': {
    defaultMessage: 'Other',
    description: 'Time spent on none of these: waiting between steps, the host, the network.',
  },
  '@theorem.panel.trace.charts.calls': {
    defaultMessage: 'Tokens per model call',
    description: 'Chart of each model call: its tokens stacked as a bar.',
  },
  '@theorem.panel.trace.charts.cached': {
    defaultMessage: 'Cached',
    description: 'Legend: input tokens read from cache.',
  },
  '@theorem.panel.trace.charts.input': {
    defaultMessage: 'Input',
    description: 'Legend: input tokens read fresh.',
  },
  '@theorem.panel.trace.charts.output': {
    defaultMessage: 'Output',
    description: 'Legend: tokens the model wrote.',
  },
  '@theorem.panel.trace.charts.slowest': {
    defaultMessage: 'Slowest steps',
    description: 'Chart ranking the steps that took longest.',
  },
  '@theorem.panel.trace.charts.modelShare': {
    defaultMessage: '{share} on the model',
    description: "Beside a chart's total time: the model's share.",
    params: ['share'],
  },
  '@theorem.panel.trace.charts.cachedShare': {
    defaultMessage: '{share} of input cached',
    description: "Beside a chart's total tokens: the input read from cache.",
    params: ['share'],
  },
  '@theorem.panel.trace.charts.turnTime': {
    defaultMessage: 'Time per turn',
    description: 'Chart of each turn: its model, tool and other time stacked.',
  },
  '@theorem.panel.trace.charts.callTime': {
    defaultMessage: 'Time per call',
    description:
      "Chart of each tool call of a host's trace: its tool, check and hook time stacked.",
  },
  '@theorem.panel.trace.charts.turnTokens': {
    defaultMessage: 'Tokens per turn',
    description: 'Chart of each turn: its tokens stacked as a bar.',
  },
  '@theorem.panel.trace.charts.turn': {
    defaultMessage: 'Turn {index}',
    description: 'A turn, by its order in the conversation.',
    params: ['index'],
  },
  '@theorem.panel.trace.charts.hostCall': {
    defaultMessage: 'Call {index}',
    description: "A tool call, by its order in a host's trace.",
    params: ['index'],
  },
  '@theorem.panel.trace.charts.call': {
    defaultMessage: 'Model call {index}',
    description: 'A model call, by its order in the turn.',
    params: ['index'],
  },
  '@theorem.panel.trace.charts.tokens': {
    defaultMessage: '{cached} cached · {fresh} new in · {output} out',
    description: "A model call's tokens: read from cache, read fresh, and written.",
    params: ['cached', 'fresh', 'output'],
  },
  '@theorem.panel.trace.story': {
    defaultMessage: 'What happened',
    description: 'The turn told step by step.',
  },
  '@theorem.panel.trace.story.asked': {
    defaultMessage: 'User asked',
    description: 'The first step: what the user sent.',
  },
  '@theorem.panel.trace.story.requested': {
    defaultMessage: 'Asked for {count, plural, one {# tool} other {# tools}}',
    description: 'A model call that answered with tool calls.',
    params: ['count'],
  },
  '@theorem.panel.trace.story.wrote': {
    defaultMessage: 'Wrote a reply',
    description: 'A model call that answered with text.',
  },
  '@theorem.panel.trace.story.answered': {
    defaultMessage: 'Answered',
    description: 'The last step: the turn ended with this answer.',
  },
  '@theorem.panel.trace.story.failed': {
    defaultMessage: 'Ended with an error',
    description: 'The last step, when the turn failed.',
  },
  '@theorem.panel.trace.timeline': {
    defaultMessage: 'Timeline',
    description: 'Every span of the turn on one time axis.',
  },
  '@theorem.panel.trace.timeline.zoom': {
    defaultMessage: 'Drag across the strip to zoom',
    description: 'Hint beside the activity strip that zooms the timeline.',
  },
  '@theorem.panel.trace.timeline.reset': {
    defaultMessage: 'Show the whole turn',
    description: 'Zooms the timeline back out to the full turn.',
  },
  '@theorem.panel.trace.input': { defaultMessage: 'Input', description: 'What a span was given.' },
  '@theorem.panel.trace.output': {
    defaultMessage: 'Output',
    description: 'What a span gave back.',
  },
  '@theorem.panel.trace.details': {
    defaultMessage: 'All details',
    description: "A span's every attribute, event and link.",
  },
  '@theorem.panel.trace.close': { defaultMessage: 'Close', description: 'Closes the open span.' },
  '@theorem.panel.captions.name': {
    defaultMessage: 'Captions',
    description: 'Captions side panel (screen readers).',
  },
  '@theorem.panel.captions.show': {
    defaultMessage: 'Show captions',
    description: 'Captions panel toggle, closed.',
  },
  '@theorem.panel.captions.hide': {
    defaultMessage: 'Hide captions',
    description: 'Captions panel toggle, open.',
  },
  '@theorem.panel.captions.resize': {
    defaultMessage: 'Resize captions',
    description: 'Captions panel drag handle.',
  },
  '@theorem.panel.captions.empty.title': {
    defaultMessage: 'No captions yet',
    description: 'Empty captions panel.',
  },
  '@theorem.panel.captions.empty.description': {
    defaultMessage: 'What you and the agent say will show here.',
    description: 'Empty captions panel.',
  },

  '@theorem.live.greeting': {
    defaultMessage: 'Ready when you are.',
    description: 'Live landing heading, before a call.',
  },
  '@theorem.live.start_voice_call': {
    defaultMessage: 'Start voice call',
    description: 'Live landing, voice profiles.',
  },
  '@theorem.live.start_call': {
    defaultMessage: 'Start call',
    description: 'Starts or restarts a call.',
  },
  '@theorem.live.start_video_call': {
    defaultMessage: 'Start video call',
    description: 'Live landing, video profiles.',
  },
  '@theorem.live.microphone': { defaultMessage: 'Microphone', description: 'Mic toggle.' },
  '@theorem.live.mute': { defaultMessage: 'Mute', description: 'Mic toggle tooltip, unmuted.' },
  '@theorem.live.unmute': { defaultMessage: 'Unmute', description: 'Mic toggle tooltip, muted.' },
  '@theorem.live.camera': { defaultMessage: 'Camera', description: 'Camera toggle.' },
  '@theorem.live.camera_on': {
    defaultMessage: 'Turn camera on',
    description: 'Camera toggle tooltip, off.',
  },
  '@theorem.live.camera_off': {
    defaultMessage: 'Turn camera off',
    description: 'Camera toggle tooltip, on.',
  },
  '@theorem.live.flip_camera': {
    defaultMessage: 'Flip camera',
    description: 'Switches front and back camera.',
  },
  '@theorem.live.end_call': { defaultMessage: 'End call', description: 'Hangs up.' },
  '@theorem.live.new_session': {
    defaultMessage: 'New session',
    description: 'Captions divider between calls.',
  },
  '@theorem.live.controls': {
    defaultMessage: 'Call controls',
    description: 'The control toolbar (screen readers).',
  },
  '@theorem.live.camera_preview': {
    defaultMessage: 'Camera preview',
    description: 'Self-view (screen readers).',
  },
  '@theorem.live.state.calling_tool': {
    defaultMessage: 'calling {tool}',
    description: 'Call status: a tool runs.',
    params: ['tool'],
  },
  '@theorem.live.state.connecting': { defaultMessage: 'connecting', description: 'Call status.' },
  '@theorem.live.state.reconnecting': {
    defaultMessage: 'reconnecting',
    description: 'Call status: the call dropped and is being taken up again.',
  },
  '@theorem.live.state.requesting_mic': {
    defaultMessage: 'requesting mic',
    description: 'Call status.',
  },
  '@theorem.live.state.speaking': {
    defaultMessage: 'speaking',
    description: 'Call status: the agent speaks.',
  },
  '@theorem.live.state.connected': { defaultMessage: 'connected', description: 'Call status.' },
  '@theorem.live.state.muted': { defaultMessage: 'muted', description: 'Call status.' },
  '@theorem.live.state.listening': { defaultMessage: 'listening', description: 'Call status.' },
  '@theorem.live.state.error': { defaultMessage: 'error', description: 'Call status.' },
  '@theorem.live.state.ended': { defaultMessage: 'ended', description: 'Call status.' },
} as const satisfies Record<`@theorem.${string}`, LabelEntry>;

/** The default UI's catalog: each line's default message, description and values. */
export type TheoremUiCatalog = typeof THEOREM_UI_CATALOG;

/** Every line the default UI writes. */
export type TheoremLabelKey = keyof TheoremUiCatalog;

/** The values a label's message is formatted with; none for a plain line. */
export type TheoremLabelValues<K extends TheoremLabelKey> = TheoremUiCatalog[K] extends {
  params: readonly (infer P extends string)[];
}
  ? Record<P, string | number>
  : undefined;

/** Words a label; the default UI gets one from Astryx's `useTranslator`. */
export type LabelText = <K extends TheoremLabelKey>(
  key: K,
  values?: TheoremLabelValues<K>,
) => string;

/**
 * One locale's replacements: any `@theorem.*` line, and any of Astryx's own
 * (`@astryx.*`, see `@astryxdesign/core/locales/en.json`).
 */
export type TheoremLabelOverrides = { readonly [K in TheoremLabelKey]?: string } & {
  readonly [key: `@astryx.${string}`]: string;
};

/** Replacements by locale (`en`, `en-GB`, `de`, …), as Astryx's `overrides`. */
export type TheoremLabels = { readonly [locale: string]: TheoremLabelOverrides | undefined };

/** A single kind is just its word ("queued"); a mix spells out each count ("2 queued · 1 attached"). */
export function composerDrawerLabel(t: LabelText, summary: ComposerDrawerSummary): string {
  const [only] = summary.parts;
  if (summary.parts.length === 1 && only) return t(`@theorem.composer.drawer.${only.kind}`);
  return summary.parts
    .map((part) => t(`@theorem.composer.drawer.${part.kind}.count`, { n: part.n }))
    .join(t('@theorem.composer.drawer.separator'));
}

/** What a reply or a called agent used: its tokens, then its cost when the provider gave one. */
export function usageLine(t: LabelText, locale: string, tokens: TurnUsage): string {
  const count = t('@theorem.transcript.tokens', { count: tokens.total });
  if (!tokens.cost) return count;
  const usd = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumSignificantDigits: 2,
  });
  const cost = usd.format(tokens.cost.usd);
  // why: A partial cost covers only the calls that reported one.
  return `${count} · ${tokens.cost.partial ? t('@theorem.panel.trace.at_least', { value: cost }) : cost}`;
}

/** Wall-clock duration, matching Seance's builder-trace formatter: "<0.1ms", "0.4ms", "850ms", "3.2s", "12s", "1m 5s". */
export function workDuration(t: LabelText, durationMs: number): string {
  const ms = Math.max(0, durationMs);
  // why: A guardrail check can take a fraction of a millisecond; one decimal keeps it from reading as nothing.
  if (ms > 0 && ms < 0.05) return t('@theorem.duration.belowTenth');
  if (ms < 10) return t('@theorem.duration.milliseconds', { ms: Math.round(ms * 10) / 10 });
  if (ms < 1_000) return t('@theorem.duration.milliseconds', { ms: Math.round(ms) });
  if (ms < 10_000) return t('@theorem.duration.seconds', { seconds: Math.round(ms / 100) / 10 });
  if (ms < 60_000) return t('@theorem.duration.seconds', { seconds: Math.round(ms / 1_000) });
  return minutesAndSeconds(t, Math.floor(ms / 60_000), Math.round((ms % 60_000) / 1_000));
}

/** Whole-second ticker while a turn runs: "0s", "12s", "1m 5s". */
export function liveDuration(t: LabelText, durationMs: number): string {
  const total = Math.floor(Math.max(0, durationMs) / 1_000);
  if (total < 60) return t('@theorem.duration.seconds', { seconds: total });
  return minutesAndSeconds(t, Math.floor(total / 60), total % 60);
}

function minutesAndSeconds(t: LabelText, minutes: number, seconds: number): string {
  if (seconds === 0) return t('@theorem.duration.minutes', { minutes });
  return t('@theorem.duration.minutes_seconds', { minutes, seconds });
}

/** "Working for 12s" while streaming (when the start is known), "Worked for 3.2s" after. */
export function workStatusLabel(t: LabelText, status: WorkStatus | null): string {
  if (!status) return '';
  if (status.phase === 'working') {
    return status.elapsedMs === undefined
      ? t('@theorem.transcript.working')
      : t('@theorem.transcript.working_for', { duration: liveDuration(t, status.elapsedMs) });
  }
  return status.elapsedMs === undefined
    ? t('@theorem.transcript.worked')
    : t('@theorem.transcript.worked_for', { duration: workDuration(t, status.elapsedMs) });
}

/** A live call's status line; `calling_tool` names the tool. */
export function liveStateLabel(t: LabelText, state: LiveState, toolName: string | null): string {
  if (state === 'calling_tool')
    return t('@theorem.live.state.calling_tool', { tool: toolName ?? '' });
  return t(`@theorem.live.state.${state}`);
}

/** A voice note's name from its audio format; the unnamed line when the format is unknown. */
export function voiceNoteName(t: LabelText, format: string | undefined): string {
  return format ? t('@theorem.voice_note.name', { format }) : t('@theorem.voice_note.unnamed');
}

const CATALOG_KEYS: ReadonlySet<string> = new Set(Object.keys(THEOREM_UI_CATALOG));

function catalogParams(key: string): readonly string[] {
  const entry: LabelEntry | undefined = (THEOREM_UI_CATALOG as Record<string, LabelEntry>)[key];
  return entry?.params ?? [];
}

/**
 * Checks a label table before it renders: every `@theorem.*` key must exist
 * and its message must format with that key's values only; with `strict`
 * (the `labels` prop), every other key must be an `@astryx.*` line whose
 * message parses. A host's own Astryx overrides are checked for `@theorem.*`
 * keys only, since the rest may be the host app's own strings. Throws, naming
 * the locale and key, so a typo fails at mount instead of showing a raw key or
 * crashing mid-render.
 */
export function assertLabelOverrides(labels: TheoremLabels, strict: boolean): void {
  for (const [locale, table] of Object.entries(labels)) {
    if (!isLocale(locale)) throw new Error(`Theorem labels: ${locale}: not a BCP 47 locale`); // lexicon-exempt: builder contract error
    for (const [key, message] of Object.entries(table ?? {})) {
      if (!strict && !key.startsWith('@theorem.')) continue;
      const problem = labelProblem(locale, key, message);
      if (problem) throw new Error(`Theorem labels: ${locale} ${key}: ${problem}`); // lexicon-exempt: builder contract error
    }
  }
}

function isLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}

function labelProblem(locale: string, key: string, message: unknown): string | undefined {
  if (typeof message !== 'string') return 'the message must be a string';
  const theorem = key.startsWith('@theorem.');
  if (!theorem && !key.startsWith('@astryx.')) return 'keys start with @theorem. or @astryx.';
  if (theorem && !CATALOG_KEYS.has(key)) return 'no such label';
  let format: IntlMessageFormat;
  try {
    format = new IntlMessageFormat(message, locale);
  } catch (error) {
    return `not a valid ICU message (${String(error)})`;
  }
  if (!theorem) return undefined;
  const params = catalogParams(key);
  try {
    format.format(Object.fromEntries(params.map((name) => [name, 1])));
  } catch (error) {
    const allowed =
      params.length > 0
        ? `may only use ${params.map((name) => `{${name}}`).join(', ')}`
        : 'takes no values';
    return `the message ${allowed} (${String(error)})`;
  }
  return undefined;
}
