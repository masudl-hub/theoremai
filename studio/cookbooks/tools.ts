import { ATTACHMENT_ACCEPT_MIMES, VOICE_ACCEPT_MIMES } from '@theoremjs/agents/schema';
import type { StudioToolHandlers } from '../tools.ts';
import type { StudioInputsSpec, StudioToolSeed } from '../types.ts';

const DEMO_ATTACHMENT_ACCEPT = ATTACHMENT_ACCEPT_MIMES.filter(
  (mime) => mime === 'image/*' || mime === 'application/pdf' || mime.startsWith('text/'),
);
const DEMO_VOICE_ACCEPT = VOICE_ACCEPT_MIMES.filter((mime) => mime === 'audio/*');

// Nominatim and Wikipedia refuse requests that don't name their client.
const DEMO_CLIENT_HEADERS = `{
  "User-Agent": "TheoremStudio/1.0 (travel demo; +https://github.com/masudl-hub/theoremai)"
}`;

const GITHUB_RAW_HEADERS = `{
  "Accept": "application/vnd.github.raw",
  "User-Agent": "TheoremStudio/1.0 (research scout; +https://github.com/masudl-hub/theoremai)"
}`;

export const DISCOVER_LOADED = [
  'get_cat_fact',
  'tell_joke',
  'get_advice',
  'random_dog_image',
] as const;

/** Sample inputs for HTTP and MCP cookbook tools (connection tests and smoke scripts). */
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
  read_repo_file: { owner: 'denoland', repo: 'std', path: 'README.md' },
  lookup_package: { name: 'zod' },
  get_cat_fact: {},
  tell_joke: {},
  get_advice: {},
  random_dog_image: {},
  list_arxiv: { search_query: 'all:"episodic memory" AND all:"language model"' },
  search_models: { search: 'retrieval embedding' },
  search_datasets: { search: 'long context memory' },
  read_model_card: {
    owner: 'sentence-transformers',
    name: 'all-MiniLM-L6-v2',
    question: 'What is the embedding dimension?',
  },
  read_dataset_card: {
    owner: 'THUDM',
    name: 'LongBench',
    question: 'What context lengths are tested?',
  },
  search_github: { q: 'llm episodic memory' },
  read_readme: { owner: 'mem0ai', repo: 'mem0', question: 'How are memories stored?' },
};

export function demoHttpSampleInput(toolName: string): Record<string, unknown> | undefined {
  return DEMO_HTTP_SAMPLE_INPUT[toolName];
}

/** Comma-separated hosts for guardrails.network.allowedHosts across the cookbook graphs. */
export const DEMO_ALLOWED_HOSTS =
  'nominatim.openstreetmap.org, geocoding-api.open-meteo.com, api.open-meteo.com, api.frankfurter.dev, api.sunrise-sunset.org, api.zippopotam.us, en.wikipedia.org, archive.org, pokeapi.co, dog.ceo, api.adviceslip.com, catfact.ninja, official-joke-api.appspot.com, mcp.deepwiki.com, mcp.context7.com, learn.microsoft.com, docs.mcp.cloudflare.com, knowledge-mcp.global.api.aws, huggingface.co, mcp.docs.astro.build, mcp.exa.ai, raw.githubusercontent.com, registry.npmjs.org, export.arxiv.org, api.github.com';

export const RESEARCH_ALLOWED_HOSTS =
  'mcp.exa.ai, export.arxiv.org, huggingface.co, api.github.com, raw.githubusercontent.com, mcp.context7.com, mcp.deepwiki.com';

export function demoInputsSpec(): StudioInputsSpec {
  return {
    text: true,
    attachmentsAccept: DEMO_ATTACHMENT_ACCEPT,
    voiceAccept: DEMO_VOICE_ACCEPT,
    maxFiles: 5,
    maxBytes: 10_485_760,
    maxTurnBytes: 26_214_400,
  };
}

const QUESTION_PROPERTY = `"question": { "type": "string", "minLength": 1, "description": "What you need from this source, as one specific question.", "examples": ["What datasets are evaluated?"] }`;

