import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type AgentBucket = 'agent-voice' | 'agent-assets';

/**
 * Resolve um valor de mídia para URL utilizável:
 * - path puro do storage (ex.: "sharks_company/lead/x.mp3") → signed URL de 1h
 * - URL pública/supabase antiga ("/object/public/agent-voice/...") → extrai path → signed URL
 * - URL externa (https sem /storage/v1/) → usa como está
 */
export async function resolveStorageUrl(value: string | null | undefined, bucket: AgentBucket): Promise<string | null> {
  const v = (value ?? '').trim();
  if (!v) return null;

  let path: string | null = null;
  if (/^https?:\/\//i.test(v)) {
    const m = v.match(/\/storage\/v1\/object\/(?:public|sign(?:ed)?)\/([^/]+)\/(.+?)(?:\?|$)/);
    if (m) {
      if (m[1] !== bucket) return v;
      path = decodeURIComponent(m[2]);
    } else {
      return v; // link externo
    }
  } else {
    path = v.replace(/^\//, '');
  }

  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      console.error('[media] signed url falhou:', error?.message);
      return null;
    }
    return data.signedUrl;
  } catch (e) {
    console.error('[media] signed url erro:', e);
    return null;
  }
}

/** Hook: resolve uma vez por valor (signed URLs duram 1h; remontagem re-assina). */
export function useSignedUrl(value: string | null | undefined, bucket: AgentBucket): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let ok = true;
    setUrl(null);
    resolveStorageUrl(value, bucket).then(r => { if (ok) setUrl(r); });
    return () => { ok = false; };
  }, [value, bucket]);
  return url;
}
