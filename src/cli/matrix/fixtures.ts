/**
 * Built-in synthetic media fixtures for zero-dependency matrix testing.
 */

// 1x1 pixel PNG (base64)
export const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Minimal valid PDF-1.4 document (base64)
export const FIXTURE_PDF_BASE64 = btoa(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n188\n%%EOF\n',
);

// Minimal valid 16kHz 16-bit mono PCM/WAV (0.1s tone) (base64)
export function createSyntheticWavBase64(durationSec = 0.1, sampleRate = 16000): string {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF identifier
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, 36 + dataSize, true); // file size - 8
  view.setUint8(8, 0x57); // W
  view.setUint8(9, 0x41); // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E

  // fmt subchunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6d); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // ' '
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true); // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true); // BitsPerSample (16 bits)

  // data subchunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataSize, true);

  // Write a simple sine wave (440Hz)
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