const COOKBOOK_TOOL_SPECS: StudioToolSeed[] = [
  {
    id: 'tool-export-report',
    data: {
      toolName: 'export_report',
      activity: 'Exporting {title}',
      activityPast: 'Exported {title}',
      request: 'export a report called {title}',
      toolType: 'function',
      description: "Save a finished report to the reader's workspace (studio stub).",
      category: 'demo',
      access: 'read-write',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "The report's title", "examples": ["Episodic memory for agents"] },
    "body": { "type": "string", "description": "The report, in Markdown" }
  },
  "required": ["title", "body"]
}`,
      outputJson: `{
  "type": "object",
  "properties": { "saved": { "type": "boolean" } },
  "required": ["saved"]
}`,
      stubOutputJson: `{ "saved": true }`,
    },
  },
  {
    id: 'tool-check-device',
    data: {
      toolName: 'check_device',
      activity: 'Checking this device',
      activityPast: 'Checked this device',
      request: 'check what this device can run',
      toolType: 'function',
      answeredBy: 'page',
      description:
        'Report whether this device has WebGPU and how much memory it has, to judge which models it can run.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      inputJson: `{ "type": "object", "properties": {} }`,
      outputJson: `{
  "type": "object",
  "properties": {
    "webgpu": { "type": "boolean" },
    "memoryGb": { "type": "number" }
  },
  "required": ["webgpu", "memoryGb"]
}`,
      stubOutputJson: `{ "webgpu": true, "memoryGb": 16 }`,
    },
  },
  // --- Research Scout tools (Exa, arXiv, Hugging Face, GitHub, Context7, DeepWiki) ---
  {
    id: 'tool-read-pages',
    data: {
      toolName: 'read_pages',
      after: true,
      activity: 'Reading {urls.0}',
      activityPast: `when urls.length is 1: Read {urls.0}
Read {urls.length} pages
Read pages`,
      activityFailed: 'Could not read {urls.0|that page}',
      request: 'read {urls.0}',
      toolType: 'mcp',
      description:
        'Read up to three web pages by URL via Exa. Pass the specific question you are reading them for.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      serverUrl: 'https://mcp.exa.ai/mcp',
      mcpToolName: 'web_fetch_exa',
      inputJson: `{
  "type": "object",
  "properties": {
    "urls": { "type": "array", "items": { "type": "string", "format": "uri" }, "minItems": 1, "maxItems": 3, "description": "Web page URLs to read", "examples": [["https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2"]] },
    "maxCharacters": { "type": "integer", "maximum": 8000, "description": "Max characters per page", "examples": [8000] },
    ${QUESTION_PROPERTY}
  },
  "required": ["urls", "question"]
}`,
      outputJson: `{ "type": "string", "description": "Extracted passages from the requested pages" }`,
    },
  },
  {
    id: 'tool-list-arxiv',
    data: {
      toolName: 'list_arxiv',
      activity: 'Searching arXiv for {search_query}',
      activityPast: 'Searched arXiv for {search_query}',
      activityFailed: 'Could not search arXiv for {search_query|that query}',
      request: 'search arXiv for {search_query}',
      toolType: 'http',
      description:
        'Fetch the newest arXiv submissions matching an arXiv query (e.g. all:"episodic memory" AND all:"language model").',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint:
        'https://export.arxiv.org/api/query?sortBy=submittedDate&sortOrder=descending&max_results=10',
      method: 'GET',
      queryParams: ['search_query'],
      inputJson: `{
  "type": "object",
  "properties": {
    "search_query": { "type": "string", "minLength": 1, "description": "arXiv query expression", "examples": ["all:\\"episodic memory\\" AND all:\\"language model\\""] }
  },
  "required": ["search_query"]
}`,
      outputJson: `{ "type": "string", "description": "Atom XML feed of matching arXiv preprints" }`,
    },
  },
  {
    id: 'tool-search-models',
    data: {
      toolName: 'search_models',
      activity: 'Searching Hugging Face models for {search}',
      activityPast: `Found {length hit|hits} for {search}
Found hits for {search|that query}`,
      activityFailed: 'Could not search models for {search|that query}',
      request: 'search Hugging Face models for {search}',
      toolType: 'http',
      description: 'Search Hugging Face Hub models, most recently modified first.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://huggingface.co/api/models?sort=lastModified&direction=-1&limit=15',
      method: 'GET',
      queryParams: ['search'],
      inputJson: `{
  "type": "object",
  "properties": {
    "search": { "type": "string", "minLength": 1, "description": "Model search terms", "examples": ["retrieval embedding"] }
  },
  "required": ["search"]
}`,
      outputJson: `{ "type": "array", "items": { "type": "object" } }`,
    },
  },
  {
    id: 'tool-search-datasets',
    data: {
      toolName: 'search_datasets',
      activity: 'Searching Hugging Face datasets for {search}',
      activityPast: `Found {length hit|hits} for {search}
