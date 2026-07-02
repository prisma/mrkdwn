// Browser stand-in for `isomorphic-ws` (see automerge.plugin.ts): the sync
// adapter just needs the platform WebSocket.
export default globalThis.WebSocket;
