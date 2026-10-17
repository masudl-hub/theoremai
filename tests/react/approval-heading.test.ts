import { assertEquals } from '@std/assert';
import { approvalHeading } from '../../react/src/ui/approval-heading.ts';
import { defaultLabels as t } from './default-labels.ts';

const gate = { kind: 'permission', tool: 'get_weather', permission: 'always_confirm' } as const;

Deno.test('the approval heading names the agent and what the call would do', () => {
  assertEquals(
    approvalHeading(
      t,
      { ...gate, request: 'check the weather in Oslo' },
      'get_weather',
      '@concierge',
    ),
    '@concierge wants to check the weather in Oslo',
  );
});

Deno.test('a tool with no request label is named in words', () => {
  assertEquals(
    approvalHeading(t, gate, 'get_weather', '@concierge'),
    '@concierge wants to use get weather',
  );
  assertEquals(
    approvalHeading(t, gate, 'sendSlackMessage'),
    'The agent wants to use send slack message',
  );
});
