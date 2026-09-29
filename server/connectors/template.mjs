// Template for a custom connector (for systems a config-only REST mapping can't handle,
// e.g. multi-step logins, SOAP/SOA services, or "find the CAD dataset attached to this item" logic).
//
// sources.json:  { "id": "tc", "name": "Teamcenter", "type": "module", "module": "./connectors/my-teamcenter.mjs", ...your settings }
//
// Every method receives the incoming browser request as `req`, so you can forward the user's
// session (per-user permissions) instead of using a service account.
export default async function createConnector(config) {
  return {
    /** Search. Return [{ id, name (with extension), format, size, category, description, extra: {...} }] */
    async list({ q, req }) {
      return []
    },
    /** One item's metadata, or null. */
    async get(id, { req } = {}) {
      return null
    },
    /** The CAD file: { name, size?, stream } where stream is a Node Readable. Or null if not found. */
    async open(id, { req } = {}) {
      return null
    },
  }
}
