import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export const PROVIDER_OPENROUTER = 'openrouter';
export const PROVIDER_NVIDIA = 'nvidia';
export const PROVIDER_OPENAI = 'openai';
export const PROVIDER_XAI = 'xai';
export const PROVIDER_GEMINI = 'gemini';
export const PROVIDER_TAVILY = 'tavily';
export const PROVIDER_GOOGLE = 'google';
export const PROVIDER_BRAVE = 'brave';
export const PROVIDER_BING = 'bing';

export enum ApiKeyProvider {
  OpenRouter = 'openrouter',
  Nvidia = 'nvidia',
  OpenAI = 'openai',
  XAI = 'xai',
  Gemini = 'gemini',
  Tavily = 'tavily',
  Google = 'google',
  Brave = 'brave',
  Bing = 'bing',
}

export const SUPPORTED_PROVIDERS = Object.values(ApiKeyProvider) as readonly string[];

/**
 * A user-supplied provider API key (e.g. OpenRouter). The key is never stored
 * in plaintext — it is encrypted with AES-256-GCM before persisting and cached
 * in Redis (plaintext) for fast per-request lookups.
 */
@Entity('user_api_keys')
@Index(['userId', 'provider'], { unique: true })
export class UserApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ length: 32 })
  provider: string;

  @Column({ type: 'text', select: false })
  encryptedKey: string;

  /** First few chars of the key for UI display, e.g. `sk-or-v1-…`. */
  @Column({ length: 16 })
  keyPrefix: string;

  @Column({ length: 4 })
  last4: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
