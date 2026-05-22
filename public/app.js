const messages = document.querySelector("#messages");
const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const sourceBadge = document.querySelector("#sourceBadge");
const refreshNote = document.querySelector("#refreshNote");

function addMessage(role, text, extraClass = "") {
  const article = document.createElement("article");
  article.className = `message ${role} ${extraClass}`.trim();
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  article.appendChild(bubble);
  messages.appendChild(article);
  messages.scrollTop = messages.scrollHeight;
  return article;
}

function setFreshnessStatus(payload) {
  if (!payload.freshness) return;

  const ageText = payload.freshness.ageMinutes === null ? "unknown age" : `${payload.freshness.ageMinutes} min old`;
  refreshNote.textContent = `Refreshed ${payload.freshness.refreshedAtDisplay}; newest data ${ageText}`;
  refreshNote.classList.toggle("warning", Boolean(payload.freshness.isStale));
  sourceBadge.classList.toggle("warning", Boolean(payload.freshness.isStale));
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: text,
    };
  }
}

async function sendMessage(text) {
  addMessage("user", text);
  input.value = "";
  input.disabled = true;
  sourceBadge.textContent = "Fetching";
  sourceBadge.classList.remove("warning");
  refreshNote.textContent = "Refreshing PLC data...";
  refreshNote.classList.remove("warning");
  const thinking = addMessage("bot", "Fetching PLC data...", "thinking");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    const payload = await readJsonResponse(response);
    thinking.remove();

    if (!response.ok) {
      addMessage("bot", payload.error || `Request failed with HTTP ${response.status}.`);
      sourceBadge.textContent = "Error";
      refreshNote.textContent = "Refresh failed";
      refreshNote.classList.add("warning");
      return;
    }

    addMessage("bot", payload.answer);
    sourceBadge.textContent = payload.source === "ollama" ? "Ollama" : "Fast data";
    setFreshnessStatus(payload);
  } catch (error) {
    thinking.remove();
    addMessage("bot", error.message || "Network error.");
    sourceBadge.textContent = "Error";
    refreshNote.textContent = "Refresh failed";
    refreshNote.classList.add("warning");
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function checkSystem() {
  addMessage("user", "Check system");
  input.disabled = true;
  sourceBadge.textContent = "Checking";
  sourceBadge.classList.remove("warning");
  refreshNote.textContent = "Checking InfluxDB and Ollama...";
  refreshNote.classList.remove("warning");
  const thinking = addMessage("bot", "Checking system status...", "thinking");

  try {
    const response = await fetch("/api/health");
    const payload = await readJsonResponse(response);
    thinking.remove();

    if (!response.ok) {
      addMessage("bot", payload.error || `System check failed with HTTP ${response.status}.`);
      sourceBadge.textContent = "Error";
      refreshNote.textContent = "System check failed";
      refreshNote.classList.add("warning");
      return;
    }

    addMessage("bot", payload.answer);
    sourceBadge.textContent = "System";
    setFreshnessStatus(payload);
  } catch (error) {
    thinking.remove();
    addMessage("bot", error.message || "Network error.");
    sourceBadge.textContent = "Error";
    refreshNote.textContent = "System check failed";
    refreshNote.classList.add("warning");
  } finally {
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text) sendMessage(text);
});

document.querySelectorAll("[data-question]").forEach((button) => {
  button.addEventListener("click", () => {
    sendMessage(button.dataset.question);
  });
});

document.querySelectorAll("[data-health-check]").forEach((button) => {
  button.addEventListener("click", () => {
    checkSystem();
  });
});
