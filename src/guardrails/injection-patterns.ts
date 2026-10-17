/**
 * The prompt-injection patterns, apart from the code that runs them, so the
 * egress automata generator (`scripts/gen-egress-automata.ts`) can read them
 * without the generated table it writes.
 *
 * @module
 */

const IGNORE_PREVIOUS =
  /ignore\s+(all\s+)?(previous|prior)\s+((?:safety|security|system|operational|internal|core|original|initial|existing|given|stated|provided|defined|specified|established)\s+)?(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const DISREGARD_INSTRUCTIONS =
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const FORGET_INSTRUCTIONS =
  /forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const NEW_INSTRUCTIONS = /new\s+instructions?:/gi;
const DO_NOT_FOLLOW = /do\s+not\s+follow\s+(the\s+)?(system|developer|previous|original)/gi;
const SUPERSEDE_INSTRUCTIONS =
  /supersedes?\s+(all\s+)?(prior|previous)\s+(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const VOID_INSTRUCTIONS =
  /(all\s+)?(previous|prior)\s+instructions?\s+(are|is)\s+(void|invalid|null|obsolete|cancelled|revoked)/gi;
const DEVELOPER_MODE = /you\s+are\s+now\s+(in\s+)?developer\s+mode/gi;
const ENTER_SPECIAL_MODE =
  /enter\s+(developer|admin|debug|maintenance)\s+mode(?!\s+(?:in|on|via|through|from|using|for)\b)/gi;
const ACTIVATE_SPECIAL_MODE =
  /activate\s+(developer|admin|debug|jailbreak)\s+mode(?!\s+(?:in|on|via|through|from|using|for)\b)/gi;
const SYSTEM_OVERRIDE = /\bsystem\s+override\b/gi;
const OVERRIDE_INSTRUCTIONS =
  /override\s+(your\s+)?(instructions?|rules?|guidelines?|constraints?|directives?)/gi;
const REVEAL_PROMPT =
  /reveal\s+((?:your?|yoru|yuor|the|my|its|his|her|our|their)\s+)?((?:(?:full|hidden|complete|internal|secret|original|entire|exact|actual|real)\s+){0,2})((?:system|systme|sysetm|systemp?)\s+)?prompt\b/gi;
const SHOW_PROMPT =
  /show\s+(me\s+)?((?:your?|yoru|yuor|the|my|its|his|her|our|their)\s+)((?:system|systme|sysetm|systemp?)\s+)?prompt\b/gi;
const WHAT_INSTRUCTIONS = /what\s+(are|were)\s+(your\s+)?(exact\s+)?instructions/gi;
const REPEAT_INSTRUCTIONS = /repeat\s+(the\s+)?(text|instructions?)\s+(above|before)/gi;
const OUTPUT_PROMPT = /output\s+(your\s+)?(initial|original|system)\s+(prompt|instructions?)/gi;
const REMOVE_RESTRICTIONS = /you\s+are\s+no\s+longer\s+(bound|restricted|limited)/gi;
const ACT_UNBOUND = /act\s+as\s+if\s+(you('re|\s+are)\s+)?not\s+bound/gi;
const PRETEND_DIFFERENT =
  /pretend\s+(you('re|\s+are)\s+)?(a\s+)?different\s+(ai|assistant|model)/gi;
const IDENTITY_HIJACK =
  /you\s+are\s+now\s+(?:(?:a|an)\s+)?\w+.{0,40}(without\s+(any\s+)?restrict|ignor\w*\s+(all|any|every|prev)|bypass|unrestrict|unlimit|obey\s+only|no\s+(rules|limits|restrict|boundari))/gi;
const DAN_JAILBREAK = /\bDAN\b[\s\S]{0,120}\bdo\s+anything\s+now\b/g;
const JAILBREAK_MODE = /jailbreak(ed)?\s+(mode|prompt)/gi;
const DO_ANYTHING_NOW = /\bdo\s+anything\s+now\b/gi;
const BYPASS_SAFETY =
  /bypass\s+(your\s+)?(safety|security|content|ethical)\s+(filters?|measures?|guidelines?|restrictions?)/gi;
const DISABLE_SAFETY =
  /(disable|delete|remove|turn\s+off|eliminate)\s+(all\s+)?(your\s+)?(safety|security|content)\s+(filters?|measures?|rules?|guidelines?|restrictions?)/gi;
const IGNORE_SAFETY =
  /(ignore|disregard)\s+(all\s+)?(your\s+)?(safety|security|ethical|content)\s+(guidelines?|rules?|restrictions?|measures?|filters?|polic(?:y|ies)|protocols?)/gi;
/** Bound whitespace so tag scanners cannot polynomial-backtrack on long runs. */
const TAG_WS = String.raw`[^\S\r\n]{0,32}`;
const SYSTEM_TAG = new RegExp(`<${TAG_WS}\\/?${TAG_WS}system${TAG_WS}\\/?>`, 'gi');
const ROLE_TAG = new RegExp(
  `<${TAG_WS}\\/?${TAG_WS}(assistant|developer|tool|function)${TAG_WS}\\/?>`,
  'gi',
);
const ROLE_DELIMITER = /\][^\S\r\n]{0,32}\n[^\S\r\n]{0,32}\[?(system|assistant|user)\]?:/gi;
const BRACKETED_ROLE =
  /\[[^\S\r\n]{0,32}(System[^\S\r\n]{0,8}Message|System|Assistant|Internal)[^\S\r\n]{0,32}\]/gi;
const SYSTEM_YOU_ARE = /^[^\S\r\n]{0,32}System:[^\S\r\n]{1,32}(you\s+are|ignore|override)/gim;
const CONTROL_TOKEN = /<\|(?:im_start|im_end|eot_id|start_header_id|end_header_id|endoftext)\|>/g;
const DEEPSEEK_CONTROL = /<｜(?:end▁of▁sentence|begin▁of▁sentence)｜>/g;
const LLAMA_INST = /\[\/?INST\]/gi;
const IGNORE_YOUR_INSTRUCTIONS = /ignore\s+(all\s+)?(your\s+)?(instructions?|rules?)\b/gi;
const UNRESTRICTED_MODE = /\bunrestricted\s+(ai|mode|model)\b/gi;
const IGNORE_MULTILANG =
  /\b(?:ignorieren|ignorez|ignora|ignorer|oubliez|vergessen|olvida|desestima|missachten)\b[\s\S]{0,50}\b(?:anweisungen|instructions?|instrucciones|directives?|r[eè]gles|reglas)\b/gi;

/** The verbs that tell a reader to set a thing aside, as written to give an order. */
const OVERRIDE_VERB = 'ignore|disregard|forget|override|bypass';
/** What an agent is told to set aside. */
const OVERRIDE_OBJECT = 'instructions?|rules|guidelines?|constraints?|directives?|prompts?';
const FRAME_WORD = String.raw`[\w'’-]{1,40}`;
/**
 * An order to set instructions aside, with up to `gap` words between the verb
 * and its object. `word` is what a word in the gap may be.
 */
function overrideFrame(gap: number, word: string = FRAME_WORD): string {
  return String.raw`\b(?:${OVERRIDE_VERB})\s+(?:${word}\s+){0,${gap}}(?:${OVERRIDE_OBJECT})\b`;
}
/** The verb is negated: "never ignore the rules". */
const NEGATED = String.raw`(?<!(?:\b(?:not|never|cannot|without)|n['’]t)\s+(?:${FRAME_WORD}\s+)?)`;
/** The verb is a noun: "his disregard for the rules". */
const NOUN_USE = String.raw`(?<!\b(?:the|a|an|his|her|its|their|your|my|our)\s+)`;
/**
 * The verb reports or describes, and "you" is not its subject: "an attempt to
 * bypass the rules", "I must ignore the instructions", "they override
 * constraints". "you must ignore the rules" and "I want you to ignore the
 * rules" stay orders.
 */
const DESCRIBED = String.raw`(?:(?<=\byou\s+(?:${FRAME_WORD}\s+){0,2})|(?<!\b(?:to|must|should|would|will|can|could|may|might|shall|I|we|they|he|she|it|who|that|which)\s+(?:\w+ly\s+)?))`;
/** A word in the gap that is not the writer's own: "ignore my rules" speaks of the writer's rules. */
const NOT_OWN = String.raw`(?!(?:my|our)\b)${FRAME_WORD}`;
/**
 * {@linkcode overrideFrame} where the verb gives the reader an order about
 * the reader's instructions. The patterns above still match their own wording
 * in every guarded case.
 */
const OVERRIDE_FRAME = new RegExp(
  `${NEGATED}${NOUN_USE}${DESCRIBED}${overrideFrame(3, NOT_OWN)}`,
  'gi',
);

const INJECTION_PATTERNS = [
  IGNORE_PREVIOUS,
  DISREGARD_INSTRUCTIONS,
  FORGET_INSTRUCTIONS,
  NEW_INSTRUCTIONS,
  DO_NOT_FOLLOW,
  SUPERSEDE_INSTRUCTIONS,
  VOID_INSTRUCTIONS,
  DEVELOPER_MODE,
  ENTER_SPECIAL_MODE,
  ACTIVATE_SPECIAL_MODE,
  SYSTEM_OVERRIDE,
  OVERRIDE_INSTRUCTIONS,
  REVEAL_PROMPT,
  SHOW_PROMPT,
  WHAT_INSTRUCTIONS,
  REPEAT_INSTRUCTIONS,
  OUTPUT_PROMPT,
  REMOVE_RESTRICTIONS,
  ACT_UNBOUND,
  PRETEND_DIFFERENT,
  IDENTITY_HIJACK,
  DAN_JAILBREAK,
  JAILBREAK_MODE,
  DO_ANYTHING_NOW,
  BYPASS_SAFETY,
  DISABLE_SAFETY,
  IGNORE_SAFETY,
  SYSTEM_TAG,
  ROLE_TAG,
  ROLE_DELIMITER,
  BRACKETED_ROLE,
  SYSTEM_YOU_ARE,
  CONTROL_TOKEN,
  DEEPSEEK_CONTROL,
  LLAMA_INST,
  IGNORE_YOUR_INSTRUCTIONS,
  UNRESTRICTED_MODE,
  IGNORE_MULTILANG,
  OVERRIDE_FRAME,
];

/** Runs that might encode an injection; each is decoded and checked in `injection.ts`. */
const BASE64_BLOB = /[A-Za-z0-9+/]{16,}={0,2}/g;
const HEX_BLOB = /(?:[0-9a-f]{2}[\s]?){8,}/gi;
const SPACED_LETTERS = /\b(?:[A-Za-z] ){3,}[A-Za-z]\b/g;
/** Three+ alphabetic tokens joined by `|` (no shell spaces around pipes). */
const PIPE_SEPARATED = /\b(?:[A-Za-z]+\|){2,}[A-Za-z]+\b/g;

export { BASE64_BLOB, HEX_BLOB, INJECTION_PATTERNS, overrideFrame, PIPE_SEPARATED, SPACED_LETTERS };
