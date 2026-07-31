"use strict";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

const MODELS = [
  {
    key: "bbox",
    label: "Poneglyph-BBox",
    statusCommand: "get_local_model_status",
    loadCommand: "load_local_model",
    downloadCommand: "download_local_model",
    runCommand: "run_local_ocr",
    args: {},
  },
  {
    key: "text",
    label: "Poneglyph texte",
    statusCommand: "get_local_text_model_status",
    loadCommand: "load_local_text_model",
    downloadCommand: "download_local_text_model",
    runCommand: "run_local_text_ocr",
    args: {},
  },
  {
    key: "surya",
    label: "Surya texte",
    statusCommand: "get_local_surya_model_status",
    loadCommand: "load_local_surya_model",
    downloadCommand: "download_local_surya_model",
    runCommand: "run_local_surya_ocr",
    args: {},
  },
  {
    key: "surya_bbox",
    label: "Surya-BBox",
    statusCommand: "get_local_surya_bbox_model_status",
    loadCommand: "load_local_surya_bbox_model",
    downloadCommand: "download_local_surya_bbox_model",
    runCommand: "run_local_surya_bbox_ocr",
    args: {},
  },
];

const state = {
  statuses: new Map(),
  selectedFile: null,
  busy: false,
};

function getInvoke() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("Les commandes natives ne sont disponibles que dans l’application desktop.");
  }
  return invoke;
}

function humanError(error) {
  if (typeof error === "string") return error;
  return error?.message || "Une erreur locale est survenue.";
}

function statusLabel(status) {
  if (status?.ready) return "Prêt";
  if (status?.loading) return "Chargement";
  if (status?.download?.active) return "Téléchargement";
  if (status?.installed) return "Installé";
  if (status?.error) return "Erreur";
  return "Absent";
}

function statusClass(status) {
  if (status?.ready) return "ready";
  if (status?.error) return "error";
  return "";
}

function modelDetails(status) {
  if (!status) return "État indisponible";
  if (status.error) return status.error;
  if (status.download?.active) {
    const downloaded = Number(status.download.downloaded_bytes || 0);
    const total = Number(status.download.total_bytes || 0);
    const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
    return percent === null ? "Téléchargement vérifié en cours…" : `Téléchargement vérifié : ${percent} %`;
  }
  const runtime = [status.device, status.dtype].filter(Boolean).join(" · ");
  if (status.ready) return runtime || "Modèle chargé en mémoire";
  if (status.installed) return "Artefacts installés et prêts à être chargés";
  return "Téléchargement requis avant utilisation";
}

