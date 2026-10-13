import { describe, expect, it } from "vitest";
import { snowflakeTime } from "../src/discord/rest";

describe("snowflakeTime", () => {
  it("decodes the creation time of a Discord ID", () => {
    expect(snowflakeTime("175928847299117063")).toBe(1462015105796);
  });
});
