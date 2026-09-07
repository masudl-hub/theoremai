/** Playground demo function tools with real (local) logic — keyed by tool name. */
export type PlaygroundDemoHandler = (input: Record<string, unknown>) => Record<string, unknown>;

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

const DEMO_FUNCTION_HANDLERS: Record<string, PlaygroundDemoHandler> = {
  convert_units(input) {
    const value = num(input, 'value');
    const from = str(input, 'from').toLowerCase();
    const to = str(input, 'to').toLowerCase();
    if (from === to) {
      return { value, from, to, result: value };
    }

    let celsius = value;
    if (from === 'f') celsius = ((value - 32) * 5) / 9;
    else if (from === 'k') celsius = value - 273.15;
    else if (from === 'c') celsius = value;
    else if (from === 'km') {
      const km = value;
      const result = to === 'mi' ? km * 0.621371 : km;
      return { value, from, to, result: Math.round(result * 1000) / 1000 };
    } else if (from === 'mi' && to === 'km') {
      const result = value / 0.621371;
      return { value, from, to, result: Math.round(result * 1000) / 1000 };
    } else {
      throw new Error(`Unsupported conversion: ${from} → ${to}`);
    }

    let result = celsius;
    if (to === 'f') result = (celsius * 9) / 5 + 32;
    else if (to === 'k') result = celsius + 273.15;
    else if (to !== 'c') {
      throw new Error(`Unsupported conversion: ${from} → ${to}`);
    }

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
      note: 'Playground estimate — call convert_currency for live FX if needed.',
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

export function playgroundDemoHandler(name: string): PlaygroundDemoHandler | undefined {
  return DEMO_FUNCTION_HANDLERS[name];
}
