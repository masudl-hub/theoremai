import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { createHostTransport, type HostTransport } from '../client/index.ts';
import { TheoremHost } from '../ui/index.ts';
import './studio.css';

/**
 * Theorem Studio, first slice: a project's own tools and profiles, read from the
 * local server the builder started in that project, and the host console to run
 * a tool.
 */

/** Where the studio's server is mounted, on the page's own origin. */
const SERVER = '/api/studio';

type StudioProfile = { id: string; type: string; handle?: string; tools: string[] };
type StudioTool = {
  name: string;
  description: string;
  kind: string;
  access: string;
  usedBy: string[];
};
type StudioDescription = { project: string; profiles: StudioProfile[]; tools: StudioTool[] };

type Loaded =
  | { state: 'loading' }
  | { state: 'unreachable' }
  | { state: 'ready'; studio: StudioDescription };

/** A tool that only reads carries no mark, as in the console. */
const ACCESS_COLOR = { 'read-write': 'orange', destructive: 'red' } as const;

function useStudio(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    const abort = new AbortController();
    fetch(SERVER, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setLoaded({ state: 'ready', studio: (await response.json()) as StudioDescription });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoaded({ state: 'unreachable' });
      });
    return () => {
      abort.abort();
    };
  }, []);
  return loaded;
}

/** The console for one tool: the server's host, showing only the tool picked in the tree. */
function useToolTransport(tool: string | null): HostTransport | null {
  return useMemo(() => {
    if (!tool) return null;
    const all = createHostTransport({ endpoint: `${SERVER}/host` });
    return {
      ...all,
      describe: async (signal) => {
        const host = await all.describe(signal);
        return { ...host, tools: host.tools.filter((entry) => entry.name === tool) };
      },
    };
  }, [tool]);
}

function matches(query: string, ...texts: (string | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || texts.some((text) => text?.toLowerCase().includes(needle));
}

function Tree(props: {
  studio: StudioDescription;
  profile: string | null;
  tool: string | null;
  onProfile: (id: string | null) => void;
  onTool: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const { studio } = props;
  const profiles = studio.profiles.filter((profile) =>
    matches(query, profile.id, profile.handle, profile.type),
  );
  const tools = studio.tools.filter(
    (tool) =>
      (props.profile === null || tool.usedBy.includes(props.profile)) &&
      matches(query, tool.name, tool.description),
  );
  return (
    <nav className="studio-tree" aria-label="Project">
      <Text type="label" weight="semibold">
        {studio.project}
      </Text>
      <TextInput
        label="Search profiles and tools"
        isLabelHidden
        placeholder="Search"
        startIcon={IconSearch}
        value={query}
        onChange={setQuery}
      />
      <List density="compact" header={`Profiles (${profiles.length} of ${studio.profiles.length})`}>
        {profiles.map((profile) => (
          <ListItem
            key={profile.id}
            label={profile.handle ?? profile.id}
            description={`${profile.type} · ${profile.tools.length} tools`}
            isSelected={props.profile === profile.id}
            onClick={() => props.onProfile(props.profile === profile.id ? null : profile.id)}
          />
        ))}
      </List>
      <List
        density="compact"
        header={
          props.profile === null
            ? `Tools (${tools.length} of ${studio.tools.length})`
            : `Tools of ${props.profile} (${tools.length})`
        }
      >
        {tools.map((tool) => (
          <ListItem
            key={tool.name}
            label={tool.name}
            description={tool.description}
            isSelected={props.tool === tool.name}
            onClick={() => props.onTool(tool.name)}
            endContent={
              tool.access in ACCESS_COLOR ? (
                <Token
                  label={tool.access}
                  color={ACCESS_COLOR[tool.access as keyof typeof ACCESS_COLOR]}
                />
              ) : undefined
            }
          />
        ))}
      </List>
    </nav>
  );
}

export default function Studio() {
  const loaded = useStudio();
  const [profile, setProfile] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const transport = useToolTransport(tool);

  if (loaded.state === 'loading') return null;
  if (loaded.state === 'unreachable') {
    return (
      <div className="studio-page">
        <Banner
          status="warning"
          title="The studio's server is not running"
          description="Start it in your project: deno run -A studio/serve.ts <setup-module>. Then reload this page."
        />
      </div>
    );
  }
  return (
    <div className="studio-page studio-columns">
      <Tree
        studio={loaded.studio}
        profile={profile}
        tool={tool}
        onProfile={setProfile}
        onTool={setTool}
      />
      <section className="studio-console" aria-label="Tool">
        {transport && tool ? (
          <TheoremHost key={tool} transport={transport} flush columns maxWidth="100%" />
        ) : (
          <EmptyState
            title="Pick a tool"
            description="Its form is made from the tool's input. Running it runs the real tool."
          />
        )}
      </section>
    </div>
  );
}
