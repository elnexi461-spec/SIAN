import { ScraperServer } from './server';
import { logger } from '../logging';

const port = parseInt(process.env.API_PORT || '3000', 10);
const server = new ScraperServer(port);

server.start();

process.on('SIGINT', () => {
  logger.info('Shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down gracefully');
  process.exit(0);
});
