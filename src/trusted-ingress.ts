import { readFileSync } from 'node:fs';
import { TLSSocket } from 'node:tls';
import type { IncomingMessage } from 'node:http';
import type { ServerOptions } from 'node:https';
import * as z from 'zod/v4';

const fingerprint = z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase());
const ingressConfig = z.object({
  host: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  certFile: z.string().min(1), keyFile: z.string().min(1), caFile: z.string().min(1),
  personalFingerprint: fingerprint, soockerFingerprint: fingerprint,
}).strict().refine(value => value.personalFingerprint !== value.soockerFingerprint);

export interface TrustedIngress {
  host: string;
  port: number;
  tls: ServerOptions;
  identify(req: IncomingMessage): 'Personal' | 'SOOCKER' | null;
}

/** Operator-only config. Client certificates authenticate routes, never people.
 * No HTTP header, URL, IP or MCP argument is consulted for identity. */
export function loadTrustedIngress(file = process.env.CHATGPT_MCP_INGRESS_CONFIG): TrustedIngress | undefined {
  if (!file) return undefined;
  try {
    const config = ingressConfig.parse(JSON.parse(readFileSync(file, 'utf8')));
    return {
      host: config.host, port: config.port,
      tls: { cert: readFileSync(config.certFile), key: readFileSync(config.keyFile), ca: readFileSync(config.caFile),
        requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      identify(req) {
        if (!(req.socket instanceof TLSSocket) || !req.socket.authorized) return null;
        const pin = req.socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase();
        if (pin === config.personalFingerprint) return 'Personal';
        if (pin === config.soockerFingerprint) return 'SOOCKER';
        return null;
      },
    };
  } catch {
    // Do not print file contents, keys, or parser errors containing config values.
    throw new Error('Invalid trusted ingress configuration or unreadable TLS material.');
  }
}
