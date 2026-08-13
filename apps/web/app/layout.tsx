import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '../components/AuthProvider';
import { AppShell } from '../components/AppShell';

export const metadata: Metadata = {
  title: {
    default: 'Smoke Monkey',
    template: '%s · Smoke Monkey',
  },
  description:
    'Smoke Monkey — a chat LLM with super memory and dynamic visual widgets. Ask questions across your PDF documents with hybrid retrieval RAG.',
  keywords: [
    'LLM',
    'chat',
    'RAG',
    'retrieval augmented generation',
    'super memory',
    'dynamic visual',
    'pgvector',
    'hybrid retrieval',
    'PDF Q&A',
  ],
  openGraph: {
    title: 'Smoke Monkey',
    description:
      'A chat LLM with super memory and dynamic visual widgets. Hybrid retrieval RAG across your documents.',
    type: 'website',
    images: ['/logo.png'],
  },
  icons: {
    icon: '/logo.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
