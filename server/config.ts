import path from 'node:path';

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  isProd: boolean;
  port: number;
  dataDir: string;
  publicUrl: string;
  /** Synthetic demo instance: seed fixtures and show the labels. */
  demo: boolean;
  /** Pause per run stage for the demo adapter, in ms. */
  stageMs: number;
  allowDevOutbox: boolean;
  resendKey: string | null;
  mailFrom: string;
  anthropicKey: string | null;
  anthropicBaseUrl: string | null;
  github: OAuthCredentials | null;
  linkedin: OAuthCredentials | null;
  huggingface: OAuthCredentials | null;
  sessionDays: number;
  /** End-to-end suites sign in far more often than a person; never turn this off elsewhere. */
  rateLimits: boolean;
}

function credentials(env: NodeJS.ProcessEnv, prefix: string): OAuthCredentials | null {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const isProd = env.NODE_ENV === 'production';
  const port = Number(env.RIVET_PORT ?? 8787);
  return {
    isProd,
    port,
    dataDir: path.resolve(env.RIVET_DATA_DIR ?? 'data'),
    publicUrl: (env.RIVET_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    demo: env.RIVET_DEMO !== '0',
    stageMs: Number(env.RIVET_STAGE_MS ?? 2500),
    allowDevOutbox: !isProd || env.RIVET_ALLOW_DEV_OUTBOX === '1',
    resendKey: env.RESEND_API_KEY || null,
    mailFrom: env.RIVET_MAIL_FROM ?? 'Rivet <no-reply@rivet.example>',
    anthropicKey: env.ANTHROPIC_API_KEY || null,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || null,
    github: credentials(env, 'GITHUB'),
    linkedin: credentials(env, 'LINKEDIN'),
    huggingface: credentials(env, 'HUGGINGFACE'),
    sessionDays: 30,
    rateLimits: env.RIVET_DISABLE_RATE_LIMITS !== '1',
    ...overrides,
  };
}
