# Writing rules: about 80% of ASD-STE100

ASD-STE100 (Simplified Technical English) is a controlled language for maintenance manuals. Its aim: one reading, for every reader, including people who learned English second. Theorem docs follow its rules for sentences and words. They relax its rules for dictionary and layout, because software needs words the STE dictionary does not have. That relaxation is the missing 20%.

## Rules to keep (the 80%)

| Rule | Do | Do not |
| --- | --- | --- |
| Sentence length | 20 words or fewer for description, 25 for steps | "The handler, which you mount once and which reads the profile that you pass in, then returns..." |
| One idea per sentence | Split at "and", "which", "so that" when two ideas meet | Chain three clauses |
| Active voice | "The server checks the token." | "The token is checked by the server." Passive is allowed only when the actor is unknown or does not matter |
| Simple tenses | Present for facts, future for what happens next, past for what happened | Perfect and conditional forms where present works |
| One word, one meaning | `profile` always means the agent profile | `profile`, `config`, `definition`, `spec` for one thing |
| Same word, same part of speech | "A `block` is an output unit." Do not also use "block" as a verb for guardrail blocking in the same doc: use "stop" | |
| Imperative steps | "Mount the handler." | "You should now mount the handler." |
| Keep articles | "The handler returns a `Response`." | "Handler returns `Response`." |
| No idioms, no figures | "start", "remove", "fail" | "spin up", "wire up", "under the hood", "out of the box", "bake in" |
| Noun clusters up to 3 | "profile guardrail setting" | "agent profile guardrail action selection logic" |
| Explicit logic | "If the profile has no file input, the UI shows no attach button." | "The UI adapts to the profile." |
| Concrete verbs | "returns", "rejects", "strips", "reads" | "handles", "manages", "leverages", "supports" with no object |
| No hedges | State it, or prove it, or delete it | "usually", "typically", "should generally", "may in some cases" |
| Lists for parallel items | Vertical list, same grammar in each item | A sentence with five commas |
| Polite, never curt | See "Tone" below | "Load the font yourself." |
| Warnings first | Put "Note:" or "Warning:" before the step it protects | After the step, when the damage is done |

## Where you may relax (the 20%)

- Use technical names that STE has no entry for: `AbortSignal`, `SSE`, `StyleX`. Gloss each once, in a clause, at first use.
- Use verbs STE does not list, when the plain verb is the standard one in software: "parse", "mount", "serialize". Keep them consistent.
- Let a table cell be a fragment. Tables are not prose.
- Allow a sentence up to 30 words when it carries a type signature or a path. Do not let it carry two ideas.
- Allow one paragraph of up to 6 sentences in an explanation section. In a procedure, keep paragraphs to 3 sentences.
- Allow a present participle where it is a name ("streaming mode"). Do not use it to hide the actor ("Using the handler, ...").

## Before and after

**Hedged and vague**
- Before: "The hooks do what the components do, without drawing anything."
- After: "`useTheoremChat` gives you the chat state and actions. It renders nothing. Use it when you build your own interface."

**Passive, two ideas**
- Before: "Sessions are identified by a cookie, which is set by the handler if one is not already present."
- After: "The handler reads the session from the `theorem_session` cookie. If the cookie is missing, the handler sets it."

**Idiom**
- Before: "Wire up the handler and you're off to the races."
- After: "Mount the handler on one route. The chat works when the route answers."

**Feature without a use case**
- Before: "`onChatChange` is called when the chat changes."
- After: "Use `onChatChange` to save the chat. The component calls it after every change and passes the whole chat."

**Soft claim**
- Before: "The kernel typically retries transient failures."
- After: "The kernel retries a request that fails with a network error or a 5xx status. It makes up to N attempts." (Replace N with the value from the code. If you cannot find it, remove the sentence.)

## Tone: polite and plain

Theorem's own words to users are polite. Read `src/guardrails/lexicon.ts`: "Sorry, the model isn't available at the moment. Please try again shortly." Docs speak in the same voice. The reader is a capable colleague, not a person to command or correct.

| Do | Do not |
| --- | --- |
| "To use Figtree, load the font in your app. Without it, the theme uses the system font." | "Load the font yourself if you want it." |
| "You can skip this step if the profile has no tools." | "Just skip this if you have no tools." |
| "The handler needs a session. If you do not pass one, it sets a cookie." | "You forgot to pass a session." |
| "Please open an issue if the check fails on a valid doc." | "Open an issue." (as a dismissal) |
| Describe what the code does. | "Obviously", "simply", "just", "easy", "of course", "yourself" |

- Steps stay imperative: "Mount the handler." An imperative step is clear, not rude. Add "please" only where you ask the reader for something outside the task, such as a bug report.
- Say what the reader gains or loses, not what they should have done. Offer a way forward after every limit: "The package does not include the font. To use it, ..."
- Never blame the reader, the user or another team. Describe the state, then the fix.
- No sarcasm, no jokes, no exclamation marks.
- Quote user-facing wording from the lexicon. Do not rewrite it.

## Terms: keep a glossary as you write

Before you write, list the 5 to 10 nouns the doc rests on. Give each one name and one definition. Check the finished doc for a second name for any of them. Search the repo's own lexicon or contract first: the code's word is the doc's word.

## Jargon

Gloss ML and security terms in one clause on first use: "out-of-distribution (OOD): input unlike the data the detector learned from". The reader is capable. They may not work in ML.

## Headings and structure

- Headings name the task or the thing: "Save and restore a chat", not "Persistence considerations".
- Open each section with its use case (see `docs/writing/README.md` step 2), then the minimum that works, then options.
- Put the shortest working example before any option table.
- Use tables for names, options, defaults and limits. Use numbered lists for steps. Use prose for reasons.
