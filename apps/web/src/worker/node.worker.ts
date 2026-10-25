// Runs inside a Web Worker so model loading and generation never block the
// page. Two workloads: a small instruct model through transformers.js, and
// the deterministic hash-chain compute task from the shared package.

import { computeTask, type ChatMessage } from '@nightshift/shared';

type In =
  | { type: 'load'; model: string }
  | { type: 'generate'; id: string; messages: ChatMessage[]; maxNewTokens: number; temperature: number }
  | { type: 'compute'; id: string; seed: number; rounds: number };

type Out =
  | { type: 'progress'; file: string; progress: number; loaded: number; total: number }
  | { type: 'loaded'; device: string }
  | { type: 'loadError'; message: string }
  | { type: 'token'; id: string; text: string }
  | { type: 'result'; id: string; text?: string; digest?: string; outputTokens: number; durationMs: number }
  | { type: 'error'; id: string; message: string };

const post = (m: Out) => (self as unknown as Worker).postMessage(m);

// Model ids as the network names them -> Hub repos that ship ONNX weights.
const MODELS: Record<string, string> = {
  'qwen2.5-0.5b-instruct': 'onnx-community/Qwen2.5-0.5B-Instruct',
  'smollm2-360m-instruct': 'HuggingFaceTB/SmolLM2-360M-Instruct',
};

let tokenizer: any = null;
let model: any = null;
let tf: any = null;
let loading: Promise<void> | null = null;

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(modelId: string): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const repo = MODELS[modelId];
    if (!repo) throw new Error(`unknown model ${modelId}`);
    tf = await import('@huggingface/transformers');
    const webgpu = await hasWebGPU();
    const device = webgpu ? 'webgpu' : 'wasm';
    const dtype = webgpu ? 'q4f16' : 'q8';
    const progress_callback = (p: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file) post({ type: 'progress', file: p.file, progress: p.progress ?? 0, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    };
    tokenizer = await tf.AutoTokenizer.from_pretrained(repo, { progress_callback });
    model = await tf.AutoModelForCausalLM.from_pretrained(repo, { device, dtype, progress_callback });
    post({ type: 'loaded', device });
  })();
  try {
    await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

async function generate(id: string, messages: ChatMessage[], maxNewTokens: number, temperature: number): Promise<void> {
  if (!model || !tokenizer) throw new Error('model not loaded');
  const t0 = performance.now();
  const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
  let text = '';
  const streamer = new tf.TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk: string) => {
      text += chunk;
      post({ type: 'token', id, text: chunk });
    },
  });
  const out = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    do_sample: temperature > 0,
    temperature: Math.max(0.01, temperature),
    top_p: 0.9,
    streamer,
  });
  const promptLen = inputs.input_ids.dims[1] as number;
  const outputTokens = Math.max(0, (out.dims[1] as number) - promptLen);
  // Decode from the ids rather than trusting the streamed chunks, so text and count agree.
  const decoded: string = tokenizer.batch_decode(out.slice(null, [promptLen, null]), { skip_special_tokens: true })[0] ?? text;
  post({ type: 'result', id, text: decoded.trim(), outputTokens, durationMs: performance.now() - t0 });
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'load') await load(m.model);
    else if (m.type === 'generate') await generate(m.id, m.messages, m.maxNewTokens, m.temperature);
    else if (m.type === 'compute') {
      const t0 = performance.now();
      const digest = await computeTask(m.seed, m.rounds);
      post({ type: 'result', id: m.id, digest, outputTokens: 0, durationMs: performance.now() - t0 });
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (m.type === 'load') post({ type: 'loadError', message });
    else post({ type: 'error', id: m.id, message });
  }
};
