import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { logger } from '../logging';

export class SessionManager {
  private sessions: Map<string, AxiosInstance> = new Map();
  private rotationCounter = 0;
  private readonly sessionMaxAge: number;

  constructor() {
    this.sessionMaxAge = config.sessionRotation;
  }

  getSession(sessionId?: string): AxiosInstance {
    const id = sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    if (!this.sessions.has(id)) {
      this.sessions.set(id, this.createAxiosInstance(id));
    }

    this.rotationCounter++;
    if (this.rotationCounter >= this.sessionMaxAge) {
      this.rotationCounter = 0;
      return this.createAxiosInstance(`${id}-rotated-${Date.now()}`);
    }

    return this.sessions.get(id)!;
  }

  private createAxiosInstance(sessionId: string): AxiosInstance {
    const instance = axios.create({
      timeout: config.requestTimeout,
      headers: {
        'User-Agent': config.userAgent,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
    });

    instance.interceptors.request.use((req) => {
      logger.debug({ url: req.url, sessionId }, 'Outgoing request');
      return req;
    });

    instance.interceptors.response.use(
      (res) => res,
      (err) => {
        logger.warn({ url: err.config?.url, status: err.response?.status, sessionId }, 'Request failed');
        throw err;
      }
    );

    return instance;
  }

  clearSessions(): void {
    this.sessions.clear();
  }
}
