import path from 'path';
import os from 'os';

export function getClawHome(): string {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}
