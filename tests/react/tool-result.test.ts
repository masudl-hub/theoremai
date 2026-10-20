import { assert, assertEquals } from '@std/assert';
import {
  hasLead,
  layoutResult,
  returnedMedia,
  timeFormats,
} from '../../react/src/client/tool-result.ts';

const forecast = {
  latitude: 48.85,
  longitude: 2.35,
  generationtime_ms: 0.04,
  utc_offset_seconds: 0,
  elevation: 43,
  current_weather_units: {
    time: 'iso8601',
    interval: 'seconds',
    temperature: '°C',
    windspeed: 'km/h',
    weathercode: 'wmo code',
    is_day: '',
  },
  current_weather: {
    time: '2026-09-29T12:00',
    interval: 900,
    temperature: 18.2,
    windspeed: 11.5,
    weathercode: 3,
    is_day: 1,
  },
  daily_units: {
    time: 'iso8601',
    temperature_2m_max: '°C',
    temperature_2m_min: '°C',
    precipitation_probability_max: '%',
  },
  daily: {
    time: ['2026-09-29', '2026-09-30', '2026-10-01'],
    temperature_2m_max: [19, 21, 17],
    temperature_2m_min: [11, 12, 9],
    precipitation_probability_max: [10, 40, 80],
  },
};

Deno.test('layoutResult leads a forecast with its current reading, not the echoed request', () => {
  const { figures } = layoutResult(forecast);
  assertEquals(
    figures.map((figure) => [figure.key, figure.unit]),
    [
      ['temperature', '°C'],
      ['windspeed', 'km/h'],
    ],
  );
});

Deno.test('layoutResult charts a column store over time, one chart per unit', () => {
  const { charts } = layoutResult(forecast);
  assertEquals(
    charts.map((chart) => [
      chart.kind,
      chart.kind === 'time' ? chart.series.map((series) => series.key) : [],
    ]),
    [
      ['time', ['temperature_2m_max', 'temperature_2m_min']],
      ['time', ['precipitation_probability_max']],
    ],
  );
  assertEquals(charts[0]?.kind === 'time' ? charts[0].x : undefined, 'time');
});

Deno.test('layoutResult ranks named rows by the number that varies most', () => {
  const { charts } = layoutResult({
    results: [
      { id: 1, name: 'Paris', latitude: 48.8, population: 2_100_000, rank: 1 },
      { id: 2, name: 'Lyon', latitude: 45.7, population: 520_000, rank: 1 },
      { id: 3, name: 'Nice', latitude: 43.7, population: 340_000, rank: 1 },
    ],
  });
  assertEquals(charts.length, 1);
  const [chart] = charts;
  assertEquals(chart?.kind, 'category');
  if (chart?.kind !== 'category') return;
  assertEquals(chart.series.key, 'population');
  assertEquals(
    chart.rows.map((row) => row.label),
    ['Paris', 'Lyon', 'Nice'],
  );
});

Deno.test('layoutResult reads an object of numbers as figures when short, bars when long', () => {
  const short = layoutResult({ amount: 1, base: 'EUR', rates: { USD: 1.08 } });
  assertEquals(
    short.figures.map((figure) => [figure.label, figure.value]),
    [['USD', 1.08]],
  );
  assertEquals(short.charts, []);
  const long = layoutResult({ rates: { USD: 1.08, GBP: 0.85, JPY: 160 } });
  const [bars] = long.charts;
  assertEquals(bars?.kind === 'category' ? bars.rows.map((row) => row.label) : [], [
    'JPY',
    'USD',
    'GBP',
  ]);
});

Deno.test('layoutResult finds image links anywhere, each once', () => {
  const { images } = layoutResult({
    message: 'https://images.dog.ceo/breeds/hound/n02089.jpg',
    sprites: {
      front: 'https://img.example/a.png',
      back: 'https://img.example/a.png',
      page: 'https://example.com',
    },
  });
  assertEquals(
    images.map((image) => image.src),
    ['https://images.dog.ceo/breeds/hound/n02089.jpg', 'https://img.example/a.png'],
  );
});

Deno.test('layoutResult leaves plain text and short lists to the data view', () => {
  assertEquals(layoutResult('just text'), { figures: [], charts: [], images: [] });
  assertEquals(
    layoutResult({
      items: [
        { name: 'a', size: 1 },
        { name: 'b', size: 2 },
      ],
    }).charts,
    [],
  );
});

Deno.test('layoutResult titles series by the words they share', () => {
  const { charts } = layoutResult({
    daily: {
      time: ['2026-09-29', '2026-09-30', '2026-10-01'],
      temperature_2m_max: [21, 24, 19],
      temperature_2m_min: [12, 14, 11],
    },
    daily_units: { time: 'iso8601', temperature_2m_max: '°C', temperature_2m_min: '°C' },
  });
  const [chart] = charts;
  assertEquals(chart?.title, 'Temperature 2m');
  assertEquals(chart?.kind === 'time' ? chart.series.map((series) => series.label) : [], [
    'Max',
    'Min',
  ]);
});

Deno.test('layoutResult labels bars by the field that tells rows apart', () => {
  const place = (display_name: string, addresstype: string, importance: number) => ({
    name: 'Paris',
    display_name,
    addresstype,
    importance,
  });
  const { charts } = layoutResult([
    place('Paris, Île-de-France, France', 'city', 0.9),
    place('Paris, Lamar County, Texas, United States', 'town', 0.53),
    place('Paris, Henry County, Tennessee, United States', 'village', 0.46),
  ]);
  const [chart] = charts;
  assertEquals(chart?.kind === 'category' ? chart.rows.map((row) => row.label) : [], [
    'city',
    'town',
    'village',
  ]);
});

Deno.test('returned media: image parts lead the linked images, audio keeps its type, bare parts drop', () => {
  const layout = layoutResult({ photo: 'https://example.com/dog.jpg' });
  const media = returnedMedia(
    layout,
    [
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' },
      { type: 'image' },
    ],
    'Returned image',
  );
  assertEquals(media.images, [
    { src: 'data:image/png;base64,AAAA', alt: 'Returned image' },
    ...layout.images,
  ]);
  assertEquals(media.audio, [{ src: 'data:audio/wav;base64,BBBB', mimeType: 'audio/wav' }]);
  assert(hasLead(layout, media));
  const empty = layoutResult('ok');
  assert(!hasLead(empty, returnedMedia(empty, [], 'Returned image')));
});

Deno.test('time formats: hours within a day, dates past it, bare dates read in UTC', () => {
  assertEquals(timeFormats(['2026-09-30T00:00', '2026-09-30T23:00']).tick, { hour: 'numeric' });
  assertEquals(timeFormats(['2026-09-01T00:00', '2026-09-30T00:00']).tick, {
    month: 'short',
    day: 'numeric',
  });
  const days = timeFormats(['2026-09-29', '2026-09-30']);
  assertEquals(days.tick, { weekday: 'short', timeZone: 'UTC' });
  assertEquals(days.when, { dateStyle: 'medium', timeZone: 'UTC' });
  const month = Array.from(
    { length: 12 },
    (_, day) => `2026-09-${String(day + 1).padStart(2, '0')}`,
  );
  assertEquals(timeFormats(month).tick, { month: 'short', day: 'numeric', timeZone: 'UTC' });
});
