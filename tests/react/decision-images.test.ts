import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  boxSource,
  cropOf,
  imageField,
  imageName,
  namedImages,
  readImage,
} from '../../react/src/client/decision-images.ts';
import { decisionInterface } from '../../react/src/client/decision-transport.ts';

const shelf = { mimeType: 'image/png', data: 'AAAA' } as const;
const lemon = { mimeType: 'image/png', data: 'BBBB' } as const;

Deno.test('imageName writes the file name as a bracketed reference, and numbers a repeat', () => {
  assertEquals(imageName('Pantry shelf.v2.png', []), '<pantry_shelf_v2>');
  assertEquals(imageName('shelf.png', ['<shelf>']), '<shelf_2>');
  assertEquals(imageName('shelf.jpg', ['<shelf>', '<shelf_2>']), '<shelf_3>');
  assertEquals(imageName('.png', []), '<image>');
});

Deno.test('boxSource is the image the question names, or the one at its field, else the first the state names, else the first held', () => {
  const images = { '<shelf>': shelf, '<lemon>': lemon };
  const state = { photo: '<shelf>', chart: { strip: '<lemon>' } };
  assertEquals(boxSource(images, state, 'chart.strip'), lemon);
  assertEquals(boxSource(images, state, '<lemon>'), lemon);
  assertEquals(boxSource(images, state, 'photo'), shelf);
  assertEquals(boxSource(images, { fruit: ['x', '<lemon>'] }, 'missing'), lemon);
  assertEquals(boxSource(images, { note: 'no pictures here' }), shelf);
  assertEquals(boxSource({}, { a: '<shelf>' }), undefined);
});

Deno.test('a dropped file becomes a field and a reference that no image or field has yet', () => {
  assertEquals(imageField('Plant.jpg', {}, []), { key: 'plant', reference: '<plant>' });
  assertEquals(imageField('plant.jpg', { '<plant>': shelf }, []), {
    key: 'plant_2',
    reference: '<plant_2>',
  });
  assertEquals(imageField('plant.jpg', {}, ['plant']), { key: 'plant_2', reference: '<plant_2>' });
  // The host's images are taken too: a page image under one of their names is refused.
  assertEquals(imageField('ghs02.png', { '<ghs02>': shelf }, []).reference, '<ghs02_2>');
});

Deno.test('a decision sends only the held images its state still names', () => {
  const images = { '<shelf>': shelf, '<lemon>': lemon };
  assertEquals(namedImages(images, { photo: '<shelf>', note: 'a <lemon> here' }), {
    '<shelf>': shelf,
  });
  assertEquals(namedImages(images, { list: ['<lemon>'] }), { '<lemon>': lemon });
});

Deno.test('cropOf scales and offsets the image so the box fills the frame', () => {
  const crop = cropOf({ top: 0.25, bottom: 0.75, left: 0.5, right: 1 });
  assertAlmostEquals(crop.width, 200);
  assertAlmostEquals(crop.height, 200);
  assertAlmostEquals(crop.left, -100);
  assertAlmostEquals(crop.top, -50);
});

Deno.test('readImage reads a PNG or JPEG as bare base64 and refuses any other file', async () => {
  const png = new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' });
  assertEquals(await readImage(png), { mimeType: 'image/png', data: btoa('\x89PNG') });
  assertEquals(await readImage(new File(['x'], 'a.gif', { type: 'image/gif' })), null);
});

Deno.test('a box question shows the page its image, else the field its instructions first name, and nothing more', () => {
  const view = decisionInterface(
    {
      identity: { handle: 'jev' },
      decision: { contract: 'pantry.v1' },
      inputs: { state: 'json' },
    },
    {
      'Apple on the chart': {
        type: 'box',
        instructions: 'Where on `chart` would the green apple in `photo` sit?',
      },
      Ginger: { type: 'box', instructions: 'Where is <ginger>?' },
      Strip: { type: 'box', instructions: 'Where in `photo` is the apple?', image: '<chart>' },
      Bread: { type: 'noul', instructions: 'Is there bread in `photo`?' },
    },
  );
  assertEquals(view.questions, [
    { id: 'Apple on the chart', type: 'box', labels: [], field: 'chart' },
    { id: 'Ginger', type: 'box', labels: [] },
    { id: 'Strip', type: 'box', labels: [], field: '<chart>' },
    { id: 'Bread', type: 'noul', labels: [] },
  ]);
});
