/**
 * Protocol contract tests: canonical digests, schema validation, and bounds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  canonicalize,
  digestOf,
  parseRequest,
} from "../src/protocol.ts";

test("canonicalize is key-order independent and digestOf is stable", () => {
  const a = { b: 1, a: [1, { z: true, y: null }] };
  const b = { a: [1, { y: null, z: true }], b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(digestOf(a), digestOf(b));
  assert.match(digestOf(a), /^[0-9a-f]{64}$/);
});

test("canonicalize distinguishes different values", () => {
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: "1" }));
});

test("message size bound is finite and positive", () => {
  assert.ok(Number.isInteger(DEFAULT_MAX_MESSAGE_BYTES) && DEFAULT_MAX_MESSAGE_BYTES > 0);
});

test("parseRequest accepts a well-formed health request", () => {
  const parsed = parseRequest({ protocolVersion: PROTOCOL_VERSION, homeId: "/tmp/home", op: "health" });
  assert.equal(parsed.op, "health");
  assert.equal(parsed.homeId, "/tmp/home");
});

test("parseRequest refuses unknown operations", () => {
  assert.throws(
    () => parseRequest({ protocolVersion: PROTOCOL_VERSION, homeId: "/h", op: "teleport" }),
    (error: unknown) => error instanceof ProtocolError && error.code === "UNSUPPORTED_OPERATION",
  );
});

test("parseRequest refuses malformed frames", () => {
  assert.throws(
    () => parseRequest({ protocolVersion: PROTOCOL_VERSION, homeId: "/h", op: "submit", operationId: "x" }),
    (error: unknown) => error instanceof ProtocolError && error.code === "BAD_REQUEST",
  );
  assert.throws(
    () => parseRequest({ protocolVersion: PROTOCOL_VERSION, homeId: "", op: "health" }),
    (error: unknown) => error instanceof ProtocolError && error.code === "BAD_REQUEST",
  );
  assert.throws(
    () => parseRequest({ protocolVersion: PROTOCOL_VERSION, homeId: "/h", op: "inspect", operationId: "x".repeat(500) }),
    (error: unknown) => error instanceof ProtocolError && error.code === "BAD_REQUEST",
  );
});

test("parseRequest refuses a malformed digest", () => {
  assert.throws(
    () =>
      parseRequest({
        protocolVersion: PROTOCOL_VERSION,
        homeId: "/h",
        op: "submit",
        operationId: "op-1",
        supervisorId: "sup",
        payload: {},
        payloadDigest: "not-a-digest",
      }),
    (error: unknown) => error instanceof ProtocolError && error.code === "BAD_REQUEST",
  );
});
