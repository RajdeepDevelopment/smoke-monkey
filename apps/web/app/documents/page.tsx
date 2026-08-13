'use client';

import { useState } from 'react';
import { DocumentList } from '../../components/DocumentList';
import { DocumentUpload } from '../../components/DocumentUpload';
import { PageScroll } from '../../components/PageScroll';

export default function DocumentsPage() {
  const [version, setVersion] = useState(0);
  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Documents</h1>
          <p className="text-sm text-slate-500">PDFs you can ask questions about.</p>
        </div>
        <DocumentUpload onUploaded={() => setVersion((v) => v + 1)} />
        <DocumentList version={version} />
      </div>
    </PageScroll>
  );
}
