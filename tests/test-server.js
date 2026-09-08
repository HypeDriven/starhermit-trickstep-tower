import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
const dir = await mkdtemp(join(tmpdir(), 'trickstep-test-'));
process.env.TRICKSTEP_DATA_FILE = join(dir, 'data.json');
const { default: server } = await import('../server.js');
after(async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await new Promise(r => setTimeout(r, 300));
  await rm(dir, { recursive: true, force: true });
});
export default server;
