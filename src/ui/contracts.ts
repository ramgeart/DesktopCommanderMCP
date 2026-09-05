/**
 * Central constants and shape contracts for UI resource identifiers. It gives one source of truth for URIs/tool metadata shared between server handlers and UI loaders.
 */
export const FILE_PREVIEW_RESOURCE_URI = 'ui://desktop-commander/file-preview';
export const CONFIG_EDITOR_RESOURCE_URI = 'ui://desktop-commander/config-editor';

/**
 * Widgets UI (MCP Apps) activados o no.
 *
 * Default OFF: con los widgets anunciados, el submission de plugins de OpenAI
 * exige por plantilla `_meta.ui.domain` (dominio único) y `_meta.ui.csp`, que
 * este fork no declara. Poner MCP_UI_RESOURCES=1 para volver a anunciarlos
 * (ver "Widgets UI" en HTTP_STREAMABLE.md antes de submitir).
 */
export function isUiEnabled(): boolean {
  return process.env.MCP_UI_RESOURCES === '1';
}

export interface UiToolMeta extends Record<string, unknown> {
  'ui/resourceUri': string;
  'openai/outputTemplate': string;
  ui: {
    resourceUri: string;
  };
  'openai/widgetAccessible'?: boolean;
}

export function buildUiToolMeta(resourceUri: string, widgetAccessible = false): UiToolMeta | undefined {
  // Sin widgets anunciados, OMITIR _meta por completo (ni siquiera {} vacío:
  // algunos importadores estrictos —ej: el de OpenAI— tratan el objeto vacío
  // como plantilla a medio declarar y fallan el scan).
  if (!isUiEnabled()) return undefined;
  const meta: UiToolMeta = {
    'ui/resourceUri': resourceUri,
    'openai/outputTemplate': resourceUri,
    ui: {
      resourceUri,
    },
  };

  if (widgetAccessible) {
    meta['openai/widgetAccessible'] = true;
  }

  return meta;
}
