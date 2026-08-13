import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client } from 'minio';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  client!: Client;
  readonly bucket = process.env.MINIO_BUCKET || 'documents';

  async onModuleInit() {
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: Number(process.env.MINIO_PORT || 9000),
      useSSL: process.env.MINIO_SECURE === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY || 'ragminio',
      secretKey: process.env.MINIO_SECRET_KEY || 'ragminio_secret',
    });
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`created bucket ${this.bucket}`);
    }
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
    });
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (err) {
      this.logger.warn(`failed to remove ${key}: ${err}`);
    }
  }
}
