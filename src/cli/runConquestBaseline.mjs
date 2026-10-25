import { createServer } from 'vite';

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, ws: false },
  appType: 'custom' });
try {
  const trace = process.argv[2] === '--trace-timeouts';
  const development = process.argv[2] === '--development';
  const { main } = await server.ssrLoadModule(development ? '/src/cli/conquestDevelopment.ts'
    : trace ? '/src/cli/conquestTimeouts.ts' : '/src/cli/conquestBaseline.ts');
  process.exitCode = await main(process.argv.slice(trace || development ? 3 : 2));
} catch (error) {
  console.error('Baseline завершён с ошибкой:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await server.close();
}