Found hits for {search|that query}`,
      activityFailed: 'Could not search datasets for {search|that query}',
      request: 'search Hugging Face datasets for {search}',
      toolType: 'http',
      description: 'Search Hugging Face Hub datasets, most recently modified first.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://huggingface.co/api/datasets?sort=lastModified&direction=-1&limit=15',
      method: 'GET',
      queryParams: ['search'],
      inputJson: `{
  "type": "object",
  "properties": {
    "search": { "type": "string", "minLength": 1, "description": "Dataset search terms", "examples": ["long context memory"] }
  },
  "required": ["search"]
}`,
      outputJson: `{ "type": "array", "items": { "type": "object" } }`,
    },
  },
  {
    id: 'tool-read-model-card',
    data: {
      toolName: 'read_model_card',
      after: true,
      activity: 'Reading model card {owner}/{name}',
      activityPast: 'Read model card {owner}/{name}',
      activityFailed: 'Could not read model card {owner}/{name}',
      request: 'read model card {owner}/{name}',
      toolType: 'http',
      description: 'Read a Hugging Face model card (README.md) by owner and model name.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://huggingface.co/{owner}/{name}/raw/main/README.md',
      method: 'GET',
      pathParams: ['owner', 'name'],
      inputJson: `{
  "type": "object",
  "properties": {
    "owner": { "type": "string", "description": "Hub organisation or user", "examples": ["sentence-transformers"] },
    "name": { "type": "string", "description": "Model repository name", "examples": ["all-MiniLM-L6-v2"] },
    ${QUESTION_PROPERTY}
  },
  "required": ["owner", "name", "question"]
}`,
      outputJson: `{ "type": "string", "description": "Model card Markdown" }`,
    },
  },
  {
    id: 'tool-read-dataset-card',
    data: {
      toolName: 'read_dataset_card',
      after: true,
      activity: 'Reading dataset card {owner}/{name}',
      activityPast: 'Read dataset card {owner}/{name}',
      activityFailed: 'Could not read dataset card {owner}/{name}',
      request: 'read dataset card {owner}/{name}',
      toolType: 'http',
      description: 'Read a Hugging Face dataset card (README.md) by owner and dataset name.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://huggingface.co/datasets/{owner}/{name}/raw/main/README.md',
      method: 'GET',
      pathParams: ['owner', 'name'],
      inputJson: `{
  "type": "object",
  "properties": {
    "owner": { "type": "string", "description": "Hub organisation or user", "examples": ["THUDM"] },
    "name": { "type": "string", "description": "Dataset repository name", "examples": ["LongBench"] },
    ${QUESTION_PROPERTY}
  },
  "required": ["owner", "name", "question"]
}`,
      outputJson: `{ "type": "string", "description": "Dataset card Markdown" }`,
    },
  },
  {
    id: 'tool-search-github',
    data: {
      toolName: 'search_github',
      activity: 'Searching GitHub for {q}',
      activityPast: `Found {total_count hit|hits} for {q}
