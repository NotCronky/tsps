"use strict";

/**
 * Answering a dialogue the way a player who wants to get on with it does: the willing option
 * ("Yes", "Okay", "Take me there") where there is one, otherwise the first that isn't a refusal,
 * and Continue on everything else. Used by scouts and by bots travelling (boat fares, "Are you sure
 * you want to go down?").
 */

const YES = /\b(yes|yeah|ok|okay|sure|i'?ll|go|enter|climb|travel|continue|proceed|please|board|down|up|let'?s|ready|i want|take me|jump|risk|take everything)\b/i;
const NO = /\b(no|cancel|never ?mind|not|stay|later)\b/i;

/** Answers the current dialogue once; returns what it did, for the record. */
function answerDialogue(dialogue) {
  const current = dialogue.getCurrent();
  const options = typeof current?.getOptions === "function" ? current.getOptions() : null;
  if (Array.isArray(options) && options.length) {
    const texts = options.map((option) => String(option?.text ?? option ?? ""));
    let choice = texts.findIndex((text) => YES.test(text) && !NO.test(text));
    if (choice < 0) choice = texts.findIndex((text) => !NO.test(text));
    if (choice < 0) choice = 0;
    dialogue.handleOption(choice + 1);
    return `choose "${texts[choice]}"`;
  }
  dialogue.advance();
  return "continue";
}

/**
 * Answers an open chatbox prompt (MultiChatboxPrompt: "Leave the Gnome Stronghold?", the tool
 * storage's "Take everything.") as the client's click on an option does; null if none is open.
 * These aren't dialogues, so answerDialogue never saw them: a bot stood at the Gnome Stronghold's
 * opening with the question up until its trip gave the transport up.
 */
function answerPrompt(core, player) {
  const Prompt = core?.MultiChatboxPrompt;
  const pending = Prompt?.getPending?.(player);
  if (!pending?.options?.length) return null;
  const texts = pending.options.map(String);
  let choice = texts.findIndex((text) => YES.test(text) && !NO.test(text));
  if (choice < 0) choice = texts.findIndex((text) => !NO.test(text));
  if (choice < 0) choice = 0;
  Prompt.handleInterfaceActionClick({ player, buttonId: Prompt.OPTIONS_WIDGET_ID, groupId: 219, slot: choice + 1, action: choice + 1 });
  return `prompt "${texts[choice]}"`;
}

module.exports = { answerDialogue, answerPrompt };
