// Transparent PNGs rasterized from the MIT @lobehub/icons brand sources.
import type { ChatState, Tool } from '@/lib/types';
export function ToolLogo({ tool, size = 18, state }: { tool: Tool; size?: number; state?: ChatState }) {
  const brand = tool === 'claude' ? 'claude' : 'openai';
  return <img className="tool-logo" src={`/icons/brands/${brand}-${state || 'plain'}.png`} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
