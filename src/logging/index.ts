import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  redact: {
    paths: ['*.cookie', '*.token', '*.authorization', '*.x-api-eid-token', '*.h5st'],
    remove: true,
  },
});

export function createChildLogger(meta: Record<string, unknown>) {
  return logger.child(meta);
}