Found hits for {q|that query}`,
      activityFailed: 'Could not search GitHub for {q|that query}',
      request: 'search GitHub for {q}',
      toolType: 'http',
      description: 'Search public GitHub repositories, most recently updated first.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://api.github.com/search/repositories?sort=updated&per_page=6',
      method: 'GET',
      headersJson: GITHUB_RAW_HEADERS,
      queryParams: ['q'],
      inputJson: `{
  "type": "object",
  "properties": {
    "q": { "type": "string", "minLength": 1, "description": "GitHub repository search query", "examples": ["llm episodic memory"] }
  },
  "required": ["q"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "total_count": { "type": "number" },
    "items": { "type": "array", "items": { "type": "object" } }
  }
}`,
    },
  },
  {
    id: 'tool-read-readme',
    data: {
      toolName: 'read_readme',
      after: true,
      activity: 'Reading README of {owner}/{repo}',
      activityPast: 'Read README of {owner}/{repo}',
      activityFailed: 'Could not read README of {owner}/{repo}',
      request: 'read README of {owner}/{repo}',
      toolType: 'http',
      description: 'Read a public GitHub repository README by owner and repository name.',
      category: 'research',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://api.github.com/repos/{owner}/{repo}/readme',
      method: 'GET',
      headersJson: GITHUB_RAW_HEADERS,
      pathParams: ['owner', 'repo'],
      inputJson: `{
  "type": "object",
  "properties": {
    "owner": { "type": "string", "description": "GitHub owner", "examples": ["mem0ai"] },
    "repo": { "type": "string", "description": "GitHub repository name", "examples": ["mem0"] },
    ${QUESTION_PROPERTY}
  },
  "required": ["owner", "repo", "question"]
}`,
      outputJson: `{ "type": "string", "description": "Repository README Markdown" }`,
    },
  },
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
      description:
        'Fetch current weather and a 7-day forecast (highs, lows, chance of rain) for coordinates via Open-Meteo.',
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
      activityFailed: 'Could not check the docs',
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
      activityFailed: 'Could not find {libraryName|that library}',
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
      after: true,
      activity: 'Reading the {libraryId} docs',
      activityPast: 'Read the {libraryId} docs',
      activityFailed: 'Could not read the {libraryId|library} docs',
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
      description: 'Search official Microsoft and Azure documentation on Microsoft Learn.',
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
    "query": { "type": "string", "description": "A topic about a Microsoft or Azure product, service, or API", "maxLength": 500, "examples": ["Azure Functions timeout"] }
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
        'Search the Cloudflare developer documentation: Workers, R2, D1, Durable Objects, Zero Trust, and more.',
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
      description: 'List every AWS region, with its code and name.',
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
        'Search AWS documentation, blogs, and guides. Each result carries the matching page text.',
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
    "query": { "type": "string", "description": "A model, dataset, or task to look for", "maxLength": 200, "examples": ["speech recognition"] },
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
      activityFailed: 'Could not search the web for {query|that query}',
      request: 'search the web for {query}',
      toolType: 'mcp',
      description:
        'Search the web with Exa for current information, news, people, or companies. Describe the page you want, not just keywords.',
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
      outputJson: `{ "type": "string", "description": "Titles, links, and highlights from the top results" }`,
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
      description: 'Draft a simple day plan from destination context (studio stub).',
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
  // --- Code (GitHub raw files and the npm registry; public, no key) ---
  {
    id: 'tool-read-repo-file',
    data: {
      toolName: 'read_repo_file',
      activity: 'Reading {path}',
      activityPast: 'Read {path}',
      request: 'read {path} in {owner}/{repo}',
      toolType: 'http',
      description:
        'Read one text file from the default branch of a public GitHub repository, e.g. package.json or README.md.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}',
      method: 'GET',
      pathParams: ['owner', 'repo', 'path'],
      inputJson: `{
  "type": "object",
  "properties": {
    "owner": { "type": "string", "examples": ["denoland"], "description": "The repository's owner" },
    "repo": { "type": "string", "examples": ["std"], "description": "The repository's name" },
    "path": { "type": "string", "examples": ["README.md"], "description": "The file's path from the repository root, e.g. src/index.ts" }
  },
  "required": ["owner", "repo", "path"]
}`,
      outputJson: `{ "type": "string" }`,
    },
  },
  {
    id: 'tool-lookup-package',
    data: {
      toolName: 'lookup_package',
      activity: 'Looking up {name}',
      activityPast: 'Looked up {name}',
      request: 'look up {name}',
      toolType: 'http',
      description:
        'Look up the latest published version of an npm package: its version, description, licence, and dependencies.',
      category: 'demo',
      access: 'read-only',
      permission: 'auto',
      loadTier: 'T0',
      paths: ['*'],
      endpoint: 'https://registry.npmjs.org/{name}/latest',
      method: 'GET',
      pathParams: ['name'],
      inputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string", "examples": ["zod"], "description": "The package name, e.g. zod or @scope/name" }
  },
  "required": ["name"]
}`,
      outputJson: `{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "version": { "type": "string" },
    "description": { "type": "string" },
    "license": { "type": "string" },
    "dependencies": { "type": "object" },
    "peerDependencies": { "type": "object" }
  },
  "required": ["name", "version"]
}`,
    },
  },
];

/** The tools the research scout allows: web, papers, models, datasets, repos, and library docs. */
export const DEMO_RESEARCH_TOOLS: readonly string[] = [
  'search_web',
  'read_pages',
  'list_arxiv',
  'search_models',
  'search_datasets',
  'read_model_card',
  'read_dataset_card',
  'search_github',
  'read_readme',
  'find_library',
  'read_library_docs',
  'ask_repo_docs',
  'export_report',
  'check_device',
];

/** The research tools whose output is a full page or card that `research.pagereader` filters at `post_tool`. */
export const DEMO_RESEARCH_STAGE_READ_TOOLS: readonly string[] = [
  'read_pages',
  'read_model_card',
  'read_dataset_card',
  'read_readme',
  'read_library_docs',
];

/** The tools the travel concierge allows: places, weather, money, trip helpers, and research. */
export const DEMO_CONCIERGE_TOOLS: readonly string[] = [
  'geocode_city',
  'search_places',
  'reverse_geocode',
  'lookup_postal_code',
  'haversine_distance',
  'get_weather',
  'weather_code_label',
  'get_sun_times',
  'convert_currency',
  'convert_units',
  'plan_day',
  'trip_budget_estimate',
  'packing_suggestions',
  'search_web',
  'wikipedia_summary',
  'discover_tools',
  ...DISCOVER_LOADED,
];

