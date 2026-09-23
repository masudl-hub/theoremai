import { ATTACHMENT_ACCEPT_MIMES, VOICE_ACCEPT_MIMES } from '../src/kernel/schema.ts';
import type { PlaygroundInputsSpec, PlaygroundToolSeed } from './types.ts';

const DEMO_ATTACHMENT_ACCEPT = ATTACHMENT_ACCEPT_MIMES.filter(
  (mime) => mime === 'image/*' || mime === 'application/pdf' || mime.startsWith('text/'),
);
const DEMO_VOICE_ACCEPT = VOICE_ACCEPT_MIMES.filter((mime) => mime === 'audio/*');

const NOMINATIM_HEADERS = `{
  "User-Agent": "TheoremPlayground/1.0 (travel demo; +https://github.com/theoremai)"
}`;

const DISCOVER_LOADED = ['get_cat_fact', 'tell_joke', 'get_advice', 'random_dog_image'] as const;

/** Sample inputs for HTTP demo tools (connection tests and smoke scripts). */
export const DEMO_HTTP_SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  geocode_city: { name: 'Paris' },
  search_places: { q: 'Paris', limit: 1 },
  reverse_geocode: { lat: 48.85, lon: 2.35 },
  get_weather: { latitude: 48.85, longitude: 2.35 },
  get_sun_times: { lat: 48.85, lng: 2.35 },
  convert_currency: { from: 'USD', to: 'EUR', amount: 100 },
  wikipedia_summary: { title: 'Paris' },
  archive_text_search: { q: 'mediatype:texts AND travel', rows: 1 },
  lookup_postal_code: { country: 'us', postal: '90210' },
  get_pokemon: { name: 'pikachu' },
  get_cat_fact: {},
  tell_joke: {},
  get_advice: {},
  random_dog_image: {},
};

/** Lookup a smoke-test / connection-test payload for a travel demo HTTP tool. */
export function demoHttpSampleInput(toolName: string): Record<string, unknown> | undefined {
  return DEMO_HTTP_SAMPLE_INPUT[toolName];
}

/** Comma-separated hosts for guardrails.egress allowlist in the demo graph. */
export const DEMO_ALLOWED_HOSTS =
  'nominatim.openstreetmap.org, geocoding-api.open-meteo.com, api.open-meteo.com, api.frankfurter.dev, api.sunrise-sunset.org, api.zippopotam.us, en.wikipedia.org, archive.org, pokeapi.co, dog.ceo, api.adviceslip.com, catfact.ninja, official-joke-api.appspot.com, mcp.deepwiki.com';

/** System prompt for the playground demo agent. */
export const DEMO_CONCIERGE_SYSTEM = `Role: Elite, charismatic travel concierge.

Communication Standards:
- Readable Formatting: Use markdown where it helps the reader: short headings, bullet lists, bold for key names, and tables for side-by-side comparisons.
- Adaptive Pacing: Deliver high-signal, concise answers. Avoid overwhelming monologues; provide the immediate insight or recommendation first, then offer a natural next step.

Tool & Fact Grounding:
- Absolute Grounding: Ground all dynamic facts (weather, currency conversions, distances, geography, destination research) using available tools before answering. Never invent live data.
- Silent Execution: Never narrate tool calls, announce function names, or reference underlying APIs. Seamlessly integrate verified findings into your response.
- Complete Resolution: Execute multi-step tool chains silently to completion before delivering the synthesized answer.

Multimodal Understanding:
- Immediately extract actionable constraints (dates, flight times, locations, budgets) from provided images, documents, tickets, or audio, and weave them directly into your response.`;

/** Inputs facet seed — text, attachments, voice, and size limits enabled. */
export function demoInputsSpec(): PlaygroundInputsSpec {
  return {
    text: true,
    attachmentsAccept: DEMO_ATTACHMENT_ACCEPT,
    voiceAccept: DEMO_VOICE_ACCEPT,
    maxFiles: 5,
    maxBytes: 10_485_760,
    maxTurnBytes: 26_214_400,
  };
}

