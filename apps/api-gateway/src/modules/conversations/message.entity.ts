import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface CitationJson {
  documentId: string;
  documentName: string;
  page: number | null;
  text: string;
  score: number;
}

export interface WebSourceJson {
  title: string;
  url: string;
  content: string;
  provider: string;
  score: number;
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  conversationId: string;

  @Column()
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', nullable: true })
  citations: CitationJson[] | null;

  @Column({ type: 'jsonb', nullable: true })
  webSources: WebSourceJson[] | null;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
