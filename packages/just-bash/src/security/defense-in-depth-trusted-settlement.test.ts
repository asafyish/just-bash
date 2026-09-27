import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const tsxLoaderUrl = import.meta.resolve("tsx");
const defenseUrl = new URL("./defense-in-depth-box.ts", import.meta.url).href;
const bridgeUrl = new URL(
  "../commands/worker-bridge/bridge-handler.ts",
  import.meta.url,
).href;
const protocolUrl = new URL(
  "../commands/worker-bridge/protocol.ts",
  import.meta.url,
).href;
const filesystemUrl = new URL(
  "../fs/in-memory-fs/in-memory-fs.ts",
  import.meta.url,
).href;

function runSubprocess(body: string): string {
  return execFileSync(
    process.execPath,
    [
      "--import",
      tsxLoaderUrl,
      "--input-type=module",
      "--eval",
      `
      function deferred() {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      }
      ${body}
    `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
}

describe("trusted host settlement after defense deactivation", () => {
  it.each([
    "resolve",
    "reject",
  ])("observes a trusted callback that settles with %s after deactivation", (settlement) => {
    expect(
      runSubprocess(`
          import assert from "node:assert/strict";
          import { setImmediate } from "node:timers/promises";
          import { DefenseInDepthBox } from ${JSON.stringify(defenseUrl)};

          const pending = deferred();
          const reason = new Error("late host failure");
          const handle = DefenseInDepthBox.getInstance(true).activate();
          let task;
          await handle.run(async () => {
            task = DefenseInDepthBox.runTrustedAsync(() => pending.promise);
          });
          const observed = task.then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await setImmediate();
          handle.deactivate();
          pending.${settlement}(${settlement === "resolve" ? '"host result"' : "reason"});
          assert.deepEqual(await observed, ${settlement === "resolve" ? '{ value: "host result" }' : "{ error: reason }"});
          await setImmediate();
          console.log("settled");
        `),
    ).toBe("settled\n");
  });

  it.each([
    "resolve",
    "reject",
  ])("settles a stopped tool bridge when its host callback later %ss", (settlement) => {
    expect(
      runSubprocess(`
          import assert from "node:assert/strict";
          import { setImmediate } from "node:timers/promises";
          import { DefenseInDepthBox } from ${JSON.stringify(defenseUrl)};
          import { BridgeHandler } from ${JSON.stringify(bridgeUrl)};
          import { createSharedBuffer, ProtocolBuffer, OpCode, Status } from ${JSON.stringify(protocolUrl)};
          import { InMemoryFs } from ${JSON.stringify(filesystemUrl)};

          const pending = deferred();
          const started = deferred();
          const shared = createSharedBuffer();
          const protocol = new ProtocolBuffer(shared);
          const bridge = new BridgeHandler(
            shared, new InMemoryFs(), "/", "test", undefined, 0, undefined,
            () => { started.resolve(); return pending.promise; },
          );
          protocol.setOpCode(OpCode.INVOKE_TOOL);
          protocol.setPath("test.read");
          protocol.setDataFromString("{}");
          protocol.setStatus(Status.READY);
          const handle = DefenseInDepthBox.getInstance(true).activate();
          let running;
          await handle.run(async () => { running = bridge.run(60_000); });
          await started.promise;
          await setImmediate();
          bridge.stop();
          handle.deactivate();
          pending.${settlement}(${settlement === "resolve" ? '"host result"' : 'new Error("late host failure")'});
          assert.deepEqual(await running, { stdout: "", stderr: "", exitCode: 0 });
          assert.equal(protocol.getStatus(), Status.${settlement === "resolve" ? "SUCCESS" : "ERROR"});
          assert.equal(protocol.getResultAsString(), ${settlement === "resolve" ? '"host result"' : '"late host failure"'});
          await setImmediate();
          console.log("settled");
        `),
    ).toBe("settled\n");
  });
});
