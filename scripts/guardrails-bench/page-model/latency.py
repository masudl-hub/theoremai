# Latency of one ONNX classifier on full 512-token windows (batch 1) and on a 128-token text, warm.
# EP=coreml runs it through Core ML (GPU and Neural Engine, MLCU picks the units); the default is the CPU.
# Usage: [EP=coreml] [MLCU=ALL|CPUAndGPU|CPUAndNeuralEngine] [MLFMT=MLProgram|NeuralNetwork] [STATIC=0|1] latency.py <model.onnx> <threads>
import sys, time, os, numpy as np, onnxruntime as ort
path, threads = sys.argv[1], int(sys.argv[2])
o = ort.SessionOptions(); o.intra_op_num_threads = threads; o.inter_op_num_threads = 1
t0 = time.time(); ep = os.environ.get('EP', 'cpu')
cml = ('CoreMLExecutionProvider', {'ModelFormat': os.environ.get('MLFMT', 'MLProgram'), 'MLComputeUnits': os.environ.get('MLCU', 'ALL'), 'RequireStaticInputShapes': os.environ.get('STATIC', '0')})
s = ort.InferenceSession(path, o, providers=[cml, 'CPUExecutionProvider'] if ep == 'coreml' else ['CPUExecutionProvider']); load = time.time() - t0
names = [i.name for i in s.get_inputs()]
def run(n):
    feed = {'input_ids': np.full((1, n), 1000, dtype=np.int64), 'attention_mask': np.ones((1, n), dtype=np.int64)}
    if 'token_type_ids' in names: feed['token_type_ids'] = np.zeros((1, n), dtype=np.int64)
    t = time.perf_counter(); s.run(None, feed); return 1000 * (time.perf_counter() - t)
out = {'ep': ep, 'mlcu': os.environ.get('MLCU', 'ALL') if ep == 'coreml' else None, 'mb': round(os.path.getsize(path) / 1e6, 1), 'load_s': round(load, 2), 'threads': threads}
for n in (128, 512):
    for _ in range(3): run(n)
    xs = sorted(run(n) for _ in range(30)); out[f'p50_{n}'] = round(xs[15], 1); out[f'p95_{n}'] = round(xs[28], 1)
print(out)
