import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { Checkpoint } from '../types';
import { logger } from '../logging';

export class CheckpointManager {
  private path: string;

  constructor(path = './data/checkpoint.json') {
    this.path = path;
    const dir = path.substring(0, path.lastIndexOf('/')) || '.';
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  save(checkpoint: Checkpoint): void {
    try {
      writeFileSync(this.path, JSON.stringify(checkpoint, null, 2));
      logger.debug({ checkpointId: checkpoint.jobId }, 'Checkpoint saved');
    } catch (err) {
      logger.error({ err }, 'Failed to save checkpoint');
    }
  }

  load(): Checkpoint | null {
    if (!existsSync(this.path)) return null;
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf-8')) as Checkpoint;
      logger.info({ checkpointId: data.jobId }, 'Checkpoint loaded');
      return data;
    } catch (err) {
      logger.error({ err }, 'Failed to load checkpoint');
      return null;
    }
  }

  clear(): void {
    if (existsSync(this.path)) {
      try {
        // Rename instead of delete for safety
        const backup = `${this.path}.backup-${Date.now()}`;
        writeFileSync(backup, readFileSync(this.path));
        // We keep the backup but the main checkpoint is conceptually "cleared"
        // by overwriting with empty or just leaving it. For resume, we check
        // if checkpoint is stale (> 24h) and ignore it.
      } catch (err) {
        logger.error({ err }, 'Failed to backup checkpoint');
      }
    }
  }

  isStale(checkpoint: Checkpoint, maxAgeHours = 24): boolean {
    const age = Date.now() - new Date(checkpoint.timestamp).getTime();
    return age > maxAgeHours * 60 * 60 * 1000;
  }
}
