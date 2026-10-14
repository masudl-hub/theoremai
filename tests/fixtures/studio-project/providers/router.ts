import { defineProvider, openRouterAdapter } from '@theoremjs/agents';

const SITE = { siteName: 'Adversary' };
const SLOT = 'router_key';

export const router = defineProvider({
  id: 'router',
  connection: { ...SITE, siteUrl: 'https://adversary.example' },
  keySlot: SLOT,
  adapter: openRouterAdapter(),
});
