// Who is using this page: the profile picker.
import { PROFILE_KEY } from "./api";
import { dom, PHONE } from "./dom";
import { loadDraft } from "./drafts";
import { h } from "./html";
import { renderAll } from "./render";
import { state } from "./state";
import { loadReadMarkers, refreshUnread } from "./unread";

function setMe(id: string): void {
  state.me = id;
  localStorage.setItem(PROFILE_KEY, id);
  dom.profileSelect.value = id;
  loadReadMarkers();
  renderAll();
  loadDraft();
  void refreshUnread();
}

export function askProfile(): void {
  dom.profileChoices.replaceChildren(
    ...state.humans.map((id) => {
      const button = h("button", "btn btn-primary profile-choice", id);
      button.type = "button";
      button.addEventListener("click", () => {
        dom.profileDialog.close();
        setMe(id);
        if (!PHONE.matches) dom.input.focus();
      });
      return button;
    })
  );
  if (!dom.profileDialog.open) dom.profileDialog.showModal();
}

dom.profileDialog.addEventListener("cancel", (event) => event.preventDefault());
dom.profileSelect.addEventListener("change", () => setMe(dom.profileSelect.value));
