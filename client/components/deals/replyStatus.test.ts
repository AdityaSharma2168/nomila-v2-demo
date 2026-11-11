import { statusAfterReply } from "./replyStatus";

describe("statusAfterReply", () => {
  it("follows the intent she sent", () => {
    expect(statusAfterReply("accept")).toBe("accepted");
    expect(statusAfterReply("negotiate")).toBe("negotiating");
    expect(statusAfterReply("request_terms")).toBe("negotiating");
    expect(statusAfterReply("decline")).toBe("rejected");
  });
});
