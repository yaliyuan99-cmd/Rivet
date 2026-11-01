// Runs the API server and the Vite dev server together. Ctrl-C stops both.
import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit', env: { ...process.env, RIVET_PUBLIC_URL: process.env.RIVET_PUBLIC_URL ?? 'http://localhost:5173' } }),
  spawn('npm', ['run', 'dev:client'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) stop(); });
