import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReplyIntent, isBareAcknowledgement, ackReply, isPersonalIntro } from "./reply-intent";

describe("classifyReplyIntent", () => {
  it("detects closing", () => {
    assert.equal(classifyReplyIntent("Bye bye.", false), "CLOSING");
    assert.equal(classifyReplyIntent("Thanks for your help.", false), "CLOSING");
    assert.equal(classifyReplyIntent("I have some work to do.", false), "CLOSING");
  });

  it("detects dont know before wrong-answer grading", () => {
    assert.equal(classifyReplyIntent("I don't know.", true), "DONT_KNOW");
    assert.equal(classifyReplyIntent("I didn't get what you're saying.", true), "DONT_KNOW");
  });

  it("grades substantive quiz answers as wrong-answer candidate", () => {
    assert.equal(classifyReplyIntent("kings and their armies", true), "WRONG_ANSWER");
  });

  it("treats affirmation as new question when quiz pending", () => {
    assert.equal(classifyReplyIntent("yes.", true), "NEW_QUESTION");
  });

  it("never grades a reaction as a wrong quiz answer", () => {
    for (const ack of ["(laughing)", "haha", "wow", "interesting", "cool"]) {
      assert.equal(classifyReplyIntent(ack, true), "UNCLEAR", `graded a reaction: ${ack}`);
    }
  });
});

describe("isBareAcknowledgement", () => {
  it("treats laughter and okay as acks", () => {
    assert.equal(isBareAcknowledgement("(laughing)"), true);
    assert.equal(isBareAcknowledgement("Okay."), true);
    assert.equal(isBareAcknowledgement("wow"), true);
    assert.equal(isBareAcknowledgement("interesting"), true);
  });

  it("does not treat educational follow-ups as acks", () => {
    assert.equal(isBareAcknowledgement("Tell me more about the Hoysalas."), false);
    assert.equal(isBareAcknowledgement("Did it control all of India?"), false);
    assert.equal(isBareAcknowledgement("Who established the Mughal Empire?"), false);
    assert.equal(isBareAcknowledgement("Can you tell me about India's political map?"), false);
  });

  it("treats praise of an example as an ack, not a request for one", () => {
    assert.equal(isBareAcknowledgement("Okay, a nice example."), true);
    assert.equal(isBareAcknowledgement("nice example"), true);
    assert.equal(isBareAcknowledgement("give me an example"), false);
  });

  it("returns a short spoken ack", () => {
    assert.equal(ackReply("(laughing)"), "Glad you're enjoying it!");
    assert.equal(ackReply("Okay."), "Alright.");
  });
});

describe("isPersonalIntro", () => {
  it("detects name introductions", () => {
    assert.equal(isPersonalIntro("I am Seyun, D-E-L-H-I."), true);
    assert.equal(isPersonalIntro("My name is Suneel"), true);
    assert.equal(isPersonalIntro("What are natural resources?"), false);
  });
});
