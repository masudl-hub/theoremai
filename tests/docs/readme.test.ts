import { assertEquals } from '@std/assert';
import { HOST_GUARDRAIL_FIELDS } from '../../src/guardrails/types.ts';
import { createProviderRegistry, type RegisteredProvider } from '../../src/kernel/protocols/mod.ts';
import {
  EXTRA_FIELDS,
  PROFILE_FIELDS,
  PROFILE_TYPES,
  REQUEST_FIELDS,
} from '../../src/kernel/schema.ts';
import * as providers from '../../src/providers/mod.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const README = Deno.readTextFileSync(`${ROOT}README.md`);

function section(heading: string): string[] {
  const lines = README.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`README has no "## ${heading}"`);
  const end = lines.findIndex((line, at) => at > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

function table(lines: string[], first: string): Record<string, string>[] {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
  const at = lines.findIndex((line) => line.startsWith('|') && cells(line)[0] === first);
  if (at < 0) throw new Error(`no table headed "${first}"`);
  const head = cells(lines[at] as string);
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    const row = cells(line);
    rows.push(Object.fromEntries(head.map((name, index) => [name, row[index] ?? ''])));
  }
  return rows;
}

const ticked = (text: string) =>
  [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);

function firstParty(): RegisteredProvider[] {
  const registry = createProviderRegistry();
  registry.register(providers.geminiProvider);
  registry.register(providers.openRouterProvider);
  registry.register(providers.typesafeProvider);
  registry.register(providers.localProvider, {
    connection: { baseUrl: 'http://127.0.0.1:11434/v1' },
  });
  return registry.list();
}

Deno.test('the README lists every profile type with the first-party protocols that serve it', () => {
  const rows = table(section('Profile types'), 'Type');
  assertEquals(rows.map((row) => ticked(row.Type ?? '')[0]).sort(), [...PROFILE_TYPES].sort());
  const served = firstParty().flatMap((provider) => provider.serves.map((serve) => serve.protocol));
  for (const row of rows) {
    const type = ticked(row.Type ?? '')[0] as string;
    const expected = [
      ...new Set(served.filter((protocol) => type in protocol.endpoints).map((p) => p.id)),
    ].sort();
    assertEquals(ticked(row['First-party protocols'] ?? '').sort(), expected, type);
  }
});

Deno.test('the README lists each first-party provider with the protocols it serves and their types', () => {
  const rows = table(section('Providers'), 'Provider');
  const exportName = (provider: RegisteredProvider) =>
    Object.entries(providers).find(([, value]) => value === provider.definition)?.[0];
  assertEquals(
    rows.map((row) => `${ticked(row.Provider ?? '')[0]} ${ticked(row.ID ?? '')[0]}`).sort(),
    firstParty()
      .map((provider) => `${exportName(provider)} ${provider.id}`)
      .sort(),
  );
  for (const provider of firstParty()) {
    const row = rows.find((r) => ticked(r.ID ?? '')[0] === provider.id) ?? {};
    const tabled = [...(row.Protocols ?? '').matchAll(/`(\w+)` \(([^)]+)\)/g)]
      .map(([, id, types]) => `${id} (${(types as string).split(', ').sort().join(', ')})`)
      .sort();
    const actual = provider.serves
      .map(
        ({ protocol }) => `${protocol.id} (${Object.keys(protocol.endpoints).sort().join(', ')})`,
      )
      .sort();
    assertEquals(tabled, actual, provider.id);
  }
});

const PROFILE_ROOTS =
  /^(identity|inputs|outputs|tools|guardrails|models|observability|providerContinuation|turn)\./;

Deno.test('every profile field path the README names is in the field catalog', () => {
  const known = new Set([
    ...Object.keys(PROFILE_FIELDS),
    ...Object.keys(EXTRA_FIELDS),
    ...Object.keys(REQUEST_FIELDS),
  ]);
  const prose = README.replace(/```[\s\S]*?```/g, '').split('\n');
  const paths = prose.flatMap(ticked).map((name) => name.replace(/\(.*\)$/, ''));
  const unknown = paths.filter((name) => PROFILE_ROOTS.test(name) && !known.has(name));
  assertEquals([...new Set(unknown)], []);
  const partial = paths.filter(
    (name) =>
      name.includes('.') && !known.has(name) && [...known].some((key) => key.endsWith(`.${name}`)),
  );
  assertEquals([...new Set(partial)], [], 'name each profile field by its full path');
});

Deno.test('the README names exactly the guardrails a host profile may set', () => {
  const line = section('Profile types').find((l) => l.includes('A `host` profile sets only')) ?? '';
  assertEquals(
    ticked(line)
      .filter((name) => name.startsWith('guardrails.'))
      .map((name) => name.slice('guardrails.'.length))
      .sort(),
    [...HOST_GUARDRAIL_FIELDS].sort(),
  );
});

const FREE = `
declare const db: { tickets: { search(query: string): Promise<{ id: string; title: string }[]> } };
declare const apiKey: string;
declare function send(event: unknown): void;
declare const hostKeyVault: import("@theoremjs/agents").KeyVault;
`;

Deno.test('the README examples type-check as one program', async () => {
  const blocks = [...README.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] as string);
  const imports = new Map<string, Set<string>>();
  const bodies: string[] = [];
  for (const block of blocks) {
    const body = block.replace(
      /^import \{([^}]+)\} from "([^"]+)";\n/gm,
      (_all, names: string, from: string) => {
        const held = imports.get(from) ?? new Set<string>();
        for (const name of names.split(',')) if (name.trim()) held.add(name.trim());
        imports.set(from, held);
        return '';
      },
    );
    bodies.push(body);
  }
  const program = [
    ...[...imports].map(([from, names]) => `import { ${[...names].join(', ')} } from "${from}";`),
    FREE,
    ...bodies,
  ].join('\n');
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/readme-examples.ts`;
    await Deno.writeTextFile(file, program);
    const checked = await new Deno.Command(Deno.execPath(), {
      args: ['check', '--quiet', '--config', `${ROOT}deno.json`, file],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    assertEquals(new TextDecoder().decode(checked.stderr).replaceAll(dir, '<examples>'), '');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
