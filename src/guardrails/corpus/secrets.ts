/**
 * Synthetic secrets for adversarial corpus cases (not real credentials).
 *
 * @module
 */

/** lexicon-exempt-file: adversarial corpus fixture — not runtime user or model copy (P2) */
export const TEST_AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
export const TEST_GOOGLE_KEY = ['AIzaSy', 'A1234567890abcdefghijklmnopqrstuv'].join('');
export const TEST_OPENAI_KEY = ['sk-', '1234567890abcdefghijklmn'].join('');
export const TEST_ANTHROPIC_KEY = ['sk-ant-', '1234567890abcdefghijklmn'].join('');
export const TEST_OPENROUTER_KEY = ['sk-or-', '1234567890abcdefghijklmn'].join('');
export const TEST_GITHUB_PAT = ['github_pat_', '1234567890abcdefghijklmn'].join('');
export const TEST_BEARER = ['Bearer ', 'eyJhbGciOiJIUzI1NiJ9', '.dGVzdC5wYXlsb2Fk'].join('');
export const TEST_PEM = ['-----BEGIN PRIVATE KEY-----', 'MIIEvgIBADANBg', '-----END PRIVATE KEY-----'].join(
  '\n',
);
export const TEST_SSN = '123-45-6789';
export const TEST_VISA = '4111 1111 1111 1111';
export const TEST_SLACK = ['xoxb-', '1234567890-', 'abcdefghij'].join('');
