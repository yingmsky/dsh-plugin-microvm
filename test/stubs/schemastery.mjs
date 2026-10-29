// Chainable stand-in: records calls, validates nothing.
const node = () => new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : () => node()), apply: () => node() })
const Schema = new Proxy({}, { get: () => () => node() })
export default Schema
