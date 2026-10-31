# A trained prune/<name> model as ONNX, in three builds: model.onnx (fp32), q_g_w8.onnx and q_g_w4.onnx (trim.py's int8 embedding table plus 8-bit or 4-bit
# MatMulNBits, block 32, symmetric). Checks each build against PyTorch on a few window lengths, since a traced model can bake in one length.
# Usage: onnxm.py <prune dir> <out dir>
import os, sys, shutil, torch, onnx, numpy as np, onnxruntime as ort
from transformers import AutoModelForSequenceClassification
from onnxruntime.quantization import quantize_dynamic, QuantType
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
d, out = sys.argv[1:3]; os.makedirs(out, exist_ok=True); shutil.copy(f'{d}/remap.json', f'{out}/remap.json')
m = AutoModelForSequenceClassification.from_pretrained(d).eval()
class W(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, input_ids, attention_mask): return s.m(input_ids=input_ids, attention_mask=attention_mask).logits
ids = torch.ones(1, 64, dtype=torch.long); am = torch.ones(1, 64, dtype=torch.long)
torch.onnx.export(W(m), (ids, am), f'{out}/model.onnx', input_names=['input_ids', 'attention_mask'], output_names=['logits'],
                  dynamic_axes={'input_ids': {0: 'b', 1: 't'}, 'attention_mask': {0: 'b', 1: 't'}, 'logits': {0: 'b'}}, opset_version=18, dynamo=False)
quantize_dynamic(f'{out}/model.onnx', f'{out}/q_gather.onnx', weight_type=QuantType.QInt8, op_types_to_quantize=['Gather'])
for bits in (8, 4):
    q = MatMulNBitsQuantizer(onnx.load(f'{out}/q_gather.onnx'), bits=bits, block_size=32, is_symmetric=True); q.process()
    q.model.save_model_to_file(f'{out}/q_g_w{bits}.onnx', use_external_data_format=False)
g = torch.Generator().manual_seed(0)
for f in ('model.onnx', 'q_g_w8.onnx', 'q_g_w4.onnx'):
    s = ort.InferenceSession(f'{out}/{f}', providers=['CPUExecutionProvider']); print(f, round(os.path.getsize(f'{out}/{f}') / 1e6, 1), 'MB')
    for L in (20, 128, 512):
        x = torch.randint(1000, 70000, (4, L), generator=g); a = torch.ones_like(x); a[1, L // 2:] = 0
        with torch.no_grad(): p = m(input_ids=x, attention_mask=a).logits.numpy()
        print(' ', L, 'worst logit gap', round(float(np.abs(s.run(None, {'input_ids': x.numpy(), 'attention_mask': a.numpy()})[0] - p).max()), 4))
