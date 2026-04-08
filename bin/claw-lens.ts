#!/usr/bin/env node
import { startServer } from '../src/server/index';

const port = parseInt(process.env.PORT || '4242', 10);
const clawHome = process.env.OPENCLAW_HOME;

startServer({ port, clawHome, open: true }).catch((err: unknown) => {
  console.error('Failed to start claw-lens:', err);
  process.exit(1);
});