function createButton(label, className, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${className}`.trim();
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function renderModels() {
  const container = document.getElementById("models");
  container.replaceChildren();

  for (const model of MODELS) {
    const status = state.statuses.get(model.key);
    const card = document.createElement("article");
    card.className = "model-card";

    const heading = document.createElement("div");
    heading.className = "model-heading";
    const name = document.createElement("span");
    name.className = "model-name";
    name.textContent = model.label;
    const badge = document.createElement("span");
    badge.className = `model-state ${statusClass(status)}`.trim();
    badge.textContent = statusLabel(status);
    heading.append(name, badge);

    const details = document.createElement("p");
    details.className = "model-meta";
    details.textContent = modelDetails(status);

    const actions = document.createElement("div");
    actions.className = "model-actions";
    const actionBusy = state.busy || status?.loading || status?.download?.active;
    if (!status?.installed) {
      actions.append(createButton("Télécharger", "primary", () => downloadModel(model), actionBusy));
    } else if (!status?.ready) {
      actions.append(createButton("Charger", "primary", () => loadModel(model), actionBusy));
    } else {
      actions.append(createButton("Actualiser", "secondary", refreshLocalState, state.busy));
    }

    card.append(heading, details, actions);
    container.append(card);
  }
}

async function withBusy(action) {
  if (state.busy) return;
  state.busy = true;
  renderModels();
  try {
    await action();
  } finally {
    state.busy = false;
    renderModels();
  }
}

async function downloadModel(model) {
  const confirmed = window.confirm(
    `Télécharger ${model.label} ?\n\nLe dépôt, la révision, la taille et l’intégrité sont contrôlés par le manifeste embarqué.`,
  );
  if (!confirmed) return;

  await withBusy(async () => {
    try {
      await getInvoke()(model.downloadCommand, model.args);
      await refreshLocalState();
    } catch (error) {
      state.statuses.set(model.key, { error: humanError(error) });
    }
  });
}

async function loadModel(model) {
  await withBusy(async () => {
    try {
      const status = await getInvoke()(model.loadCommand, model.args);
      state.statuses.set(model.key, status);
    } catch (error) {
      state.statuses.set(model.key, { error: humanError(error), installed: true });
    }
  });
}

async function refreshHealth() {
  const element = document.getElementById("health");
  element.className = "health-card";
  element.textContent = "Vérification du backend local…";
  try {
    const health = await getInvoke()("healthcheck_local_backend");
    if (!health?.ok) throw new Error(health?.error || "Backend local indisponible");
    const runtime = [health.device, health.torch_version ? `PyTorch ${health.torch_version}` : null]
      .filter(Boolean)
      .join(" · ");
    element.classList.add("ready");
    element.textContent = runtime || "Backend OCR local prêt";
  } catch (error) {
    element.classList.add("error");
    element.textContent = humanError(error);
  }
}

async function refreshModels() {
  const invoke = getInvoke();
  await Promise.all(MODELS.map(async (model) => {
    try {
      const status = await invoke(model.statusCommand, model.args);
      state.statuses.set(model.key, status);
    } catch (error) {
      state.statuses.set(model.key, { error: humanError(error) });
    }
  }));
  renderModels();
}

async function refreshLocalState() {
  await Promise.all([refreshHealth(), refreshModels()]);
}

function validateSelectedFile(file) {
  if (!file) throw new Error("Choisissez une image.");
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Format non pris en charge. Utilisez PNG, JPEG, WebP ou AVIF.");
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    throw new Error("L’image doit peser au maximum 20 Mio.");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Impossible de lire l’image."));
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const separator = dataUrl.indexOf(",");
      if (separator < 0) {
        reject(new Error("Encodage d’image invalide."));
        return;
      }
      resolve(dataUrl.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function runOcr() {
  const feedback = document.getElementById("ocr-feedback");
  const output = document.getElementById("ocr-result");
  const button = document.getElementById("run-ocr");
  feedback.className = "feedback";
  output.textContent = "";

  try {
    validateSelectedFile(state.selectedFile);
    const model = MODELS.find((item) => item.key === document.getElementById("ocr-engine").value);
    const status = state.statuses.get(model.key);
    if (!status?.ready) throw new Error(`Chargez d’abord le moteur ${model.label}.`);

    button.disabled = true;
    feedback.textContent = "Inférence locale en cours…";
    const image_bytes_base64 = await fileToBase64(state.selectedFile);
    const result = await getInvoke()(model.runCommand, { image_bytes_base64, ...model.args });
    output.textContent = typeof result?.text === "string"
      ? result.text
      : JSON.stringify(result?.bubbles || result, null, 2);
    feedback.textContent = "OCR terminé localement.";
  } catch (error) {
    feedback.classList.add("error");
    feedback.textContent = humanError(error);
  } finally {
    button.disabled = !state.selectedFile;
  }
}

async function initialize() {
  document.getElementById("reload-web").addEventListener("click", () => {
    document.getElementById("web-content").src = "https://poneglyph.fr";
  });
  document.getElementById("refresh-local").addEventListener("click", refreshLocalState);
  document.getElementById("run-ocr").addEventListener("click", runOcr);
  document.getElementById("ocr-file").addEventListener("change", (event) => {
    const feedback = document.getElementById("ocr-feedback");
    state.selectedFile = event.target.files?.[0] || null;
    document.getElementById("run-ocr").disabled = !state.selectedFile;
    feedback.className = "feedback";
    feedback.textContent = state.selectedFile
      ? `${state.selectedFile.name} · ${(state.selectedFile.size / 1024 / 1024).toFixed(1)} Mio`
      : "";
  });

  try {
    const version = await getInvoke()("get_app_version");
    document.getElementById("app-version").textContent = `Version ${version} · shell local sécurisé`;
    await refreshLocalState();
  } catch (error) {
    const health = document.getElementById("health");
    health.classList.add("error");
    health.textContent = humanError(error);
    renderModels();
  }
}

window.addEventListener("DOMContentLoaded", initialize, { once: true });
