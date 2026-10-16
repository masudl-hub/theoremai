import { openRouterProvider, registerProvider } from '@theoremjs/agents';

const SITE = { siteName: 'Adversary' };
const SLOT = 'router_key';

export function registerRouter(): void {
  registerProvider(openRouterProvider, {
    id: 'router',
    connection: { ...SITE, siteUrl: 'https://adversary.example' },
    keySlot: SLOT,
  });
}
