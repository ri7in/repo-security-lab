import { describe, expect, it } from "vitest";
import { orderWaitingRepositories } from "@app/core";
import { repository } from "./helpers.js";

describe("scheduler", () => {
  it("orders by attempt count then immutable repository id", () => {
    const ordered = orderWaitingRepositories([
      repository(90, "waiting", 1),
      repository(30, "waiting", 0),
      repository(20, "waiting", 0),
      repository(10, "waiting", 2),
    ]);
    expect(ordered.map((item) => item.repositoryId)).toEqual([20, 30, 90, 10]);
  });

  it("excludes non-waiting rows and does not mutate input", () => {
    const input = [
      repository(2, "complete"),
      repository(3, "waiting"),
      repository(1, "leased"),
    ];
    const snapshot = [...input];
    expect(orderWaitingRepositories(input).map((item) => item.repositoryId)).toEqual([3]);
    expect(input).toEqual(snapshot);
  });
});
