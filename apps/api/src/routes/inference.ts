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
