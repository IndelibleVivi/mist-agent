import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GroupChatCommand,
  type GroupChatHostDriver,
  groupChatSyntheticFixture,
} from "../../acceptance/group-chat-driver.ts";
import {
  type HostProvenanceFacts,
  judgeDirectWriteReadback,
  readProcessInfo,
} from "../../acceptance/group-chat-run.ts";
import { createGroupChatHostDriver } from "../../src/group-chat-acceptance-driver.ts";
import { RoomEventStore } from "../../src/group-chat/room-event-store.ts";

describe("group-chat acceptance host process", () => {
  let driver: ReturnType<typeof createGroupChatHostDriver> | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    if (driver !== undefined) await driver.stopHost();
    if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
    driver = undefined;
    dataRoot = undefined;
  });

  it("reads a judge-direct durable append after stopping and restarting the child host", async () => {
    driver = createGroupChatHostDriver();
    const fixture = groupChatSyntheticFixture;
    const firstRun = await driver.startHost();
    if (firstRun.dataRoot === undefined) throw new Error("host omitted its dataRoot");
    dataRoot = firstRun.dataRoot;
    expect(dataRoot).toBe(realpathSync(dataRoot));
    expect(firstRun.pid).toBeGreaterThan(0);

    await driver.resetScenario("GC-01", fixture);
    const command: GroupChatCommand = {
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding: fixture.trustedOwnerBinding,
      body: "adapter-write",
    };
    await driver.perform(command);
    const adapterEvent = (await driver.readRoomEvents()).find(
      (event) => event.body === "adapter-write",
    );
    expect(adapterEvent?.authorId).toBe(fixture.humanId);

    await driver.stopHost();
    const judge = new RoomEventStore(dataRoot);
    const direct = judge.append({
      operationId: "judge-direct-operation",
      roomId: fixture.roomId,
      principalId: fixture.residentIds.a,
      authorId: fixture.residentIds.a,
      body: "judge-direct-write",
      visibility: "public",
      requestSemantics: "judge-direct-write",
    });
    judge.close();

    const restartedRun = await driver.startHost();
    expect(restartedRun.pid).not.toBe(firstRun.pid);
    expect(restartedRun.dataRoot).toBe(dataRoot);
    const readback = await driver.readRoomEvents(fixture.roomId);
    expect(readback.map((event) => event.id)).toContain(direct.event.id);
    expect(readback.find((event) => event.id === direct.event.id)?.body).toBe("judge-direct-write");
  });

  it("returns a rejected room write and reason to its sender without recording it", async () => {
    driver = createGroupChatHostDriver();
    const fixture = groupChatSyntheticFixture;
    const run = await driver.startHost();
    dataRoot = (run as typeof run & { readonly dataRoot: string }).dataRoot;

    await driver.resetScenario("GC-01", fixture);
    const command: GroupChatCommand = {
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding: "test-binding:wrong",
      body: "must-not-be-recorded",
    };

    await driver.perform(command);
    expect(await driver.readRoomEvents(fixture.roomId)).toEqual([]);
    expect(await driver.readSystemReceipts()).toEqual([]);
  });

  it.each([
    {
      label: "missing public declaration",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        binding: fixture.trustedOwnerBinding,
        body: "missing-visibility",
      }),
    },
    {
      label: "empty room",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: "",
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "empty-room",
      }),
    },
    {
      label: "missing room binding",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        body: "missing-binding",
      }),
    },
    {
      label: "private fields",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "private-field-canary",
        privateFields: ["not-for-room"],
      }),
    },
  ] as const)(
    "passes $label unchanged to the real child host for rejection",
    async ({ valid, invalid }) => {
      driver = createGroupChatHostDriver();
      const fixture = groupChatSyntheticFixture;
      const run = await driver.startHost();
      dataRoot = run.dataRoot;
      await driver.resetScenario("GC-01", fixture);

      await driver.perform(valid(fixture) as unknown as GroupChatCommand);
      await driver.perform(invalid(fixture) as unknown as GroupChatCommand);

      const events = await driver.readRoomEvents(fixture.roomId);
      expect(events).toHaveLength(1);
      expect(events[0]?.body).toBe("visible-control");
      expect(await driver.readSystemReceipts()).toHaveLength(1);
    },
  );

  it("turns red when adapter readback is a pre-restart memory copy", async () => {
    const realDriver = createGroupChatHostDriver();
    driver = realDriver;
    const firstRun = await realDriver.startHost();
    if (firstRun.dataRoot === undefined) throw new Error("host omitted its dataRoot");
    dataRoot = firstRun.dataRoot;
    const memoryCopy = await realDriver.readRoomEvents(groupChatSyntheticFixture.roomId);
    await realDriver.stopHost();

    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const facts: HostProvenanceFacts = {
      headCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
      judgePid: process.pid,
      judgeExecutable: realpathSync(process.execPath),
      repoRoot,
      readProcess: (pid) => readProcessInfo(pid),
    };
    let childRunning = false;
    const memoryOnlyReadback: GroupChatHostDriver = {
      ...realDriver,
      startHost: async () => {
        const run = await realDriver.startHost();
        childRunning = true;
        return run;
      },
      stopHost: async () => {
        await realDriver.stopHost();
        childRunning = false;
      },
      readRoomEvents: async (roomId) => {
        if (!childRunning) return realDriver.readRoomEvents(roomId);
        return memoryCopy.filter((event) => roomId === undefined || event.roomId === roomId);
      },
    };

    const result = await judgeDirectWriteReadback(memoryOnlyReadback, firstRun, facts);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("missed or altered");
  });
});
