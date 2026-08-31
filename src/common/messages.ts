/** Student-facing copy. Override with env VOICE_MSG_* if needed. */

export const MSG = {
  notInTextbook:
    process.env.VOICE_MSG_NOT_IN_TEXTBOOK ||
    "I can help with the topics covered in your textbook, but I don't have enough information about that in the material we're studying.",
  outOfScope: (classLevel: string, subject: string) =>
    process.env.VOICE_MSG_OUT_OF_SCOPE ||
    `I can help you with your ${classLevel} ${subject} topics. Let's continue with your lesson.`,
  didntCatch:
    process.env.VOICE_MSG_DIDNT_CATCH ||
    "Sorry, I didn't catch that. Could you say it again?",
  sttFail: "Sorry, I didn't catch that. Could you say it again?",
  llmFail: "I had a little trouble thinking just now. Could you ask that again?",
  ragFail: "I couldn't reach your textbook just now. Let's try that question once more.",
  ttsFail: "I have an answer, but I couldn't speak it. Check the transcript.",
  webrtcFail: "We couldn't start the voice connection. Tap Start Talking to try again.",
  micDenied: "I need the microphone to hear you. Allow it in your browser, then try again.",
  unsupported: "This browser can't do live voice yet. Try Chrome on this device.",
  network: "We lost the connection. I'll listen again when you're back.",
  emptySpeech: "Sorry, I didn't catch that. Could you say it again?",
  timeout: "That took a bit too long. Let's try once more.",
  correct: "Exactly!",
  partial: "You're on the right track.",
  incorrect: "Not quite. Let's look at it another way.",
  uncertain: "I'm not sure I understood your answer. Can you say it in another way?",
};
