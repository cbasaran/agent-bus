// The New group dialog.
import { dom } from "./dom";
import { agentDetail, sortedUnique } from "./format";
import { h } from "./html";
import { navigate } from "./routing";
import { agents, state } from "./state";

function openGroupDialog(): void {
  if (!state.me) return;
  dom.groupError.hidden = true;
  const choices: { id: string; detail: string; dot: string }[] = [
    ...agents().map((a) => ({ id: a.id, detail: agentDetail(a, true), dot: a.online ? "dot-on" : "dot-off" })),
    ...state.humans.filter((id) => id !== state.me).map((id) => ({ id, detail: "human", dot: "dot-human" })),
  ];
  if (choices.length === 0) {
    dom.groupChoices.replaceChildren(h("li", "side-empty", "Nobody else is on the bus yet."));
  } else {
    dom.groupChoices.replaceChildren(
      ...choices.map((choice) => {
        const li = h("li");
        const label = h("label", "group-choice");
        const box = h("input");
        box.type = "checkbox";
        box.value = choice.id;
        const text = h("span", "side-item-text");
        text.append(h("span", "side-item-title", choice.id), h("span", "side-item-detail", choice.detail));
        label.append(box, h("span", `dot ${choice.dot}`), text);
        li.append(label);
        return li;
      })
    );
  }
  dom.groupDialog.showModal();
}

dom.newGroupBtn.addEventListener("click", openGroupDialog);
dom.groupCancel.addEventListener("click", () => dom.groupDialog.close());
dom.groupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const picked = Array.from(dom.groupChoices.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map(
    (box) => box.value
  );
  if (picked.length === 0) {
    dom.groupError.textContent = "Pick at least one participant.";
    dom.groupError.hidden = false;
    return;
  }
  dom.groupDialog.close();
  navigate({ kind: "draft", to: sortedUnique(picked) });
  dom.input.focus();
});
