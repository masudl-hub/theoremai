import { assertEquals } from '../../../../src/kernel/engine/assert.ts';
import { openAiGatewayHeaders } from '../../../../src/providers/openrouter/openai/compat.ts';

Deno.test('openAiGatewayHeaders returns undefined when no site info', () => {
  assertEquals(openAiGatewayHeaders({}), undefined);
});

Deno.test('openAiGatewayHeaders sets HTTP-Referer for siteUrl', () => {
  const headers = openAiGatewayHeaders({ siteUrl: 'https://app.com' });
  assertEquals(headers?.['HTTP-Referer'], 'https://app.com');
  assertEquals(headers?.['X-Title'], undefined);
});

Deno.test('openAiGatewayHeaders sets X-Title for siteName', () => {
  const headers = openAiGatewayHeaders({ siteName: 'MyApp' });
  assertEquals(headers?.['X-Title'], 'MyApp');
  assertEquals(headers?.['HTTP-Referer'], undefined);
});

Deno.test('openAiGatewayHeaders sets both headers', () => {
  const headers = openAiGatewayHeaders({ siteUrl: 'https://a.com', siteName: 'A' });
  assertEquals(headers?.['HTTP-Referer'], 'https://a.com');
  assertEquals(headers?.['X-Title'], 'A');
});
