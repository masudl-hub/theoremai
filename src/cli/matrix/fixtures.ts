export const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const FIXTURE_PDF_BASE64 = btoa(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n188\n%%EOF\n',
);

export function createSyntheticWavBase64(durationSec = 0.1, sampleRate = 16000): string {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  view.setUint8(0, 0x52);
  view.setUint8(1, 0x49);
  view.setUint8(2, 0x46);
  view.setUint8(3, 0x46);
  view.setUint32(4, 36 + dataSize, true);
  view.setUint8(8, 0x57);
  view.setUint8(9, 0x41);
  view.setUint8(10, 0x56);
  view.setUint8(11, 0x45);

  view.setUint8(12, 0x66);
  view.setUint8(13, 0x6d);
  view.setUint8(14, 0x74);
  view.setUint8(15, 0x20);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  view.setUint8(36, 0x64);
  view.setUint8(37, 0x61);
  view.setUint8(38, 0x74);
  view.setUint8(39, 0x61);
  view.setUint32(40, dataSize, true);

  const freq = 440;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.2 * 32767;
    view.setInt16(44 + i * 2, sample, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const FIXTURE_WAV_BASE64 = createSyntheticWavBase64(0.1, 16000);

export const FIXTURE_CSV_BASE64 = btoa(
  'item_id,label,category,score\nitem_1,Alpha,test,0.95\nitem_2,Beta,test,0.88\n',
);

export const FIXTURE_TEXT_BASE64 = btoa(
  'This is a synthetic fixture text document for Theorem validation testing.\n',
);

export function getFixtureForMime(mime: string): { data: string; mimeType: string } | undefined {
  const m = mime.toLowerCase().trim();
  if (m.startsWith('image/')) {
    return { data: FIXTURE_PNG_BASE64, mimeType: 'image/png' };
  }
  if (m === 'application/pdf') {
    return { data: FIXTURE_PDF_BASE64, mimeType: 'application/pdf' };
  }
  if (m === 'audio/wav' || m === 'audio/x-wav' || m.startsWith('audio/')) {
    return { data: FIXTURE_WAV_BASE64, mimeType: 'audio/wav' };
  }
  if (m === 'text/csv') {
    return { data: FIXTURE_CSV_BASE64, mimeType: 'text/csv' };
  }
  if (m === 'text/plain') {
    return { data: FIXTURE_TEXT_BASE64, mimeType: 'text/plain' };
  }
  return undefined;
}
