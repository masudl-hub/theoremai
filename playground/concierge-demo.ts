import { ATTACHMENT_ACCEPT_MIMES, VOICE_ACCEPT_MIMES } from '../src/kernel/schema.ts';
import type { PlaygroundInputsSpec, PlaygroundToolSeed } from './types.ts';

const DEMO_ATTACHMENT_ACCEPT = ATTACHMENT_ACCEPT_MIMES.filter(
  (mime) => mime === 'image/*' || mime === 'application/pdf' || mime.startsWith('text/'),
);
const DEMO_VOICE_ACCEPT = VOICE_ACCEPT_MIMES.filter((mime) => mime === 'audio/*');

// Nominatim and Wikipedia refuse requests that don't name their client.
const DEMO_CLIENT_HEADERS = `{
  "User-Agent": "TheoremPlayground/1.0 (travel demo; +https://github.com/masudl-hub/theoremai)"
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

export function demoHttpSampleInput(toolName: string): Record<string, unknown> | undefined {
  return DEMO_HTTP_SAMPLE_INPUT[toolName];
}

/** Comma-separated hosts for guardrails.egress allowlist in the demo graph. */
export const DEMO_ALLOWED_HOSTS =
  'nominatim.openstreetmap.org, geocoding-api.open-meteo.com, api.open-meteo.com, api.frankfurter.dev, api.sunrise-sunset.org, api.zippopotam.us, en.wikipedia.org, archive.org, pokeapi.co, dog.ceo, api.adviceslip.com, catfact.ninja, official-joke-api.appspot.com, mcp.deepwiki.com, mcp.context7.com, learn.microsoft.com, docs.mcp.cloudflare.com, knowledge-mcp.global.api.aws, huggingface.co, mcp.docs.astro.build, mcp.exa.ai';

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

const DEMO_TOOL_SPECS: PlaygroundToolSeed[] = [
  // --- Geocoding & weather (free, no Google attribution) ---
  {
    id: 'tool-geocode-city',
    data: {
      toolName: 'geocode_city',
      activity: 'Finding {name}',
      activityPast: 'Found {results.0.name}',
      request: 'find {name}',
      toolType: 'http',
      description:
        'Resolve a city or place name to coordinates using the Open-Meteo geocoding API.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://geocoding-api.open-meteo.com/v1/search?count=3',
      method: 'GET',
      queryParams: ['name'],
      inputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string", "examples": ["Paris"], "description": "City or place name" }
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
      activity: 'Searching for {q}',
      activityPast: 'Searched for {q}',
      request: 'search for {q}',
      toolType: 'http',
      description:
        'Search OpenStreetMap Nominatim for places (free alternative to paid maps APIs).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1',
      method: 'GET',
      headersJson: DEMO_CLIENT_HEADERS,
      queryParams: ['q', 'limit'],
      inputJson: `{
  "type": "object",
  "properties": {
    "q": { "type": "string", "examples": ["Paris"], "description": "Place search query" },
    "limit": { "type": "number", "examples": [5], "description": "Max results (1-5)" }
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
      activity: 'Finding this spot',
      activityPast: 'Found this spot',
      request: 'find this spot',
      toolType: 'http',
      description: 'Reverse geocode coordinates to a place label via OpenStreetMap Nominatim.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://nominatim.openstreetmap.org/reverse?format=json',
      method: 'GET',
      headersJson: DEMO_CLIENT_HEADERS,
      queryParams: ['lat', 'lon'],
      inputJson: `{
  "type": "object",
  "properties": {
    "lat": { "type": "number", "examples": [48.85] },
    "lon": { "type": "number", "examples": [2.35] }
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
      activity: 'Checking the weather',
      activityPast: 'Currently {current_weather.temperature}°C',
      request: 'check the weather',
      toolType: 'http',
      description: 'Fetch current weather and a 7-day forecast (highs, lows, chance of rain) for coordinates via Open-Meteo.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint:
        'https://api.open-meteo.com/v1/forecast?current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=auto',
      method: 'GET',
      queryParams: ['latitude', 'longitude'],
      inputJson: `{
  "type": "object",
  "properties": {
    "latitude": { "type": "number", "examples": [48.85] },
    "longitude": { "type": "number", "examples": [2.35] }
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
      activity: 'Checking sunrise and sunset',
      activityPast: 'Checked sunrise and sunset',
      request: 'check sunrise and sunset',
      toolType: 'http',
      description: 'Sunrise, sunset, and day length for coordinates (sunrise-sunset.org).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://api.sunrise-sunset.org/json',
      method: 'GET',
      queryParams: ['lat', 'lng'],
      inputJson: `{
  "type": "object",
  "properties": {
    "lat": { "type": "number", "examples": [48.85] },
    "lng": { "type": "number", "examples": [2.35] }
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
  {
    id: 'tool-convert-currency',
    data: {
      toolName: 'convert_currency',
      activity: 'Converting {amount} {from} to {to}',
      activityPast: 'Converted {amount} {from} to {to}',
      request: 'convert {amount} {from} to {to}',
      toolType: 'http',
      description: 'Convert an amount between ISO currencies using ECB reference rates.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://api.frankfurter.dev/v1/latest',
      method: 'GET',
      queryParams: ['from', 'to', 'amount'],
      inputJson: `{
  "type": "object",
  "properties": {
    "from": { "type": "string", "examples": ["USD"] },
    "to": { "type": "string", "examples": ["EUR"] },
    "amount": { "type": "number", "examples": [100] }
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
      activity: 'Converting {value} {from} to {to}',
      activityPast: '{value} {from} is {result} {to}',
      request: 'convert {value} {from} to {to}',
      toolType: 'function',
      description: 'Convert temperature (c/f/k) or distance (km/mi) locally — no network call.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "value": { "type": "number", "description": "Amount to convert", "examples": [20] },
    "from": { "type": "string", "enum": ["c", "f", "k", "km", "mi"], "description": "Unit to convert from" },
    "to": { "type": "string", "enum": ["c", "f", "k", "km", "mi"], "description": "Unit to convert to", "examples": ["f"] }
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
      activity: 'Measuring the distance',
      activityPast: '{km} km apart',
      request: 'measure the distance',
      toolType: 'function',
      description: 'Great-circle distance between two lat/lon pairs in km and miles.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "lat1": { "type": "number", "minimum": -90, "maximum": 90, "description": "Start latitude", "examples": [48.85] },
    "lon1": { "type": "number", "minimum": -180, "maximum": 180, "description": "Start longitude", "examples": [2.35] },
    "lat2": { "type": "number", "minimum": -90, "maximum": 90, "description": "End latitude", "examples": [51.51] },
    "lon2": { "type": "number", "minimum": -180, "maximum": 180, "description": "End longitude", "examples": [-0.13] }
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
  {
    id: 'tool-wikipedia',
    data: {
      toolName: 'wikipedia_summary',
      activity: 'Reading about {title}',
      activityPast: 'Read about {title}',
      request: 'read about {title}',
      toolType: 'http',
      description: 'Fetch the Wikipedia REST summary for a page title.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://en.wikipedia.org/api/rest_v1/page/summary/{title}',
      method: 'GET',
      headersJson: DEMO_CLIENT_HEADERS,
      pathParams: ['title'],
      inputJson: `{
  "type": "object",
  "properties": {
    "title": { "type": "string", "examples": ["Paris"], "description": "Wikipedia page title, e.g. Paris" }
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
      activity: 'Searching the archive',
      activityPast: 'Searched the archive',
      request: 'search the archive',
      toolType: 'http',
      description: 'Search Internet Archive texts (books) by title or keywords.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      // Archive.org advanced search — Open Library TLS is unreachable from many networks.
      endpoint:
        'https://archive.org/advancedsearch.php?output=json&fl[]=identifier&fl[]=title&fl[]=creator',
      method: 'GET',
      queryParams: ['q', 'rows'],
      inputJson: `{
  "type": "object",
  "properties": {
    "q": { "type": "string", "examples": ["mediatype:texts AND travel"] },
    "rows": { "type": "number", "examples": [1] }
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
      activity: 'Looking up {postal}',
      activityPast: 'Looked up {postal}',
      request: 'look up {postal}',
      toolType: 'http',
      description: 'Look up place names for a postal code via Zippopotam (no API key).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://api.zippopotam.us/{country}/{postal}',
      method: 'GET',
      pathParams: ['country', 'postal'],
      inputJson: `{
  "type": "object",
  "properties": {
    "country": { "type": "string", "examples": ["us"], "description": "ISO country code, e.g. us or fr" },
    "postal": { "type": "string", "examples": ["90210"] }
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
      activity: 'Checking the docs',
      activityPast: 'Checked the docs',
      request: 'check the docs',
      toolType: 'mcp',
      description: 'Ask questions about a public GitHub repo via DeepWiki MCP (Streamable HTTP).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://mcp.deepwiki.com/mcp',
      mcpToolName: 'ask_wiki_question',
      inputJson: `{
  "type": "object",
  "properties": {
    "repoName": { "type": "string", "description": "The GitHub repo, as owner/repo", "examples": ["sveltejs/kit"] },
    "question": { "type": "string", "description": "What to ask about the repo", "maxLength": 2000, "examples": ["How does routing work?"] }
  },
  "required": ["repoName", "question"]
}`,
      outputJson: `{
  "type": "object",
  "properties": { "result": { "type": "string", "description": "Answer text from DeepWiki" } },
  "required": ["result"]
}`,
    },
  },
  // --- MCP docs servers (Context7, Microsoft Learn, Cloudflare, AWS: public, keyless, read-only) ---
  {
    id: 'tool-context7-resolve',
    data: {
      toolName: 'find_library',
      activity: 'Finding {libraryName}',
      activityPast: 'Found {libraryName}',
      request: 'find {libraryName}',
      toolType: 'mcp',
      description:
        "Find a library's Context7 ID by name. Call before read_library_docs unless the user gave an ID like /vercel/next.js.",
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://mcp.context7.com/mcp',
      mcpToolName: 'resolve-library-id',
      inputJson: `{
  "type": "object",
  "properties": {
    "libraryName": { "type": "string", "description": "The library's official name", "maxLength": 100, "examples": ["Next.js"] },
    "query": { "type": "string", "description": "What the user wants to do with it", "maxLength": 500, "examples": ["Set up middleware"] }
  },
  "required": ["libraryName", "query"]
}`,
      outputJson: `{ "type": "string", "description": "Matching libraries and their Context7 IDs" }`,
    },
  },
  {
    id: 'tool-context7-docs',
    data: {
      toolName: 'read_library_docs',
      activity: 'Reading the {libraryId} docs',
      activityPast: 'Read the {libraryId} docs',
      request: 'read the {libraryId} docs',
      toolType: 'mcp',
      description:
        'Up-to-date docs and code examples for one library from Context7, for one topic per call.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://mcp.context7.com/mcp',
      mcpToolName: 'query-docs',
      inputJson: `{
  "type": "object",
  "properties": {
    "libraryId": { "type": "string", "description": "A Context7 ID from find_library, like /vercel/next.js", "maxLength": 200, "examples": ["/reactjs/react.dev"] },
    "query": { "type": "string", "description": "One topic to look up", "maxLength": 500, "examples": ["useEffect cleanup"] }
  },
  "required": ["libraryId", "query"]
}`,
      outputJson: `{ "type": "string", "description": "Documentation excerpts and code examples" }`,
    },
  },
  {
    id: 'tool-microsoft-learn',
    data: {
      toolName: 'search_microsoft_docs',
      activity: 'Searching Microsoft Learn for {query}',
      activityPast: 'Found {results.0.title|nothing on Microsoft Learn}',
      request: 'search Microsoft Learn for {query}',
      toolType: 'mcp',
      description:
        'Search official Microsoft and Azure documentation on Microsoft Learn.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://learn.microsoft.com/api/mcp',
      mcpToolName: 'microsoft_docs_search',
      inputJson: `{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "A topic about a Microsoft or Azure product, service or API", "maxLength": 500, "examples": ["Azure Functions timeout"] }
  },
  "required": ["query"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "content": { "type": ["string", "null"] },
          "contentUrl": { "type": "string" }
        }
      }
    }
  }
}`,
    },
  },
  {
    id: 'tool-cloudflare-docs',
    data: {
      toolName: 'search_cloudflare_docs',
      activity: 'Searching Cloudflare docs for {query}',
      activityPast: 'Found {results.0.title|nothing in the Cloudflare docs}',
      request: 'search the Cloudflare docs for {query}',
      toolType: 'mcp',
      description:
        'Search the Cloudflare developer documentation: Workers, R2, D1, Durable Objects, Zero Trust and more.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://docs.mcp.cloudflare.com/mcp',
      mcpToolName: 'search_cloudflare_documentation',
      inputJson: `{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "What to look up in the Cloudflare docs", "maxLength": 500, "examples": ["Durable Objects alarms"] }
  },
  "required": ["query"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "url": { "type": "string" },
          "text": { "type": "string" }
        }
      }
    }
  },
  "required": ["results"]
}`,
    },
  },
  {
    id: 'tool-aws-regions',
    data: {
      toolName: 'list_aws_regions',
      activity: 'Listing AWS regions',
      activityPast: 'Listed {content.result.length} AWS regions',
      request: 'list AWS regions',
      toolType: 'mcp',
      description:
        'List every AWS region, with its code and name.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://knowledge-mcp.global.api.aws',
      mcpToolName: 'aws___list_regions',
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "content": {
      "type": "object",
      "properties": {
        "result": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "region_id": { "type": "string" },
              "region_long_name": { "type": "string" }
            }
          }
        }
      }
    }
  }
}`,
    },
  },
  {
    id: 'tool-aws-docs',
    data: {
      toolName: 'search_aws_docs',
      activity: 'Searching AWS docs for {search_phrase}',
      activityPast: 'Found {content.result.0.title|nothing in the AWS docs}',
      request: 'search the AWS docs for {search_phrase}',
      toolType: 'mcp',
      description:
        'Search AWS documentation, blogs and guides. Each result carries the matching page text.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://knowledge-mcp.global.api.aws',
      mcpToolName: 'aws___search_documentation',
      inputJson: `{
  "type": "object",
  "properties": {
    "search_phrase": { "type": "string", "description": "Keywords, with any error text verbatim", "maxLength": 500, "examples": ["Lambda cold start"] },
    "limit": { "type": "integer", "description": "How many results", "minimum": 1, "maximum": 10 }
  },
  "required": ["search_phrase"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "content": {
      "type": "object",
      "properties": {
        "result": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": { "type": "string" },
              "url": { "type": "string" },
              "context": { "type": "string" }
            }
          }
        }
      }
    }
  }
}`,
    },
  },
  {
    id: 'tool-hugging-face',
    data: {
      toolName: 'search_hugging_face',
      activity: 'Searching Hugging Face for {query}',
      activityPast: 'Searched Hugging Face for {query}',
      request: 'search Hugging Face for {query}',
      toolType: 'mcp',
      description:
        'Search Hugging Face for models and datasets, with downloads, likes, task and a link for each.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://huggingface.co/mcp',
      mcpToolName: 'hub_repo_search',
      inputJson: `{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "A model, dataset or task to look for", "maxLength": 200, "examples": ["speech recognition"] },
    "limit": { "type": "integer", "description": "How many results", "minimum": 1, "maximum": 10 }
  },
  "required": ["query"]
}`,
      outputJson: `{ "type": "string", "description": "Matching repositories, with their stats and links" }`,
    },
  },
  {
    id: 'tool-astro-docs',
    data: {
      toolName: 'search_astro_docs',
      activity: 'Searching the Astro docs for {query}',
      activityPast: 'Searched the Astro docs for {query}',
      request: 'search the Astro docs for {query}',
      toolType: 'mcp',
      description: 'Search the official Astro web framework documentation.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://mcp.docs.astro.build/mcp',
      mcpToolName: 'search_astro_docs',
      inputJson: `{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "What to look up in the Astro docs", "maxLength": 500, "examples": ["content collections"] }
  },
  "required": ["query"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "search_results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "source_url": { "type": "string" },
          "content": { "type": "string" }
        }
      }
    }
  },
  "required": ["search_results"]
}`,
    },
  },
  {
    id: 'tool-exa-search',
    data: {
      toolName: 'search_web',
      activity: 'Searching the web for {query}',
      activityPast: 'Searched the web for {query}',
      request: 'search the web for {query}',
      toolType: 'mcp',
      description:
        'Search the web with Exa for current information, news, people or companies. Describe the page you want, not just keywords.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://mcp.exa.ai/mcp',
      mcpToolName: 'web_search_exa',
      inputJson: `{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "A description of the ideal page", "minLength": 1, "maxLength": 500, "examples": ["blog post comparing Cloudflare Workers and AWS Lambda cold starts"] },
    "numResults": { "type": "integer", "description": "How many results", "minimum": 1, "maximum": 10 }
  },
  "required": ["query"]
}`,
      outputJson: `{ "type": "string", "description": "Titles, links and highlights from the top results" }`,
    },
  },
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
      paths: ['*'],
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
  {
    id: 'tool-weather-label',
    data: {
      toolName: 'weather_code_label',
      activity: 'Reading the forecast',
      activityPast: 'Forecast: {label}',
      request: 'read the forecast',
      toolType: 'function',
      description: 'Translate an Open-Meteo WMO weathercode into a short label.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "weathercode": { "type": "integer", "description": "Open-Meteo WMO weather code", "examples": [2] }
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
      activity: 'Planning a {focus} day in {destination}',
      activityPast: 'Planned your day in {destination}',
      request: 'plan a {focus} day in {destination}',
      toolType: 'function',
      description: 'Draft a simple day plan from destination context (playground stub).',
      category: 'demo',
      access: 'read-write',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "destination": { "type": "string", "description": "City or region", "examples": ["Paris"] },
    "focus": { "type": "string", "description": "What the day centres on, e.g. food or museums", "examples": ["museums"] }
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
      activity: 'Estimating a {days}-day budget',
      activityPast: 'About {total} {currency} for {days} days',
      request: 'estimate a {days}-day budget',
      toolType: 'function',
      description: 'Estimate trip cost from days × per-diem (local math, no FX).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "days": { "type": "integer", "minimum": 1, "maximum": 30, "description": "Trip length in days", "examples": [5] },
    "perDiem": { "type": "number", "minimum": 0, "description": "Daily budget", "examples": [150] },
    "currency": { "type": "string", "description": "ISO currency code", "examples": ["EUR"] }
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
      activity: 'Packing for {activity}',
      activityPast: 'Packed for {activity}',
      request: 'pack for {activity}',
      toolType: 'function',
      description: 'Suggest a packing list from temperature and activity type.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "tempC": { "type": "number", "description": "Expected temperature in °C", "examples": [18] },
    "activity": { "type": "string", "description": "What the trip is for, e.g. hiking or business", "examples": ["hiking"] }
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
      activity: 'Looking up {name}',
      activityPast: 'Found {name}',
      request: 'look up {name}',
      toolType: 'http',
      description: 'Look up a Pokémon by name from the public PokéAPI.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://pokeapi.co/api/v2/pokemon/{name}',
      method: 'GET',
      pathParams: ['name'],
      inputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string", "examples": ["pikachu"] }
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
      activity: 'Finding a cat fact',
      activityPast: 'Found a cat fact',
      request: 'find a cat fact',
      toolType: 'http',
      description: 'Return a random cat fact (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: ['*'],
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
      activity: 'Thinking of a joke',
      activityPast: 'Found a joke',
      request: 'think of a joke',
      toolType: 'http',
      description: 'Tell a random joke (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: ['*'],
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
      activity: 'Finding some advice',
      activityPast: 'Found some advice',
      request: 'find some advice',
      toolType: 'http',
      description: 'Random travel-style advice slip (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: ['*'],
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
      activity: 'Fetching a dog',
      activityPast: 'Fetched a dog',
      request: 'fetch a dog',
      toolType: 'http',
      description: 'Random dog photo URL from dog.ceo (T2 — call discover_tools first).',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T2',
      paths: ['*'],
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

export function demoToolSpecs(): PlaygroundToolSeed[] {
  return DEMO_TOOL_SPECS;
}
