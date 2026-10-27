import type { FastifyPluginAsync } from 'fastify';
import type { Ctx } from '../app.js';
import { config } from '../config.js';
import { requester } from '../auth.js';
import { InsufficientCredits } from '../core/ledger.js';
import { JobError } from '../core/router.js';
import type { ChatMessage, JobInput } from '@nightshift/shared';

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export function inferenceRoutes(ctx: Ctx): FastifyPluginAsync {
  return async (app) => {
    const who = requester(ctx.ledger);

    const limited = {
      config: { rateLimit: { max: config.inferRpm, timeWindow: '1 minute' } },
    };

    // OpenAI-style. Point an existing client at /v1 and it works, minus streaming.
    app.post<{ Body: ChatBody }>('/chat/completions', limited, async (req, reply) => {
      const acct = who(req, reply);
      const b = req.body ?? {};
      if (b.stream) {
        reply.code(400);
        return { error: { message: 'streaming is not supported yet; omit stream', type: 'invalid_request' } };
      }
      const job = enqueueOr402(ctx, acct, {
        workload: 'llm',
        model: b.model,
        messages: b.messages,
        maxOutputTokens: b.max_tokens,
        temperature: b.temperature,
      });

      const done = await ctx.router.waitFor(job.id, 60_000);
      if (!done || done.status !== 'done') {
        reply.code(done?.status === 'failed' ? 502 : 504);
        return {
          error: {
            message: done?.error ?? 'no node picked the job up in time; it is still queued',
            type: 'routing_error',
            job_id: job.id,
          },
        };
      }
      const receipt = ctx.router.receipt(done.id);
      return {
        id: 'chatcmpl-' + done.id.slice(4),
        object: 'chat.completion',
        created: Math.floor(done.createdAt / 1000),
        model: done.input.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: done.output?.text ?? '' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(promptChars(done.input) / 4),
          completion_tokens: done.output?.outputTokens ?? 0,
          total_tokens: Math.ceil(promptChars(done.input) / 4) + (done.output?.outputTokens ?? 0),
        },
        nightshift: {
          job_id: done.id,
          node_id: done.nodeId,
          receipt_id: receipt?.id,
          cost_micro: done.costMicro,
          duration_ms: (done.finishedAt ?? 0) - (done.startedAt ?? done.createdAt),
        },
      };
    });

    // Generic, non-blocking. Returns the job immediately; poll /jobs/:id.
    app.post<{ Body: Partial<JobInput> }>('/jobs', limited, async (req, reply) => {
      const acct = who(req, reply);
      const job = enqueueOr402(ctx, acct, req.body ?? {});
      reply.code(202);
      return job;
    });

    // Batches: up to 1000 inputs in one call. Held for as one transaction.
    app.post<{ Body: { items?: Partial<JobInput>[]; label?: string } }>('/batches', limited, async (req, reply) => {
      const acct = who(req, reply);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0 || items.length > 1000) throw new JobError(400, 'items: 1 to 1000 job inputs');
      try {
        const b = ctx.router.enqueueBatch(acct, items, req.body?.label ? String(req.body.label).slice(0, 80) : undefined);
        reply.code(202);
        return { id: b.id, total: b.total, jobIds: b.jobs.map((j) => j.id) };
      } catch (err) {
        if (err instanceof InsufficientCredits) throw new JobError(402, `not enough credits for the whole batch: need ${err.needed} more, have ${err.have}`);
        throw err;
      }
    });

    app.get('/batches', async (req, reply) => {
      const acct = who(req, reply);
      return { batches: ctx.router.batchesFor(acct).map((b) => ({ ...b, ...ctx.router.batch(acct, b.id)! })) };
    });

    app.get<{ Params: { id: string } }>('/batches/:id', async (req, reply) => {
      const acct = who(req, reply);
      const b = ctx.router.batch(acct, req.params.id);
      if (!b) {
        reply.code(404);
        return { error: { message: 'batch not found' } };
      }
      return b;
    });

    /** Every item with its output. ?format=jsonl streams one object per line for tooling. */
    app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/batches/:id/results', async (req, reply) => {
      const acct = who(req, reply);
      const b = ctx.router.batch(acct, req.params.id);
      if (!b) {
        reply.code(404);
        return { error: { message: 'batch not found' } };
      }
      const items = ctx.router.batchJobs(acct, req.params.id).map((j, i) => ({
        index: i,
        jobId: j.id,
        status: j.status,
        prompt: j.input.messages?.[j.input.messages.length - 1]?.content,
        rounds: j.input.rounds,
        output: j.output?.text ?? j.output?.digest,
        units: j.output?.units,
        durationMs: j.output?.durationMs,
        costMicro: j.costMicro,
        receiptId: j.status === 'done' ? ctx.router.receipt(j.id)?.id : undefined,
        error: j.error,
      }));
      if (req.query.format === 'jsonl') {
        reply.header('content-type', 'application/x-ndjson');
        reply.header('content-disposition', `attachment; filename="${b.id}.jsonl"`);
        return items.map((x) => JSON.stringify(x)).join('\n') + '\n';
      }
      return { batch: b, items };
    });

    app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
      const acct = who(req, reply);
      const job = ctx.router.get(req.params.id);
      if (!job || job.requesterId !== acct) {
        reply.code(404);
        return { error: { message: 'job not found' } };
      }
      return { ...job, receipt: job.status === 'done' ? ctx.router.receipt(job.id) : undefined };
    });

    app.get('/jobs', async (req, reply) => {
      const acct = who(req, reply);
      return { jobs: ctx.router.recentForRequester(acct) };
    });
  };
}

function enqueueOr402(ctx: Ctx, acct: string, input: Partial<JobInput>) {
  try {
    return ctx.router.enqueue(acct, input);
  } catch (err) {
    if (err instanceof InsufficientCredits) throw new JobError(402, `not enough credits: need ${err.needed}, have ${err.have}`);
    throw err;
  }
}

function promptChars(input: JobInput): number {
  return (input.messages ?? []).reduce((n, m) => n + m.content.length, 0);
}
