# Horizon small with its vocabulary cut to tokens seen MINC+ times in training texts, as ONNX, in four builds:
#   model.onnx (fp32), model_int8.onnx (dynamic int8), q_gather.onnx (int8 embedding table only),
#   q_g_w8.onnx and q_g_w4.onnx (q_gather plus 8-bit or 4-bit weight-only MatMulNBits, block 32, symmetric).
# Usage: trim.py <vocab-counts.json> <minc> <out dir>
import os, sys, json, torch, onnx, importlib.util
from transformers import AutoModelForSequenceClassification, AutoTokenizer
from onnxruntime.quantization import quantize_dynamic, QuantType
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
spec = importlib.util.spec_from_file_location('score', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
d = S.MODELS['hz-small'][0]
counts, minc, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]; os.makedirs(out, exist_ok=True)
tok = AutoTokenizer.from_pretrained(d); m = AutoModelForSequenceClassification.from_pretrained(d).eval()
keep = sorted({int(t) for t, c in json.load(open(counts)).items() if c >= minc} | set(range(1000)) | set(tok.all_special_ids))
E = m.model.embeddings.tok_embeddings; new = torch.nn.Embedding(len(keep), E.weight.shape[1]); new.weight.data = E.weight.data[keep].clone()
m.model.embeddings.tok_embeddings = new; m.config.vocab_size = len(keep)
json.dump({'keep': keep, 'unk': keep.index(tok.unk_token_id)}, open(f'{out}/remap.json', 'w'))
ids = torch.ones(1, 64, dtype=torch.long); am = torch.ones(1, 64, dtype=torch.long)
class W(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, input_ids, attention_mask): return s.m(input_ids=input_ids, attention_mask=attention_mask).logits
torch.onnx.export(W(m), (ids, am), f'{out}/model.onnx', input_names=['input_ids', 'attention_mask'], output_names=['logits'],
                  dynamic_axes={'input_ids': {0: 'b', 1: 't'}, 'attention_mask': {0: 'b', 1: 't'}, 'logits': {0: 'b'}}, opset_version=18, dynamo=False)
quantize_dynamic(f'{out}/model.onnx', f'{out}/model_int8.onnx', weight_type=QuantType.QInt8)
quantize_dynamic(f'{out}/model.onnx', f'{out}/q_gather.onnx', weight_type=QuantType.QInt8, op_types_to_quantize=['Gather'])
for bits in (8, 4):
    q = MatMulNBitsQuantizer(onnx.load(f'{out}/q_gather.onnx'), bits=bits, block_size=32, is_symmetric=True); q.process()
    q.model.save_model_to_file(f'{out}/q_g_w{bits}.onnx', use_external_data_format=False)
for f in ('model.onnx', 'model_int8.onnx', 'q_gather.onnx', 'q_g_w8.onnx', 'q_g_w4.onnx'): print(f, round(os.path.getsize(f'{out}/{f}') / 1e6, 1), 'MB')
print('vocab', len(keep))
