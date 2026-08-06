import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_ENV_VAR, resolveImagePath } from "./config.ts";

const HOST = "/home/u/proj";
const CONFIG_PATH = `${HOST}/.pi/gondolin.json`;

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

test("no env override, no config file -> undefined (gondolin's default image applies)", () => {
  const result = resolveImagePath(HOST, {
    env: {},
    readFile: () => {
      throw enoent();
    },
  });
  assert.equal(result, undefined);
});

test("env var override wins, without even reading the config file", () => {
  let readCalled = false;
  const result = resolveImagePath(HOST, {
    env: { [IMAGE_ENV_VAR]: "my-project-java:latest" },
    readFile: () => {
      readCalled = true;
      throw enoent();
    },
  });
  assert.equal(result, "my-project-java:latest");
  assert.equal(readCalled, false);
});

test("blank env var is ignored, falling through to the config file", () => {
  const result = resolveImagePath(HOST, {
    env: { [IMAGE_ENV_VAR]: "   " },
    readFile: (p) => {
      assert.equal(p, CONFIG_PATH);
      return JSON.stringify({ imagePath: "from-config:latest" });
    },
  });
  assert.equal(result, "from-config:latest");
});

test("reads a string imagePath from .pi/gondolin.json", () => {
  const result = resolveImagePath(HOST, {
    env: {},
    readFile: (p) => {
      assert.equal(p, CONFIG_PATH);
      return JSON.stringify({ imagePath: "my-project-java:latest" });
    },
  });
  assert.equal(result, "my-project-java:latest");
});

test("reads an explicit GuestAssets-shaped imagePath from .pi/gondolin.json", () => {
  const assets = { kernelPath: "/k", initrdPath: "/i", rootfsPath: "/r" };
  const result = resolveImagePath(HOST, {
    env: {},
    readFile: () => JSON.stringify({ imagePath: assets }),
  });
  assert.deepEqual(result, assets);
});

test("config file present but omits imagePath -> undefined", () => {
  const result = resolveImagePath(HOST, {
    env: {},
    readFile: () => JSON.stringify({ someOtherField: true }),
  });
  assert.equal(result, undefined);
});

test("throws on invalid JSON in the config file (fails loudly, not silently)", () => {
  assert.throws(
    () => resolveImagePath(HOST, { env: {}, readFile: () => "{ not json" }),
    /invalid JSON/,
  );
});

test("throws when the config file isn't a JSON object", () => {
  assert.throws(
    () => resolveImagePath(HOST, { env: {}, readFile: () => "[1, 2, 3]" }),
    /expected a JSON object/,
  );
});

test("throws when imagePath is the wrong shape", () => {
  assert.throws(
    () => resolveImagePath(HOST, { env: {}, readFile: () => JSON.stringify({ imagePath: 42 }) }),
    /"imagePath" must be/,
  );
});

test("a non-ENOENT read failure propagates as an error, not undefined", () => {
  assert.throws(
    () =>
      resolveImagePath(HOST, {
        env: {},
        readFile: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    /could not read/,
  );
});