/** The tools the code architect allows: docs, repositories, packages, and research. */
export const DEMO_ARCHITECT_TOOLS: readonly string[] = [
  'ask_repo_docs',
  'read_repo_file',
  'lookup_package',
  'find_library',
  'read_library_docs',
  'search_microsoft_docs',
  'search_cloudflare_docs',
  'list_aws_regions',
  'search_aws_docs',
  'search_hugging_face',
  'search_astro_docs',
  'search_web',
  'wikipedia_summary',
];

/** The tools the tool console serves: one of each kind of result, and the two no agent allows. */
export const DEMO_CONSOLE_TOOLS: readonly string[] = [
  'get_weather',
  'search_places',
  'convert_currency',
  'ask_repo_docs',
  'random_dog_image',
  'get_pokemon',
  'archive_text_search',
];

export function demoToolSpecs(): StudioToolSeed[] {
  return COOKBOOK_TOOL_SPECS;
}

const WMO_WEATHER_LABELS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
};

function num(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Missing or invalid number field: ${key}`);
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing or invalid string field: ${key}`);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Each unit `convert_units` knows, as `(value + offset) * scale` onto its family's base: °C or km. */
const UNITS: ReadonlyMap<
  string,
  { family: 'temperature' | 'distance'; offset: number; scale: number }
> = new Map([
  ['c', { family: 'temperature', offset: 0, scale: 1 }],
  ['f', { family: 'temperature', offset: -32, scale: 5 / 9 }],
  ['k', { family: 'temperature', offset: -273.15, scale: 1 }],
  ['km', { family: 'distance', offset: 0, scale: 1 }],
  ['mi', { family: 'distance', offset: 0, scale: 1 / 0.621371 }],
]);

/** Portable handlers for the cookbook function tools, shared by Studio and the website. */
export const COOKBOOK_TOOL_HANDLERS: StudioToolHandlers = {
  convert_units(input) {
    const value = num(input, 'value');
    const from = str(input, 'from').toLowerCase();
    const to = str(input, 'to').toLowerCase();
    if (from === to) {
      return { value, from, to, result: value };
    }
    const source = UNITS.get(from);
    const target = UNITS.get(to);
    if (!source || !target || source.family !== target.family) {
      throw new Error(`Unsupported conversion: ${from} → ${to}`);
    }
    const base = (value + source.offset) * source.scale;
    const result = base / target.scale - target.offset;
    return { value, from, to, result: Math.round(result * 1000) / 1000 };
  },

  weather_code_label(input) {
    const code = Math.trunc(num(input, 'weathercode'));
    const label = WMO_WEATHER_LABELS[code] ?? `WMO code ${String(code)}`;
    return { weathercode: code, label };
  },

  trip_budget_estimate(input) {
    const days = Math.max(1, Math.trunc(num(input, 'days')));
    const perDiem = num(input, 'perDiem');
    const currency =
      typeof input.currency === 'string' && input.currency.trim()
        ? input.currency.trim().toUpperCase()
        : 'USD';
    const total = Math.round(days * perDiem * 100) / 100;
    return {
      days,
      perDiem,
      currency,
      total,
      note: 'Studio estimate — call convert_currency for live FX if needed.',
    };
  },

  packing_suggestions(input) {
    const tempC = num(input, 'tempC');
    const activity =
      typeof input.activity === 'string' && input.activity.trim()
        ? input.activity.trim()
        : 'general sightseeing';
    const items: string[] = ['Comfortable walking shoes', 'Reusable water bottle'];
    if (tempC < 8) items.push('Warm layers', 'Gloves or scarf');
    else if (tempC < 18) items.push('Light jacket', 'Layerable top');
    else items.push('Sun hat', 'Breathable clothing');
    if (/hike|outdoor|trail/i.test(activity)) {
      items.push('Day pack', 'Rain shell');
    }
    if (/beach|swim/i.test(activity)) {
      items.push('Swimsuit', 'Sandals');
    }
    return { tempC, activity, items };
  },

  haversine_distance(input) {
    const lat1 = num(input, 'lat1');
    const lon1 = num(input, 'lon1');
    const lat2 = num(input, 'lat2');
    const lon2 = num(input, 'lon2');
    const earthKm = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    const km = earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return {
      km: Math.round(km * 10) / 10,
      mi: Math.round(km * 0.621371 * 10) / 10,
    };
  },
};