/** Tool facet seeds for the travel concierge demo (positions assigned by graph layout). */
const DEMO_TOOL_SPECS: PlaygroundToolSeed[] = [
  // --- Geocoding & weather (free, no Google attribution) ---
  {
    id: 'tool-geocode-city',
    data: {
      toolName: 'geocode_city',
      toolType: 'http',
      description:
        'Resolve a city or place name to coordinates using the Open-Meteo geocoding API.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://geocoding-api.open-meteo.com/v1/search?count=3',
      method: 'GET',
      queryParams: 'name',
      inputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "City or place name" }
  },
  "required": ["name"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "latitude": { "type": "number" },
          "longitude": { "type": "number" },
          "country_code": { "type": "string" }
        }
      }
    }
  }
}`,
    },
  },
  {
    id: 'tool-search-places',
    data: {
      toolName: 'search_places',
      toolType: 'http',
      description:
        'Search OpenStreetMap Nominatim for places (free alternative to paid maps APIs).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1',
      method: 'GET',
      headersJson: NOMINATIM_HEADERS,
      queryParams: 'q, limit',
      inputJson: `{
  "type": "object",
  "properties": {
    "q": { "type": "string", "description": "Place search query" },
    "limit": { "type": "number", "description": "Max results (1-5)" }
  },
  "required": ["q"]
}`,
      outputJson: `{ "type": "array" }`,
    },
  },
  {
    id: 'tool-reverse-geocode',
    data: {
      toolName: 'reverse_geocode',
      toolType: 'http',
      description: 'Reverse geocode coordinates to a place label via OpenStreetMap Nominatim.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://nominatim.openstreetmap.org/reverse?format=json',
      method: 'GET',
      headersJson: NOMINATIM_HEADERS,
      queryParams: 'lat, lon',
      inputJson: `{
  "type": "object",
  "properties": {
    "lat": { "type": "number" },
    "lon": { "type": "number" }
  },
  "required": ["lat", "lon"]
}`,
      outputJson: `{ "type": "object" }`,
    },
  },
  {
    id: 'tool-get-weather',
    data: {
      toolName: 'get_weather',
      toolType: 'http',
      description: 'Fetch current weather for coordinates via Open-Meteo.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://api.open-meteo.com/v1/forecast?current_weather=true',
      method: 'GET',
      queryParams: 'latitude, longitude',
      inputJson: `{
  "type": "object",
  "properties": {
    "latitude": { "type": "number" },
    "longitude": { "type": "number" }
  },
  "required": ["latitude", "longitude"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "current_weather": {
      "type": "object",
      "properties": {
        "temperature": { "type": "number" },
        "windspeed": { "type": "number" },
        "weathercode": { "type": "number" },
        "time": { "type": "string" }
      }
    }
  }
}`,
    },
  },
  {
    id: 'tool-sun-times',
    data: {
      toolName: 'get_sun_times',
      toolType: 'http',
      description: 'Sunrise, sunset, and day length for coordinates (sunrise-sunset.org).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://api.sunrise-sunset.org/json',
      method: 'GET',
      queryParams: 'lat, lng',
      inputJson: `{
  "type": "object",
  "properties": {
    "lat": { "type": "number" },
    "lng": { "type": "number" }
  },
  "required": ["lat", "lng"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "results": { "type": "object" },
    "status": { "type": "string" }
  }
}`,
    },
  },
  // --- Money & units ---
  {
    id: 'tool-convert-currency',
    data: {
      toolName: 'convert_currency',
      toolType: 'http',
      description: 'Convert an amount between ISO currencies using ECB reference rates.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://api.frankfurter.dev/v1/latest',
      method: 'GET',
      queryParams: 'from, to, amount',
      inputJson: `{
  "type": "object",
  "properties": {
    "from": { "type": "string" },
    "to": { "type": "string" },
    "amount": { "type": "number" }
  },
  "required": ["from", "to", "amount"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "amount": { "type": "number" },
    "base": { "type": "string" },
    "rates": { "type": "object" }
  }
}`,
    },
  },
  {
    id: 'tool-convert-units',
    data: {
      toolName: 'convert_units',
      toolType: 'function',
      description: 'Convert temperature (c/f/k) or distance (km/mi) locally — no network call.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{
  "type": "object",
  "properties": {
    "value": { "type": "number" },
    "from": { "type": "string", "description": "c, f, k, km, or mi" },
    "to": { "type": "string" }
  },
  "required": ["value", "from", "to"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "value": { "type": "number" },
    "from": { "type": "string" },
    "to": { "type": "string" },
    "result": { "type": "number" }
  },
  "required": ["result"]
}`,
    },
  },
  {
    id: 'tool-haversine',
    data: {
      toolName: 'haversine_distance',
      toolType: 'function',
      description: 'Great-circle distance between two lat/lon pairs in km and miles.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{
  "type": "object",
  "properties": {
    "lat1": { "type": "number" },
    "lon1": { "type": "number" },
    "lat2": { "type": "number" },
    "lon2": { "type": "number" }
  },
  "required": ["lat1", "lon1", "lat2", "lon2"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "km": { "type": "number" },
    "mi": { "type": "number" }
  },
  "required": ["km", "mi"]
}`,
    },
  },
  // --- Research ---
  {
    id: 'tool-wikipedia',
    data: {
      toolName: 'wikipedia_summary',
      toolType: 'http',
      description: 'Fetch the Wikipedia REST summary for a page title.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://en.wikipedia.org/api/rest_v1/page/summary/{title}',
      method: 'GET',
      pathParams: 'title',
      inputJson: `{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "Wikipedia page title, e.g. Paris" }
  },
  "required": ["title"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "extract": { "type": "string" },
    "description": { "type": "string" }
  }
}`,
    },
  },
  {
    id: 'tool-archive-search',
    data: {
      toolName: 'archive_text_search',
      toolType: 'http',
      description: 'Search Internet Archive texts (books) by title or keywords.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      // Archive.org advanced search — Open Library TLS is unreachable from many networks.
      endpoint:
        'https://archive.org/advancedsearch.php?output=json&fl[]=identifier&fl[]=title&fl[]=creator',
      method: 'GET',
      queryParams: 'q, rows',
      inputJson: `{
  "type": "object",
  "properties": {
    "q": { "type": "string" },
    "rows": { "type": "number" }
  },
  "required": ["q"]
}`,
      outputJson: `{ "type": "object" }`,
    },
  },
  {
    id: 'tool-postal',
    data: {
      toolName: 'lookup_postal_code',
      toolType: 'http',
      description: 'Look up place names for a postal code via Zippopotam (no API key).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://api.zippopotam.us/{country}/{postal}',
      method: 'GET',
      pathParams: 'country, postal',
      inputJson: `{
  "type": "object",
  "properties": {
    "country": { "type": "string", "description": "ISO country code, e.g. us or fr" },
    "postal": { "type": "string" }
  },
  "required": ["country", "postal"]
}`,
      outputJson: `{ "type": "object" }`,
    },
  },
  // --- MCP (DeepWiki — no Google Maps / grounding attribution) ---
  {
    id: 'tool-ask-deepwiki',
    data: {
      toolName: 'ask_repo_docs',
      toolType: 'mcp',
      description: 'Ask questions about a public GitHub repo via DeepWiki MCP (Streamable HTTP).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      serverUrl: 'https://mcp.deepwiki.com/mcp',
      mcpToolName: 'ask_question',
      inputJson: `{
  "type": "object",
  "properties": {
    "repoName": { "type": "string", "description": "owner/repo, e.g. sveltejs/kit" },
    "question": { "type": "string" }
  },
  "required": ["repoName", "question"]
}`,
      outputJson: `{ "type": "string", "description": "Answer text from DeepWiki" }`,
    },
  },
  // --- T2 loader ---
  {
    id: 'tool-discover-tools',
    data: {
      toolName: 'discover_tools',
      toolType: 'function',
      description:
        'Discover bonus entertainment tools for this turn. Call before get_cat_fact, tell_joke, get_advice, or random_dog_image.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "loaded": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["loaded"]
}`,
      stubOutputJson: JSON.stringify({ loaded: [...DISCOVER_LOADED] }),
    },
  },
  // --- Function stubs / local logic ---
  {
    id: 'tool-weather-label',
    data: {
      toolName: 'weather_code_label',
      toolType: 'function',
      description: 'Translate an Open-Meteo WMO weathercode into a short label.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{
  "type": "object",
  "properties": {
    "weathercode": { "type": "number" }
  },
  "required": ["weathercode"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "weathercode": { "type": "number" },
    "label": { "type": "string" }
  },
  "required": ["label"]
}`,
    },
  },
  {
    id: 'tool-plan-day',
    data: {
      toolName: 'plan_day',
      toolType: 'function',
      description: 'Draft a simple day plan from destination context (playground stub).',
      category: 'demo',
      access: 'read-write',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{
  "type": "object",
  "properties": {
    "destination": { "type": "string" },
    "focus": { "type": "string" }
  },
  "required": ["destination"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "stops": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["summary", "stops"]
}`,
      stubOutputJson: `{
  "summary": "A balanced day mixing local culture, a weather-aware outdoor block, and an easy evening.",
  "stops": [
    "Morning: coffee near the main square",
    "Midday: flagship museum or gallery",
    "Afternoon: walkable neighborhood based on weather",
    "Evening: casual dinner with a local specialty"
  ]
}`,
    },
  },
  {
    id: 'tool-trip-budget',
    data: {
      toolName: 'trip_budget_estimate',
      toolType: 'function',
      description: 'Estimate trip cost from days × per-diem (local math, no FX).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{
  "type": "object",
  "properties": {
    "days": { "type": "number" },
    "perDiem": { "type": "number" },
    "currency": { "type": "string" }
  },
  "required": ["days", "perDiem"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "days": { "type": "number" },
    "perDiem": { "type": "number" },
    "currency": { "type": "string" },
    "total": { "type": "number" }
  },
  "required": ["total"]
}`,
    },
  },
  {
    id: 'tool-packing',
    data: {
      toolName: 'packing_suggestions',
      toolType: 'function',
      description: 'Suggest a packing list from temperature and activity type.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      inputJson: `{
  "type": "object",
  "properties": {
    "tempC": { "type": "number" },
    "activity": { "type": "string" }
  },
  "required": ["tempC"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "tempC": { "type": "number" },
    "activity": { "type": "string" },
    "items": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["items"]
}`,
    },
  },
  {
    id: 'tool-get-pokemon',
    data: {
      toolName: 'get_pokemon',
      toolType: 'http',
      description: 'Look up a Pokémon by name from the public PokéAPI.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: '*',
      endpoint: 'https://pokeapi.co/api/v2/pokemon/{name}',
      method: 'GET',
      pathParams: 'name',
      inputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string" }
  },
  "required": ["name"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "height": { "type": "number" },
    "weight": { "type": "number" }
  }
}`,
    },
  },
  // --- T2 entertainment (require discover_tools) ---
  {
    id: 'tool-cat-fact',
    data: {
      toolName: 'get_cat_fact',
      toolType: 'http',
      description: 'Return a random cat fact (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: '*',
      endpoint: 'https://catfact.ninja/fact?max_length=160',
      method: 'GET',
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "fact": { "type": "string" },
    "length": { "type": "number" }
  },
  "required": ["fact"]
}`,
    },
  },
  {
    id: 'tool-tell-joke',
    data: {
      toolName: 'tell_joke',
      toolType: 'http',
      description: 'Tell a random joke (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: '*',
      endpoint: 'https://official-joke-api.appspot.com/random_joke',
      method: 'GET',
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "setup": { "type": "string" },
    "punchline": { "type": "string" }
  },
  "required": ["setup", "punchline"]
}`,
    },
  },
  {
    id: 'tool-advice',
    data: {
      toolName: 'get_advice',
      toolType: 'http',
      description: 'Random travel-style advice slip (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: '*',
      endpoint: 'https://api.adviceslip.com/advice',
      method: 'GET',
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "slip": {
      "type": "object",
      "properties": {
        "advice": { "type": "string" }
      }
    }
  }
}`,
    },
  },
  {
    id: 'tool-dog-image',
    data: {
      toolName: 'random_dog_image',
      toolType: 'http',
      description: 'Random dog photo URL from dog.ceo (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: '*',
      endpoint: 'https://dog.ceo/api/breeds/image/random',
      method: 'GET',
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "message": { "type": "string" },
    "status": { "type": "string" }
  },
  "required": ["message"]
}`,
    },
  },
];

/** Tool facet seeds for the travel concierge demo (positions assigned by graph layout). */
export function demoToolSpecs(): PlaygroundToolSeed[] {
  return DEMO_TOOL_SPECS;
}
