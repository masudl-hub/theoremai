import { assertEquals } from '@std/assert';
import { cookbookToolMedia } from '../cookbooks/media.ts';

function mediaOf(name: string, output: unknown): unknown {
  const media = cookbookToolMedia(name);
  if (!media) throw new Error(`${name} has no media hook`);
  return media(output);
}

Deno.test('random_dog_image sends the picture its message names', () => {
  assertEquals(
    mediaOf('random_dog_image', { message: 'https://images.dog.ceo/breeds/a.jpg', status: 'ok' }),
    [{ url: 'https://images.dog.ceo/breeds/a.jpg', sent: true }],
  );
});

Deno.test('wikipedia_summary sends the original image, not the thumbnail', () => {
  assertEquals(
    mediaOf('wikipedia_summary', {
      title: 'Paris',
      thumbnail: { source: 'https://upload.wikimedia.org/thumb/Paris.jpg' },
      originalimage: { source: 'https://upload.wikimedia.org/Paris.jpg' },
    }),
    [{ url: 'https://upload.wikimedia.org/Paris.jpg', sent: true }],
  );
});

Deno.test('get_pokemon sends only the official artwork', () => {
  assertEquals(
    mediaOf('get_pokemon', {
      name: 'pikachu',
      sprites: {
        front_default: 'https://example.org/front.png',
        other: { 'official-artwork': { front_default: 'https://example.org/art.png' } },
      },
    }),
    [{ url: 'https://example.org/art.png', sent: true }],
  );
});

Deno.test('a cookbook tool with no picture in its output sends nothing', () => {
  assertEquals(mediaOf('random_dog_image', { status: 'error' }), []);
  assertEquals(mediaOf('wikipedia_summary', { title: 'Nowhere', extract: '' }), []);
  assertEquals(mediaOf('get_pokemon', { name: 'missingno', sprites: { other: {} } }), []);
  assertEquals(mediaOf('get_pokemon', 'not an object'), []);
});

Deno.test('tools without pictures get no media hook', () => {
  assertEquals(cookbookToolMedia('get_weather'), undefined);
  assertEquals(cookbookToolMedia('search_web'), undefined);
});
