import { DataSource, EntitySchema, MixedList, DefaultNamingStrategy } from 'typeorm';
import { ConfigService } from '@nestjs/config';

/**
 * Column naming strategy that maps entity property names to snake_case
 * DB columns (e.g. `s3Key` -> `s3_key`) so the schema stays consistent
 * with the Python services that share the same tables.
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy {
  columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    const parts = [...embeddedPrefixes, customName ?? propertyName].filter(Boolean);
    return toSnakeCase(parts.join('_'));
  }
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export interface TypeOrmOptions {
  entities: MixedList<Function | string | EntitySchema>;
}

export function buildTypeOrmOptions(config: ConfigService, options: TypeOrmOptions) {
  return {
    type: 'postgres' as const,
    host: config.get('POSTGRES_HOST') || 'localhost',
    port: Number(config.get('POSTGRES_PORT') || 5432),
    username: config.get('POSTGRES_USER') || 'rag',
    password: config.get('POSTGRES_PASSWORD') || 'rag_secret',
    database: config.get('POSTGRES_DB') || 'ragdb',
    entities: options.entities,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true,
    logging: false,
  };
}

export function buildSeedDataSource(entities: MixedList<Function | string | EntitySchema>): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    username: process.env.POSTGRES_USER || 'rag',
    password: process.env.POSTGRES_PASSWORD || 'rag_secret',
    database: process.env.POSTGRES_DB || 'ragdb',
    entities,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true,
  });
}
