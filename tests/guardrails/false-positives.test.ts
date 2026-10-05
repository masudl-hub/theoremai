import '../fixtures/test-host.ts';
import { sanitizeText } from '../../src/guardrails/sanitize.ts';
import { assertEquals } from '../../src/kernel/engine/assert.ts';

function assertClean(_label: string, text: string): void {
  const out = sanitizeText(text);
  assertEquals(out, text);
}

Deno.test('benign pipe-separated code and data passes through', () => {
  assertClean('shell-pipe', 'cat logs.txt | grep error | sort -u');
  assertClean('config-pipe', 'system|override|config|path');
  assertClean('filter-pipe', 'filter|rules|validation|check');
  assertClean('sql-keywords', 'SELECT * FROM users WHERE status IN (ignore, bypass, override)');
  assertClean('status-pipe', 'status: active | role: admin | mode: developer');
  assertClean('git-pipe', 'git log --oneline | head -5');
  assertClean('csv-pipe', 'status|name|value\nactive|system_override|true');
});

Deno.test('benign backslash-escaped content passes through', () => {
  assertClean('win-path', 'path\\to\\system\\override\\config.json');
  assertClean('regex-literal', 'const regex = /ignore\\s+all/gi');
  assertClean('path-template', '\\system\\prompt\\template.txt');
  assertClean('code-regex', 'regex: /\\bsystem\\s+override\\b/gi');
  assertClean('win-path-2', 'C:\\Users\\admin\\system\\prompt.txt');
});

Deno.test('benign Cyrillic/Russian text passes through', () => {
  assertClean('ru-hello', 'Привет, как дела?');
  assertClean('ru-settings', 'Системные настройки обновлены');
  assertClean('ru-check', 'Проверьте систему на ошибки');
});

Deno.test('benign fullwidth and CJK text passes through', () => {
  assertClean('jp-company', 'ＡＢＣカンパニーの報告書');
  assertClean('jp-report', 'ＳＹＳＴＥＭレポート');
});

Deno.test('benign math and Greek symbols pass through', () => {
  assertClean('greek-vars', 'Let α = 0.01, ε = 1e-6 and compute ∇f(x)');
  assertClean('polynomial', 'The function f(x) = 3x² + 2x computes the output');
});

Deno.test('benign text with guardrail-adjacent words passes through', () => {
  assertClean('ignore-formatting', 'Please ignore the formatting in the last email');
  assertClean('previous-version', 'The previous version had different rules for spacing');
  assertClean('override-theme', 'Override the default theme color to blue');
  assertClean('show-progress', 'Show me your progress report for Q3');
  assertClean('bypass-cdn', 'We need to bypass the CDN cache for this deployment');
  assertClean('system-template', 'The system prompt template is in the config folder');
  assertClean('safety-config', 'The safety filter configuration needs updating');
  assertClean('disable-cache', 'Disable the content cache to see live changes');
  assertClean('remove-scaffolding', 'Remove the safety net scaffolding from the building');
});

Deno.test('enter/activate mode with location context passes through', () => {
  assertClean('dev-mode-ide', 'Enter developer mode in your IDE settings');
  assertClean('debug-mode-phone', 'Enter debug mode on your Android phone');
  assertClean('dev-mode-chrome', 'To enter developer mode in Chrome, open settings');
  assertClean('admin-mode-panel', 'Activate admin mode via the settings panel');
  assertClean('maint-mode-cli', 'Enter maintenance mode through the CLI');
  assertClean('dev-mode-device', 'Enter developer mode for this device using the hardware key');
});

Deno.test('benign number sequences are not misidentified as SSN', () => {
  assertClean('order-ref', 'Order #123 45 6789 is ready');
  assertClean('ref-number', 'Reference: 100 20 3000');
  assertClean('phone-like', 'Call 800 55 1234 for support');
  assertClean('scores', 'The score was 450 12 5000');
  assertClean('version', 'Version 3.14.159 released');
  assertClean('page-lines', 'Page 100, lines 20-30');
});

Deno.test('benign base64 that is not injection passes through', () => {
  assertClean('b64-hello', `Hash: ${btoa('hello world')}`);
  assertClean('b64-creds', `Payload: ${btoa('user:password')}`);
});

Deno.test('benign text with digits is not mistaken for leet speak', () => {
  assertClean('room-number', 'Room 4A, Floor 3, Building 7');
  assertClean('sports-score', 'The score was 4-0 in the 3rd quarter');
  assertClean('model-version', 'Model v3.0 with 4 layers');
  assertClean('error-code', 'Error code: E0137');
});

Deno.test('benign ROT13 of non-injection text passes through', () => {
  assertClean('rot13-hello', 'Uryyb jbeyq');
});

Deno.test('benign emoji usage passes through', () => {
  assertClean('emoji-praise', 'Great job 🔥 The system is running well 🚀');
  assertClean('emoji-check', 'Testing complete ✅');
});

Deno.test('benign multi-language text passes through', () => {
  assertClean('de-settings', 'Bitte überprüfen Sie die Einstellungen');
  assertClean('fr-params', 'Veuillez vérifier les paramètres');
  assertClean('es-config', 'Por favor revise la configuración');
});

Deno.test('benign technical docs with security terms pass through', () => {
  assertClean('jailbreak-module', 'The jailbreak detection module logs all attempts');
  assertClean('dan-protocol', 'DAN protocol version 3.2 is now supported');
  assertClean('unrestricted-tier', 'The unrestricted API tier allows 1000 requests');
});
