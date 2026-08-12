import { env } from '../config/env';

export type DocumentKind = 'pdf' | 'docx' | 'text' | 'unsupported';

export type DocumentExtractResult = {
  text: string;
  kind: DocumentKind;
  pages?: number;
  error?: string;
};

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'json',
  'xml',
  'html',
  'htm',
  'ini',
  'cfg',
  'yml',
  'yaml',
]);

export function inferDocumentKind(mime?: string, filename?: string): DocumentKind {
  const m = (mime || '').toLowerCase();
  const ext = (filename || '').toLowerCase().split('.').pop() || '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.includes('wordprocessingml') || ext === 'docx') return 'docx';
  if (m.startsWith('text/') || TEXT_EXTS.has(ext)) return 'text';
  return 'unsupported';
}

/**
 * Ekstrak teks dari buffer dokumen (PDF / DOCX / file teks).
 * Hasil dipotong ke maxChars supaya konteks agent tidak meledak.
 */
export async function extractDocumentText(
  buffer: Buffer,
  opts: { mime?: string; filename?: string; maxChars?: number }
): Promise<DocumentExtractResult> {
  const maxChars = opts.maxChars ?? env.documentMaxChars;
  const kind = inferDocumentKind(opts.mime, opts.filename);
  const filename = opts.filename || 'dokumen';

  try {
    if (kind === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer as any });
      const res: any = await parser.getText();
      const raw = String(res?.text || '');
      // Buang footer halaman ala pdf-parse ("-- 1 of 1 --")
      const text = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(l))
        .join('\n')
        .trim();
      return {
        text: truncate(text, maxChars),
        kind,
        pages: Number(res?.total) || undefined,
      };
    }

    if (kind === 'docx') {
      const mammoth: any = await import('mammoth');
      const res = await mammoth.extractRawText({ buffer });
      const text = String(res?.value || '');
      return { text: truncate(text, maxChars), kind };
    }

    if (kind === 'text') {
      const text = buffer.toString('utf-8');
      return { text: truncate(text, maxChars), kind };
    }

    return { text: '', kind, error: `Format dokumen tidak didukung (${filename})` };
  } catch (error: any) {
    return { text: '', kind, error: error?.message || String(error) };
  }
}

function truncate(text: string, max: number): string {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + `\n\n[...teks dipotong, total ${t.length} karakter...]`;
}
