import { config } from '../config';
import { logger } from '../logging';

export interface ProxyConfig {
  host: string;
  port: number;
  auth?: { username: string; password: string };
  protocol?: string;
}

export class ProxyRotator {
  private proxies: ProxyConfig[];
  private currentIndex = 0;
  private failureCounts: Map<string, number> = new Map();
  private readonly maxFailures = 5;

  constructor(proxyStrings?: string[]) {
    this.proxies = (proxyStrings || config.proxyPool).map(p => this.parseProxyString(p)).filter(Boolean) as ProxyConfig[];
    if (this.proxies.length === 0) {
      logger.info('No proxies configured, using direct connection');
    }
  }

  getNextProxy(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    
    const healthyProxies = this.proxies.filter(p => (this.failureCounts.get(this.key(p)) || 0) < this.maxFailures);
    if (healthyProxies.length === 0) {
      logger.warn('All proxies marked unhealthy, resetting counters');
      this.failureCounts.clear();
      return this.proxies[this.currentIndex++ % this.proxies.length];
    }

    const proxy = healthyProxies[this.currentIndex++ % healthyProxies.length];
    return proxy;
  }

  reportFailure(proxy: ProxyConfig): void {
    const key = this.key(proxy);
    this.failureCounts.set(key, (this.failureCounts.get(key) || 0) + 1);
  }

  reportSuccess(proxy: ProxyConfig): void {
    const key = this.key(proxy);
    this.failureCounts.set(key, Math.max(0, (this.failureCounts.get(key) || 0) - 1));
  }

  private parseProxyString(str: string): ProxyConfig | undefined {
    try {
      const url = new URL(str);
      return {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port, 10) || (url.protocol === 'https:' ? 443 : 80),
        auth: url.username ? { username: url.username, password: url.password } : undefined,
      };
    } catch {
      logger.warn({ proxy: str }, 'Failed to parse proxy string');
      return undefined;
    }
  }

  private key(p: ProxyConfig): string {
    return `${p.protocol || 'http'}://${p.host}:${p.port}`;
  }
}
