import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null },
  appType: 'custom' });
try {
  const { main } = await server.ssrLoadModule('/src/cli/conquestBaseline.ts');
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error('Baseline завершён с ошибкой:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await server.close();
}
