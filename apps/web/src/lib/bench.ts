// Runs the registration benchmark in the browser. WebGPU when it's there,
// the CPU otherwise. Same kernel as the router's check (shared/bench.ts).

import { BENCH_K, BENCH_N, BENCH_TARGET_MS, BENCH_WGSL, benchElement, benchScore, sampleIndices, tierForScore, type BenchResult, type BenchTicket, type HardwareTier } from '@nightshift/shared';

export interface BenchOutcome {
  result: BenchResult;
  score: number;
  tier: HardwareTier;
  gpu?: string;
}

export type BenchProgress = (phase: 'adapter' | 'running' | 'reading' | 'cpu', fraction: number) => void;

export async function runBenchmark(ticket: BenchTicket, onProgress: BenchProgress = () => {}): Promise<BenchOutcome> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    try {
      return await runWebGpu(gpu, ticket, onProgress);
    } catch (e) {
      console.warn('WebGPU benchmark failed, falling back to CPU:', e);
    }
  }
  return runCpu(ticket, onProgress);
}

async function runWebGpu(gpu: GPU, ticket: BenchTicket, onProgress: BenchProgress): Promise<BenchOutcome> {
  onProgress('adapter', 0);
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no adapter');
  const info = (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string; description?: string; device?: string } }).info;
  const gpuName = [info?.description, info?.device, info?.architecture, info?.vendor].filter(Boolean)[0];
  const device = await adapter.requestDevice();
  const bytes = BENCH_N * 4;
  const out = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(params, 0, new Uint32Array([ticket.nonce >>> 0, BENCH_K, BENCH_N, 0]));
  const module = device.createShaderModule({ code: BENCH_WGSL });
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: out } }] });
  const groups = Math.ceil(BENCH_N / 256);

  const pass = () => {
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(pipeline);
    cp.setBindGroup(0, bind);
    cp.dispatchWorkgroups(groups);
    cp.end();
    device.queue.submit([enc.finish()]);
  };

  // warm up (compiles, first touch), not counted
  pass();
  await device.queue.onSubmittedWorkDone();

  onProgress('running', 0);
  const t0 = performance.now();
  let passes = 0;
  // submit in small bursts and wait for each so the measurement is of finished work
  while (performance.now() - t0 < BENCH_TARGET_MS) {
    for (let i = 0; i < 4; i++) pass();
    await device.queue.onSubmittedWorkDone();
    passes += 4;
    onProgress('running', Math.min(1, (performance.now() - t0) / BENCH_TARGET_MS));
  }
  const elapsedMs = performance.now() - t0;

  onProgress('reading', 0);
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(out, 0, staging, 0, bytes);
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const data = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  device.destroy();

  const idx = sampleIndices(ticket.nonce);
  const samples = idx.map((i) => data[i] >>> 0);
  // sanity: the shader must agree with the reference, else report as cpu-less failure
  if (samples[0] !== benchElement(ticket.nonce, idx[0])) throw new Error('shader output did not match the reference');
  const result: BenchResult = { ticketId: ticket.id, kind: 'webgpu', elapsedMs: Math.round(elapsedMs), passes, samples, gpu: gpuName };
  const score = benchScore(result);
  return { result, score, tier: tierForScore(score), gpu: gpuName };
}

async function runCpu(ticket: BenchTicket, onProgress: BenchProgress): Promise<BenchOutcome> {
  onProgress('cpu', 0);
  const t0 = performance.now();
  const data = new Uint32Array(BENCH_N);
  const chunk = 16384;
  for (let start = 0; start < BENCH_N; start += chunk) {
    const end = Math.min(BENCH_N, start + chunk);
    for (let i = start; i < end; i++) data[i] = benchElement(ticket.nonce, i);
    onProgress('cpu', end / BENCH_N);
    await new Promise((r) => setTimeout(r, 0)); // let the page breathe
  }
  const elapsedMs = performance.now() - t0;
  const samples = sampleIndices(ticket.nonce).map((i) => data[i] >>> 0);
  const result: BenchResult = { ticketId: ticket.id, kind: 'cpu', elapsedMs: Math.round(elapsedMs), passes: 1, samples };
  return { result, score: benchScore(result), tier: 'cpu' };
}

export function fmtScore(score: number): string {
  if (score >= 1e12) return `${(score / 1e12).toFixed(2)} T ops/s`;
  if (score >= 1e9) return `${(score / 1e9).toFixed(1)} G ops/s`;
  if (score >= 1e6) return `${(score / 1e6).toFixed(0)} M ops/s`;
  return `${Math.round(score)} ops/s`;
}
