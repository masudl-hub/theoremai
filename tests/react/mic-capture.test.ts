import { assertEquals, assertInstanceOf } from '@std/assert';
import { MIC_CAPTURE_PROCESSOR, micCaptureWorkletUrl } from '../../react/src/client/mic-capture.ts';

/** The AudioWorkletGlobalScope's base class: the processor overrides `process`. */
class FakeProcessor {
  readonly sent: Float32Array[] = [];
  readonly port = {
    postMessage: (message: Float32Array): void => {
      this.sent.push(message);
    },
  };
  process(_inputs: Float32Array[][]): boolean {
    return false;
  }
}

Deno.test('the mic worklet registers the processor the live client asks for', async () => {
  const registered: { name: string; processor: new () => unknown }[] = [];
  Reflect.set(globalThis, 'AudioWorkletProcessor', FakeProcessor);
  Reflect.set(globalThis, 'registerProcessor', (name: string, processor: new () => unknown) => {
    registered.push({ name, processor });
  });
  try {
    await import(micCaptureWorkletUrl().href);
  } finally {
    Reflect.deleteProperty(globalThis, 'AudioWorkletProcessor');
    Reflect.deleteProperty(globalThis, 'registerProcessor');
  }

  assertEquals(
    registered.map((entry) => entry.name),
    [MIC_CAPTURE_PROCESSOR],
  );
  const processor = new registered[0].processor();
  assertInstanceOf(processor, FakeProcessor);
  const frame = new Float32Array([0.25, -0.5]);
  assertEquals(processor.process([[frame]]), true);
  assertEquals(processor.sent, [frame]);
});
