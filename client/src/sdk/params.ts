import type { ModelInput } from './CadViewer'

/** Reads the model to open from URL parameters: ?url=… | ?src=… | ?source=plm&id=PRT-1001 */
export function initialFromParams(p: URLSearchParams): ModelInput | { source: string; id: string } | null {
  const source = p.get('source')
  const id = p.get('id')
  if (source && id) return { source, id }
  const url = p.get('url') ?? p.get('src')
  if (url) return { url, name: p.get('name') ?? undefined }
  return null
}
