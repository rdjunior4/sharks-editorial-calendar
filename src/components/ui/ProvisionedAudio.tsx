import { useSignedUrl } from '@/lib/prospecting/media';

/**
 * Player de áudio/asset do bucket privado do agente (agent-voice).
 * Prefere metadata.audio_path (storage path permanente); aceita audio_url
 * legacy (URL pública — resolve extraindo o path e re-assinando).
 */
export default function ProvisionedAudio({ path, url, className }: { path?: string | null; url?: string | null; className?: string }) {
  const src = useSignedUrl(path ?? url, 'agent-voice');
  if (!src) return null;
  return <audio controls preload="none" src={src} className={className} />;
}
