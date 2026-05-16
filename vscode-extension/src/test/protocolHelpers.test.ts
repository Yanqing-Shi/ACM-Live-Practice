import assert from "node:assert/strict";
import test from "node:test";
import { serverUrlToWebSocketUrl } from "../protocolHelpers";

test("converts HTTP server URLs to WebSocket URLs", () => {
  assert.equal(
    serverUrlToWebSocketUrl("http://localhost:3001"),
    "ws://localhost:3001/"
  );
  assert.equal(
    serverUrlToWebSocketUrl("https://icpc-live.example/rooms"),
    "wss://icpc-live.example/rooms"
  );
});

test("preserves already-WebSocket URLs", () => {
  assert.equal(
    serverUrlToWebSocketUrl("ws://localhost:3001/socket"),
    "ws://localhost:3001/socket"
  );
});

test("throws for invalid server URLs", () => {
  assert.throws(() => serverUrlToWebSocketUrl("not a url"), TypeError);
});
