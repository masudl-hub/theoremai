import { assertAlmostEquals, assertEquals } from '@std/assert';
import {
  boxRect,
  boxSource,
  cropOf,
  droppedImages,
  imageField,
  imageName,
  namedImages,
  readImage,
  stateFields,
} from '../../react/src/client/decision-images.ts';
import { decisionInterface } from '../../web/src/client/decision-transport.ts';

const shelf = { mimeType: 'image/png', data: 'AAAA' } as const;
const lemon = { mimeType: 'image/png', data: 'BBBB' } as const;

Deno.test('imageName writes the file name as a bracketed reference, and numbers a repeat', () => {
  assertEquals(imageName('Pantry shelf.v2.png', []), '<pantry_shelf_v2>');
  assertEquals(imageName('shelf.png', ['<shelf>']), '<shelf_2>');
  assertEquals(imageName('shelf.jpg', ['<shelf>', '<shelf_2>']), '<shelf_3>');
  assertEquals(imageName('.png', []), '<image>');
});

Deno.test("boxSource is the question's image, by reference or state field, else the only image, else none", () => {
  const images = { '<shelf>': shelf, '<lemon>': lemon };
  const state = { photo: '<shelf>', chart: { strip: '<lemon>' } };
  assertEquals(boxSource(images, state, 'chart.strip'), lemon);
  assertEquals(boxSource(images, state, '<lemon>'), lemon);
  assertEquals(boxSource(images, state, 'photo'), shelf);
  assertEquals(boxSource(images, state, 'missing'), undefined);
  // The page cannot see the instructions, so with two images and no `image` it does not guess.
  assertEquals(boxSource(images, state), undefined);
  assertEquals(boxSource({ '<lemon>': lemon }, { note: 'no pictures here' }), lemon);
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

Deno.test('a box question shows the page its image and nothing of its instructions', () => {
  const view = decisionInterface(
    {
      identity: { handle: 'jev' },
      decision: { contract: 'pantry.v1' },
      inputs: { state: 'json' },
    },
    {
      Ginger: { type: 'box', instructions: 'Where is <ginger> in `photo`?' },
      Photo: { type: 'box', instructions: 'Where is the ginger?', image: 'photo' },
      Strip: { type: 'box', instructions: 'Where is the apple?', image: '<chart>' },
      Bread: { type: 'noul', instructions: 'Is there bread in `photo`?' },
    },
  );
  assertEquals(view.questions, [
    { id: 'Ginger', type: 'box', labels: [] },
    { id: 'Photo', type: 'box', labels: [], image: 'photo' },
    { id: 'Strip', type: 'box', labels: [], image: '<chart>' },
    { id: 'Bread', type: 'noul', labels: [] },
  ]);
});

Deno.test('dropped files become fields, numbered past the page, the host and the state', () => {
  const file = (name: string) => new File(['x'], name, { type: 'image/png' });
  assertEquals(
    droppedImages(
      [
        [file('shelf.png'), lemon],
        [file('shelf.png'), lemon],
      ],
      { images: { '<shelf>': shelf }, host: { '<shelf_2>': shelf }, state: { shelf_3: 'x' } },
    ),
    {
      images: { '<shelf>': shelf, '<shelf_4>': lemon, '<shelf_5>': lemon },
      state: { shelf_3: 'x', shelf_4: '<shelf_4>', shelf_5: '<shelf_5>' },
    },
  );
});

Deno.test('only a state of named fields takes dropped images', () => {
  assertEquals(stateFields({ a: 1 }), { a: 1 });
  for (const state of [null, [1], 'text', undefined]) assertEquals(stateFields(state), undefined);
});

Deno.test("boxRect puts the box in the image's pixels, with an outline that stays visible", () => {
  assertEquals(boxRect({ top: 0.25, bottom: 0.75, left: 0.5, right: 1 }, 800, 400), {
    x: 400,
    y: 100,
    width: 400,
    height: 200,
    line: 2,
  });
  assertEquals(boxRect({ top: 0, bottom: 1, left: 0, right: 1 }, 2000, 1600).line, 8);
});
