import { buildApp, buildContext } from './app.js';
import { config } from './config.js';

const ctx = buildContext();
const app = await buildApp(ctx);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`router key ${ctx.routerKey.publicKey}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    ctx.db.close();
    process.exit(0);
  });
}
