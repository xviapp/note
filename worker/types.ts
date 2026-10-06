export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_SECRET: string;
  SETUP_TOKEN: string;
  APP_NAME?: string;
  // Test servers point this at a local stand-in; production leaves it unset.
  DEEPSEEK_BASE_URL?: string;
}
export interface Site {
  id: number;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number;
  auth_epoch: number;
  quota_bytes: number;
  allocated_bytes: number;
  initialized_at: number | null;
}
export interface Session {
  token_hash: string;
  epoch: number;
  expires_at: number;
}
export interface BlobRow {
  id: string;
  object_key: string;
  name: string;
  mime: string;
  size: number;
  state: 'pending' | 'ready' | 'deleting';
  draft_until: number | null;
  created_at: number;
}
export interface RequestContext {
  request: Request;
  env: Env;
  execution: ExecutionContext;
  session: Session;
}
