#!/usr/bin/env node
import { startServer } from '../src/server/index';

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getOption(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
}

const port = parseInt(getOption('port') || process.env.PORT || '4242', 10);
const clawHome = process.env.OPENCLAW_HOME;
const open = !getFlag('no-open');

startServer({ port, clawHome, open }).catch((err: unknown) => {
  console.error('Failed to start claw-lens:', err);
  process.exit(1);
});
