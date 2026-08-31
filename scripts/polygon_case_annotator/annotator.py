from __future__ import annotations

import argparse
import json
import math
import queue
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from PIL import Image, ImageDraw, ImageTk

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pass

ROOT = Path(__file__).resolve().parents[2]
OLD_TOOL = ROOT / "docker_scripts" / "train_panel_detector"
DEFAULT_DATASET = Path(__file__).resolve().parent / "cache" / "dataset.json"
DEFAULT_ANNOTATIONS = Path(__file__).resolve().parent / "polygon_annotations.json"
DEFAULT_EXPORT = Path(__file__).resolve().parent / "yolo_polygon_dataset"
MODEL_CACHE = Path(__file__).resolve().parent / "models"
HF_PANEL_MODEL_URL = "https://huggingface.co/Remidesbois/YoloPiece_OneShot_Models/resolve/main/panel_detector.onnx"
HF_PANEL_MODEL_PATH = MODEL_CACHE / "panel_detector.onnx"
LATEST_TRAINED_HF_REPO = "Remidesbois/Yolo11-seg-Panel-Poneglyph"
LATEST_TRAINED_HF_URL = f"https://huggingface.co/{LATEST_TRAINED_HF_REPO}/resolve/main/weights/best.pt"
LOCAL_TRAINED_MODEL_REPO = ROOT / "scripts" / "Yolo11-seg-Panel-Poneglyph"
RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    tmp.replace(path)


def number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def page_id(page: dict[str, Any]) -> int:
    return int(round(number(page.get("page_id", page.get("id")))))


def image_path_for(page: dict[str, Any], base: Path) -> Path:
    value = page.get("image_file") or page.get("image_path") or page.get("file")
    path = Path(str(value or ""))
    return path if path.is_absolute() else base / path


def rect_polygon(item: dict[str, Any]) -> list[list[float]]:
    bbox = item.get("bbox") if isinstance(item.get("bbox"), dict) else item
    x, y = number(bbox.get("x")), number(bbox.get("y"))
    w, h = max(1, number(bbox.get("w"), 1)), max(1, number(bbox.get("h"), 1))
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def polygon_from_item(item: dict[str, Any]) -> list[list[float]]:
    points = item.get("polygon") or item.get("points")
    if isinstance(points, list) and len(points) == 4:
        result = [[number(p[0]), number(p[1])] for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
        if len(result) == 4:
            return result
    return rect_polygon(item)


def clamp_polygon(points: list[list[float]], width: int, height: int) -> list[list[float]]:
    return [[max(0.0, min(float(width), p[0])), max(0.0, min(float(height), p[1]))] for p in points]


def snap_point_to_dark(point: list[float], gray_image: Image.Image, radius: int = 8, threshold: int = 70) -> list[float]:
    """Snap a predicted or manually moved vertex to a nearby dark image pixel."""
    x, y = point
    center_x, center_y = int(round(x)), int(round(y))
    best: tuple[float, int, int] | None = None
    left, top = max(0, center_x - radius), max(0, center_y - radius)
    right = min(gray_image.width - 1, center_x + radius)
    bottom = min(gray_image.height - 1, center_y + radius)
    for py in range(top, bottom + 1):
        for px in range(left, right + 1):
            if gray_image.getpixel((px, py)) > threshold:
                continue
            distance = (px - x) ** 2 + (py - y) ** 2
            if best is None or distance < best[0]:
                best = (distance, px, py)
    if best is None or best[0] > radius * radius:
        return [float(x), float(y)]
    return [float(best[1]), float(best[2])]


def snap_polygon_to_dark(points: list[list[float]], gray_image: Image.Image) -> list[list[float]]:
    return [snap_point_to_dark(point, gray_image) for point in points]


def polygon_area(points: list[list[float]]) -> float:
    return abs(sum(points[i][0] * points[(i + 1) % 4][1] - points[(i + 1) % 4][0] * points[i][1] for i in range(4))) / 2


def center(points: list[list[float]]) -> tuple[float, float]:
    return sum(p[0] for p in points) / 4, sum(p[1] for p in points) / 4


def sort_rtl(cases: list[dict[str, Any]]) -> None:
    if not cases:
        return
    heights = [max(1, max(p[1] for p in polygon_from_item(c)) - min(p[1] for p in polygon_from_item(c))) for c in cases]
    band = max(40, sorted(heights)[len(heights) // 2] * 0.6)
    cases.sort(key=lambda c: (int(center(polygon_from_item(c))[1] // band), -center(polygon_from_item(c))[0]))
    for i, case in enumerate(cases, 1):
        case["order"] = i


def discover_model(explicit: Path | None) -> Path | None:
    if explicit and explicit.exists():
        return explicit
    metrics = OLD_TOOL / "metrics" / "latest_panel_metrics.json"
    if metrics.exists():
        try:
            data = read_json(metrics)
            for key in ("model_path", "weights", "best_model"):
                value = data.get(key)
                if value and Path(value).exists():
                    return Path(value)
        except (OSError, json.JSONDecodeError):
            pass
    candidates = sorted(OLD_TOOL.glob("runs/**/weights/best.pt"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else (OLD_TOOL / "yolo26n.pt" if (OLD_TOOL / "yolo26n.pt").exists() else None)


def discover_latest_trained_model() -> Path | None:
    candidates = []
    alias = MODEL_CACHE / "latest_polygon_seg.pt"
    if alias.exists():
        candidates.append(alias)
    candidates.extend(LOCAL_TRAINED_MODEL_REPO.glob("weights/best.pt"))
    candidates.extend(LOCAL_TRAINED_MODEL_REPO.glob("runs/**/weights/best.pt"))
    runs = Path(__file__).resolve().parent / "runs"
    candidates.extend(runs.glob("**/weights/best.pt"))
    candidates = sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def mask_to_quad(points: Any) -> list[list[float]] | None:
    """Reduce a YOLO segmentation contour to the required four vertices."""
    try:
        import cv2
        import numpy as np
        contour = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
        if len(contour) < 3:
            return None
        perimeter = cv2.arcLength(contour, True)
        for ratio in (0.015, 0.025, 0.04, 0.06, 0.09):
            approximation = cv2.approxPolyDP(contour, ratio * perimeter, True)
            if len(approximation) == 4:
                return [[float(point[0][0]), float(point[0][1])] for point in approximation]
        rectangle = cv2.boxPoints(cv2.minAreaRect(contour))
        return [[float(point[0]), float(point[1])] for point in rectangle]
    except (ImportError, ValueError, TypeError):
        return None


class App(tk.Tk):
    def __init__(self, dataset_path: Path, output_path: Path, model_path: Path | None, confidence: float):
        super().__init__()
        self.title("Poneglyph · annotation des cases polygonales")
        self.geometry("1600x980")
        self.minsize(1100, 720)
        self.dataset_path, self.base, self.output_path = dataset_path.resolve(), dataset_path.resolve().parent, output_path.resolve()
        self.data = read_json(self.dataset_path)
        self.pages = self.data.get("pages") or []
        if not self.pages:
            raise ValueError("Le dataset ne contient aucune page.")
        self.model_path, self.confidence = model_path, confidence
        self.model = None
        self.index = 0
        self.image: Image.Image | None = None
        self.gray_image: Image.Image | None = None
        self.photo = None
        self.zoom_photo = None
        self.scale = 1.0
        self.selected: int | None = None
        self.drag_vertex: int | None = None
        self.drag_case = False
        self.drag_origin: tuple[float, float] | None = None
        self.adding = False
        self.new_points: list[list[float]] = []
        self.preview_point: tuple[float, float] | None = None
        self.preview_visible = False
        self.dirty = False
        self.tasks: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.detection_running = False
        self._load_saved()
        self._build_ui()
        self._bind_events()
        self.load_page(0, False)
        self.after(100, self._poll_tasks)

    def _load_saved(self) -> None:
        saved = {}
        if self.output_path.exists():
            try:
                saved = {int(number(p.get("page_id"))): p for p in read_json(self.output_path).get("pages", [])}
            except (OSError, json.JSONDecodeError):
                pass
        for page in self.pages:
            old = saved.get(page_id(page), {})
            raw = old.get("cases", page.get("cases", []))
            page["cases"] = [{"id": c.get("case_id") or c.get("id") or f"case_{i}", "order": i, "polygon": polygon_from_item(c)} for i, c in enumerate(raw, 1)]

    def _build_ui(self) -> None:
        self.rowconfigure(1, weight=1); self.columnconfigure(0, weight=1)
        bar = ttk.Frame(self, padding=6); bar.grid(row=0, column=0, sticky="ew")
        ttk.Button(bar, text="‹", width=3, command=lambda: self.load_page(max(0, self.index - 1))).pack(side="left")
        ttk.Button(bar, text="›", width=3, command=lambda: self.load_page(min(len(self.pages) - 1, self.index + 1))).pack(side="left", padx=3)
        ttk.Button(bar, text="Page vide suivante", command=self.next_empty).pack(side="left", padx=(0, 10))
        ttk.Button(bar, text="−", width=3, command=lambda: self.zoom_by(.8)).pack(side="left")
        ttk.Button(bar, text="Ajuster", command=self.fit).pack(side="left", padx=3)
        ttk.Button(bar, text="+", width=3, command=lambda: self.zoom_by(1.25)).pack(side="left")
        ttk.Button(bar, text="Analyser page - YOLO26", command=self.detect_current_hf).pack(side="left", padx=8)
        ttk.Button(bar, text="Analyser page - YOLO11-seg", command=self.detect_current_yolo11).pack(side="left")
        ttk.Button(bar, text="Exporter YOLO", command=self.export_yolo).pack(side="right")
        ttk.Button(bar, text="Enregistrer", command=self.save).pack(side="right", padx=5)
        self.page_label = tk.StringVar(); ttk.Label(bar, textvariable=self.page_label).pack(side="left", padx=14)
        main = ttk.Frame(self); main.grid(row=1, column=0, sticky="nsew"); main.rowconfigure(0, weight=1); main.columnconfigure(0, weight=1)
        cf = ttk.Frame(main); cf.grid(row=0, column=0, sticky="nsew"); cf.rowconfigure(0, weight=1); cf.columnconfigure(0, weight=1)
        self.canvas = tk.Canvas(cf, bg="#1f2228", cursor="crosshair", highlightthickness=0); self.canvas.grid(row=0, column=0, sticky="nsew")
        ys = ttk.Scrollbar(cf, orient="vertical", command=self.canvas.yview); ys.grid(row=0, column=1, sticky="ns")
        xs = ttk.Scrollbar(cf, orient="horizontal", command=self.canvas.xview); xs.grid(row=1, column=0, sticky="ew"); self.canvas.configure(xscrollcommand=xs.set, yscrollcommand=ys.set)
        side = ttk.Frame(main, padding=(8, 0, 8, 0), width=330); side.grid(row=0, column=1, sticky="ns"); side.grid_propagate(False)
        ttk.Label(side, text="Pages").pack(anchor="w"); pf = ttk.Frame(side); pf.pack(fill="x", pady=(2, 8)); self.page_list = tk.Listbox(pf, height=8, exportselection=False); self.page_list.pack(side="left", fill="both", expand=True); ps = ttk.Scrollbar(pf, command=self.page_list.yview); ps.pack(side="right", fill="y"); self.page_list.configure(yscrollcommand=ps.set); self.page_list.bind("<<ListboxSelect>>", self.page_selected)
        ttk.Label(side, text="Cases — ordre de lecture").pack(anchor="w"); kf = ttk.Frame(side); kf.pack(fill="both", expand=True, pady=2); self.case_list = tk.Listbox(kf, exportselection=False); self.case_list.pack(side="left", fill="both", expand=True); ks = ttk.Scrollbar(kf, command=self.case_list.yview); ks.pack(side="right", fill="y"); self.case_list.configure(yscrollcommand=ks.set); self.case_list.bind("<<ListboxSelect>>", self.case_selected)
        buttons = ttk.Frame(side); buttons.pack(fill="x", pady=5)
        for text, cmd in (("Ajouter 4 points", self.start_add), ("↑", lambda: self.move_case(-1)), ("↓", lambda: self.move_case(1)), ("Supprimer", self.delete_case)):
            ttk.Button(buttons, text=text, command=cmd).pack(side="left", fill="x", expand=True, padx=1)
        ttk.Button(side, text="Trier droite → gauche / haut → bas", command=self.sort_cases).pack(fill="x", pady=(0, 8))
        ttk.Label(side, text="Zoom du sommet sélectionné").pack(anchor="w")
        self.zoom_label = ttk.Label(side, text="Cliquez puis déplacez un sommet", anchor="center"); self.zoom_label.pack(fill="x", pady=(3, 10))
        self.progress = ttk.Progressbar(side, mode="determinate", maximum=1, value=0); self.progress.pack(fill="x", pady=(2, 3))
        self.progress_label = tk.StringVar(value="Aucune analyse en cours")
        ttk.Label(side, textvariable=self.progress_label).pack(anchor="w")
        ttk.Label(side, text="Journal").pack(anchor="w", pady=(8, 2))
        log_frame = ttk.Frame(side); log_frame.pack(fill="both", expand=False)
        self.log_text = tk.Text(log_frame, height=9, width=36, state="disabled", wrap="word", font=("Consolas", 8))
        self.log_text.pack(side="left", fill="both", expand=True)
        log_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview); log_scroll.pack(side="right", fill="y"); self.log_text.configure(yscrollcommand=log_scroll.set)
        self.status = tk.StringVar(); ttk.Label(self, textvariable=self.status, anchor="w", padding=6).grid(row=2, column=0, sticky="ew")

    def _bind_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.mouse_down); self.canvas.bind("<B1-Motion>", self.mouse_move); self.canvas.bind("<ButtonRelease-1>", self.mouse_up); self.canvas.bind("<Motion>", self.mouse_hover)
        self.canvas.bind("<MouseWheel>", lambda e: self.zoom_by(1.1 if e.delta > 0 else .9)); self.bind("<Control-s>", lambda e: self.save()); self.bind("<Delete>", lambda e: self.delete_case()); self.bind("<Escape>", lambda e: self.cancel_add()); self.bind("<Left>", lambda e: self.load_page(max(0, self.index - 1))); self.bind("<Right>", lambda e: self.load_page(min(len(self.pages) - 1, self.index + 1))); self.protocol("WM_DELETE_WINDOW", self.close)

    def page_selected(self, _=None) -> None:
        sel = self.page_list.curselection()
        if sel: self.load_page(int(sel[0]))

    def case_selected(self, _=None) -> None:
        sel = self.case_list.curselection()
        if sel: self.selected = int(sel[0]); self.render()

    def current(self) -> dict[str, Any]: return self.pages[self.index]
    def cases(self) -> list[dict[str, Any]]: return self.current().setdefault("cases", [])
    def load_page(self, index: int, autosave: bool = True) -> None:
        if autosave and self.dirty: self.save(True)
        self.index = index; page = self.current(); path = image_path_for(page, self.base)
        if not path.exists(): messagebox.showerror("Image absente", str(path)); return
        with Image.open(path) as im: self.image = im.convert("RGB")
        self.gray_image = self.image.convert("L")
        page["width"], page["height"] = self.image.size; self.selected = None; self.adding = False; self.new_points = []; self.fit(False); self.refresh_lists(); self.render(); self.page_label.set(f"Page {index + 1}/{len(self.pages)} · {path.name}"); self.status.set("Cliquez une case pour la sélectionner. Double-cliquez une case pour la déplacer.")

    def refresh_lists(self) -> None:
        self.page_list.delete(0, "end")
        for p in self.pages: self.page_list.insert("end", f"{'●' if p.get('cases') else '○'}  page {page_id(p)} · {len(p.get('cases', []))} cases")
        self.page_list.selection_set(self.index); self.page_list.see(self.index); self.case_list.delete(0, "end")
        for i, c in enumerate(self.cases(), 1): self.case_list.insert("end", f"C{i:02d}   {len(c['polygon'])} points")
        if self.selected is not None and self.selected < len(self.cases()): self.case_list.selection_set(self.selected)

    def fit(self, render: bool = True) -> None:
        if not self.image: return
        self.update_idletasks(); self.scale = min(max(100, self.canvas.winfo_width() - 20) / self.image.width, max(100, self.canvas.winfo_height() - 20) / self.image.height, 1.0)
        if render: self.render()

    def zoom_by(self, factor: float) -> None: self.scale = max(.05, min(5, self.scale * factor)); self.render()
    def to_image(self, x: float, y: float) -> tuple[float, float]:
        return (max(0, min(self.image.width, self.canvas.canvasx(x) / self.scale)), max(0, min(self.image.height, self.canvas.canvasy(y) / self.scale))) if self.image else (0, 0)
    def to_canvas(self, p: list[float]) -> tuple[float, float]: return p[0] * self.scale, p[1] * self.scale

    def render(self) -> None:
        self.canvas.delete("all")
        if not self.image: return
        size = (max(1, round(self.image.width * self.scale)), max(1, round(self.image.height * self.scale))); self.photo = ImageTk.PhotoImage(self.image.resize(size, RESAMPLE)); self.canvas.create_image(0, 0, anchor="nw", image=self.photo); self.canvas.configure(scrollregion=(0, 0, *size))
        for i, case in enumerate(self.cases()):
            pts = [v for p in case["polygon"] for v in self.to_canvas(p)]; selected = i == self.selected; color = "#ff3b30" if selected else "#ffb000"; self.canvas.create_polygon(pts, outline=color, fill="#ffb000" if selected else "", stipple="gray25" if selected else "", width=4 if selected else 2)
            x, y = self.to_canvas(case["polygon"][0]); self.canvas.create_text(x + 5, max(8, y - 10), text=str(i + 1), anchor="w", fill="#ff3030", font=("TkDefaultFont", 11, "bold"))
            if selected:
                for n, p in enumerate(case["polygon"]):
                    x, y = self.to_canvas(p); r = 7; self.canvas.create_oval(x-r, y-r, x+r, y+r, fill="#ffffff", outline="#d71920", width=2); self.canvas.create_text(x, y, text=str(n + 1), fill="#111", font=("TkDefaultFont", 8, "bold"))
        if self.adding and self.new_points:
            pts = [v for p in self.new_points + ([list(self.preview_point)] if self.preview_point else []) for v in self.to_canvas(p)]
            if len(pts) >= 4:
                self.canvas.create_line(pts, fill="#38bdf8", width=3, dash=(6, 3))
            for p in self.new_points: x, y = self.to_canvas(p); self.canvas.create_oval(x-5, y-5, x+5, y+5, fill="#38bdf8", outline="white")

    def nearest_vertex(self, x: float, y: float) -> tuple[int, int] | None:
        best = None; distance = 14 / max(self.scale, .01)
        for i, c in enumerate(self.cases()):
            for v, p in enumerate(c["polygon"]):
                d = math.hypot(p[0] - x, p[1] - y)
                if d < distance: distance, best = d, (i, v)
        return best

    def point_in_case(self, x: float, y: float, points: list[list[float]]) -> bool:
        inside = False
        for i in range(4):
            x1, y1 = points[i]; x2, y2 = points[(i + 1) % 4]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-9) + x1: inside = not inside
        return inside

    def mouse_down(self, event: tk.Event) -> None:
        x, y = self.to_image(event.x, event.y)
        if self.adding:
            self.new_points.append([x, y]); self.render()
            if len(self.new_points) == 4: self.finish_add()
            return
        hit = self.nearest_vertex(x, y)
        if hit:
            self.selected, self.drag_vertex = hit
            self.drag_case = False
            self.drag_origin = (x, y)
            self.preview_visible = True
            point = self.cases()[self.selected]["polygon"][self.drag_vertex]
            self.refresh_lists(); self.render(); self.update_zoom(point[0], point[1]); return
        for i in range(len(self.cases()) - 1, -1, -1):
            if self.point_in_case(x, y, self.cases()[i]["polygon"]): self.selected, self.drag_vertex, self.drag_case, self.drag_origin = i, None, True, (x, y); self.refresh_lists(); self.render(); return
        self.selected = None; self.render()

    def mouse_move(self, event: tk.Event) -> None:
        x, y = self.to_image(event.x, event.y)
        if self.selected is not None and self.drag_origin:
            c = self.cases()[self.selected]
            if self.drag_vertex is not None:
                if event.state & 0x0001:
                    snapped_x, snapped_y = x, y
                else:
                    snapped_x, snapped_y = self.snap_to_dark(x, y)
                c["polygon"][self.drag_vertex] = [snapped_x, snapped_y]
                point = c["polygon"][self.drag_vertex]
                self.update_zoom(point[0], point[1])
            elif self.drag_case:
                dx, dy = x - self.drag_origin[0], y - self.drag_origin[1]; c["polygon"] = clamp_polygon([[p[0] + dx, p[1] + dy] for p in c["polygon"]], self.image.width, self.image.height); self.drag_origin = (x, y)
            self.dirty = True; self.render()
        elif self.adding: self.preview_point = (x, y); self.render()

    def mouse_up(self, _event: tk.Event) -> None:
        self.drag_vertex = None; self.drag_case = False; self.drag_origin = None; self.hide_preview()
    def mouse_hover(self, _event: tk.Event) -> None:
        pass

    def update_zoom(self, x: float, y: float) -> None:
        if not self.image or not self.preview_visible: return
        size = 100
        left, top = int(round(x - size / 2)), int(round(y - size / 2))
        right, bottom = left + size, top + size
        source_left, source_top = max(0, left), max(0, top)
        source_right, source_bottom = min(self.image.width, right), min(self.image.height, bottom)
        padded = Image.new("RGB", (size, size), "black")
        if source_right > source_left and source_bottom > source_top:
            crop = self.image.crop((source_left, source_top, source_right, source_bottom))
            padded.paste(crop, (source_left - left, source_top - top))
        preview = padded.resize((220, 220), RESAMPLE)
        draw = ImageDraw.Draw(preview)
        draw.line((110, 0, 110, 220), fill="#ff3030", width=1)
        draw.line((0, 110, 220, 110), fill="#ff3030", width=1)
        self.zoom_photo = ImageTk.PhotoImage(preview)
        self.zoom_label.configure(image=self.zoom_photo, text="")

    def snap_to_dark(self, x: float, y: float) -> tuple[float, float]:
        """Attach a dragged vertex to the closest dark pixel in a small radius."""
        if self.gray_image is None:
            return x, y
        snapped = snap_point_to_dark([x, y], self.gray_image)
        return snapped[0], snapped[1]
    def hide_preview(self) -> None:
        self.preview_visible = False
        self.zoom_photo = None
        self.zoom_label.configure(image="", text="Cliquez-maintenez un sommet pour le déplacer")

    def start_add(self) -> None: self.adding, self.new_points = True, []; self.preview_point = None; self.status.set("Cliquez les 4 sommets dans l’ordre horaire (ou antihoraire). Échap annule.")
    def cancel_add(self) -> None: self.adding, self.new_points, self.preview_point = False, [], None; self.render()
    def finish_add(self) -> None:
        if polygon_area(self.new_points) < 20: self.cancel_add(); return
        self.cases().append({"id": f"case_{page_id(self.current())}_{len(self.cases()) + 1}", "order": len(self.cases()) + 1, "polygon": self.new_points}); self.selected = len(self.cases()) - 1; self.dirty = True; self.cancel_add(); self.refresh_lists(); self.render()
    def delete_case(self) -> None:
        if self.selected is not None and self.selected < len(self.cases()): del self.cases()[self.selected]; self.selected = min(self.selected, len(self.cases()) - 1) if self.cases() else None; self.dirty = True; self.refresh_lists(); self.render()
    def move_case(self, delta: int) -> None:
        if self.selected is None: return
        new = max(0, min(len(self.cases()) - 1, self.selected + delta)); self.cases()[self.selected], self.cases()[new] = self.cases()[new], self.cases()[self.selected]; self.selected = new; self.dirty = True; self.refresh_lists(); self.render()
    def sort_cases(self) -> None: sort_rtl(self.cases()); self.selected = None; self.dirty = True; self.refresh_lists(); self.render()
    def next_empty(self) -> None:
        for offset in range(1, len(self.pages) + 1):
            i = (self.index + offset) % len(self.pages)
            if not self.pages[i].get("cases"): self.load_page(i); return
    def mark_page(self, idx: int, polygons: list[list[float]]) -> None:
        self.pages[idx]["cases"] = [{"id": f"auto_case_{page_id(self.pages[idx])}_{i}", "order": i, "polygon": p} for i, p in enumerate(polygons, 1)]; sort_rtl(self.pages[idx]["cases"]); self.dirty = True

    def log(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log_text.configure(state="normal"); self.log_text.insert("end", f"[{stamp}] {message}\n"); self.log_text.see("end"); self.log_text.configure(state="disabled")

    def load_model(self, model_path: Path | None = None):
        if self.model is not None: return self.model
        model_path = model_path or self.model_path
        if not model_path: raise RuntimeError("Aucun modèle trouvé. Utilisez --model chemin/vers/best.pt.")
        from ultralytics import YOLO
        self.model = YOLO(str(model_path)); return self.model

    def ensure_hf_model(self, report) -> Path:
        if HF_PANEL_MODEL_PATH.exists() and HF_PANEL_MODEL_PATH.stat().st_size > 0:
            report(f"Modèle ONNX trouvé dans le cache : {HF_PANEL_MODEL_PATH}")
            return HF_PANEL_MODEL_PATH
        import requests
        MODEL_CACHE.mkdir(parents=True, exist_ok=True)
        partial = HF_PANEL_MODEL_PATH.with_suffix(".onnx.part")
        report("Téléchargement du modèle ONNX depuis Hugging Face…")
        with requests.get(HF_PANEL_MODEL_URL, stream=True, timeout=60) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0); received = 0; last_report = -1
            with partial.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk: continue
                    handle.write(chunk); received += len(chunk)
                    if total:
                        percent = int(received * 100 / total)
                        if percent >= last_report + 5: report(f"Téléchargement ONNX : {percent}% ({received / 1024 / 1024:.1f} MiB)"); last_report = percent
        partial.replace(HF_PANEL_MODEL_PATH); report(f"Modèle ONNX prêt ({HF_PANEL_MODEL_PATH.stat().st_size / 1024 / 1024:.1f} MiB)")
        return HF_PANEL_MODEL_PATH

    def ensure_latest_remote_model(self, report) -> Path:
        target = MODEL_CACHE / "latest_polygon_seg.pt"
        local_best = LOCAL_TRAINED_MODEL_REPO / "weights" / "best.pt"
        if local_best.exists() and local_best.stat().st_size > 0:
            report(f"Dernier modèle YOLO11-seg trouvé dans le dépôt local : {local_best}")
            return local_best
        if target.exists() and target.stat().st_size > 0:
            report(f"Dernier modèle Hugging Face trouvé dans le cache : {target}")
            return target
        try:
            from huggingface_hub import hf_hub_download
            report(f"Téléchargement authentifié du dernier modèle depuis {LATEST_TRAINED_HF_REPO}…")
            downloaded = hf_hub_download(repo_id=LATEST_TRAINED_HF_REPO, filename="weights/best.pt")
            report(f"Dernier modèle téléchargé : {downloaded}")
            return Path(downloaded)
        except ImportError:
            pass
        import requests
        MODEL_CACHE.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".pt.part")
        report(f"Téléchargement du dernier modèle depuis {LATEST_TRAINED_HF_REPO}…")
        with requests.get(LATEST_TRAINED_HF_URL, stream=True, timeout=120) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0); received = 0; last_report = -1
            with partial.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk: continue
                    handle.write(chunk); received += len(chunk)
                    if total:
                        percent = int(received * 100 / total)
                        if percent >= last_report + 5: report(f"Téléchargement best.pt : {percent}%"); last_report = percent
        partial.replace(target); report(f"Dernier modèle téléchargé : {target}")
        return target

    def detect_all(self, model_source: str = "current") -> None:
        if self.detection_running:
            messagebox.showinfo("Analyse en cours", "Une analyse est déjà en cours.")
            return
        if not messagebox.askyesno("Pré-annotation", "Remplacer les cases existantes par les prédictions du modèle sur toutes les pages ?"): return
        self.start_detection(model_source, list(range(len(self.pages))), f"toutes les pages ({model_source})")

    def detect_current_hf(self) -> None:
        if self.detection_running:
            messagebox.showinfo("Analyse en cours", "Une analyse est déjà en cours.")
            return
        if not messagebox.askyesno("Pré-annotation", "Remplacer les cases de la page courante par les prédictions ONNX ?"): return
        self.start_detection("hf", [self.index], "la page courante (YOLO26 / ONNX)")

    def detect_current_yolo11(self) -> None:
        if self.detection_running:
            messagebox.showinfo("Analyse en cours", "Une analyse est déjà en cours.")
            return
        model_path = discover_latest_trained_model()
        source = "latest" if model_path is not None else "latest_remote"
        location = str(model_path) if model_path is not None else f"le dépôt Hugging Face {LATEST_TRAINED_HF_REPO}"
        if not messagebox.askyesno("Pré-annotation", f"Remplacer les cases de la page courante avec YOLO11-seg ?\n\n{location}"):
            return
        self.latest_detection_path = model_path
        self.start_detection(source, [self.index], "la page courante (YOLO11-seg)")

    def detect_latest_all(self) -> None:
        if self.detection_running:
            messagebox.showinfo("Analyse en cours", "Une analyse est déjà en cours.")
            return
        model_path = discover_latest_trained_model()
        source = "latest" if model_path is not None else "latest_remote"
        location = str(model_path) if model_path is not None else f"le dépôt Hugging Face {LATEST_TRAINED_HF_REPO}"
        if not messagebox.askyesno("Dernier modèle", f"Utiliser ce modèle sur toutes les pages ?\n\n{location}"):
            return
        self.latest_detection_path = model_path
        self.start_detection(source, list(range(len(self.pages))), f"toutes les pages (dernier modèle : {location})")

    def start_detection(self, model_source: str, page_indices: list[int], description: str) -> None:
        self.detection_running = True; self.progress.configure(maximum=len(page_indices), value=0); self.progress_label.set("Préparation…"); self.log(f"Début de l’analyse de {description}")
        threading.Thread(target=self._detect_worker, args=(model_source, page_indices), daemon=True).start(); self.status.set("Détection en cours…")

    def _detect_worker(self, model_source: str, page_indices: list[int]) -> None:
        report = lambda message: self.tasks.put(("log", message))
        try:
            self.model = None
            if model_source == "hf":
                model_path = self.ensure_hf_model(report)
                from ultralytics import YOLO
                report("Chargement du modèle ONNX dans le moteur YOLO…")
                model = YOLO(str(model_path))
            elif model_source == "latest":
                model_path = getattr(self, "latest_detection_path", None) or discover_latest_trained_model()
                if model_path is None:
                    raise RuntimeError("Aucun dernier modèle entraîné disponible.")
                report(f"Chargement du dernier modèle entraîné : {model_path}")
                model = self.load_model(model_path)
            elif model_source == "latest_remote":
                model_path = self.ensure_latest_remote_model(report)
                report(f"Chargement du modèle publié : {model_path}")
                model = self.load_model(model_path)
            else:
                report(f"Chargement du modèle : {self.model_path.name if self.model_path else 'inconnu'}")
                model = self.load_model()
            total = len(page_indices)
            report(f"Modèle chargé. {total} page(s) à analyser.")
            self.tasks.put(("progress", (0, total)))
            for position, i in enumerate(page_indices, 1):
                page = self.pages[i]
                path = image_path_for(page, self.base)
                report(f"Page {position}/{total} (index global {i + 1}) : {path.name}")
                with Image.open(path) as im:
                    width, height = im.size
                    gray_image = im.convert("L")
                result = model.predict(source=str(path), conf=self.confidence, iou=.7, verbose=False)[0]
                polygons: list[list[list[float]]] = []
                masks = getattr(result, "masks", None)
                if masks is not None and getattr(masks, "xy", None) is not None:
                    for contour in masks.xy:
                        polygon = mask_to_quad(contour)
                        if polygon is not None and polygon_area(polygon) >= 64:
                            polygons.append(clamp_polygon(snap_polygon_to_dark(polygon, gray_image), width, height))
                else:
                    boxes = result.boxes.xyxy.cpu().tolist() if result.boxes is not None else []
                    polygons = [
                        clamp_polygon(
                            snap_polygon_to_dark([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], gray_image),
                            width,
                            height,
                        )
                        for b in boxes
                        if b[2] - b[0] > 8 and b[3] - b[1] > 8
                    ]
                report(f"  → {len(polygons)} cases détectées")
                self.tasks.put(("page", (i, polygons)))
                self.tasks.put(("progress", (position, total)))
            self.tasks.put(("done", None))
        except Exception as exc: self.tasks.put(("error", str(exc)))
    def _poll_tasks(self) -> None:
        try:
            while True:
                event, payload = self.tasks.get_nowait()
                if event == "log": self.log(str(payload))
                elif event == "progress":
                    completed, total = payload; self.progress.configure(maximum=total, value=completed); self.progress_label.set(f"Page {completed}/{total}")
                elif event == "page":
                    i, polygons = payload; self.mark_page(i, polygons)
                elif event == "done":
                    self.detection_running = False; self.save(True); self.load_page(self.index, False); self.status.set("Pré-annotation terminée."); self.progress_label.set("Analyse terminée"); self.log("Analyse terminée et annotations enregistrées.")
                elif event == "error":
                    self.detection_running = False; self.progress_label.set("Échec de l’analyse"); self.status.set("Échec de la détection."); self.log(f"ERREUR : {payload}"); messagebox.showerror("Détection", str(payload))
        except queue.Empty: pass
        self.after(100, self._poll_tasks)

    def save(self, silent: bool = False) -> None:
        for page in self.pages:
            for i, c in enumerate(page.get("cases", []), 1): c["order"] = i
        write_json(self.output_path, {"kind": "polygon_case_annotations", "dataset_file": str(self.dataset_path), "saved_at": datetime.now(timezone.utc).isoformat(), "pages": [{"page_id": page_id(p), "image_file": p.get("image_file"), "width": p.get("width"), "height": p.get("height"), "cases": [{"case_id": c["id"], "order": c["order"], "polygon": [[round(p[0], 2), round(p[1], 2)] for p in c["polygon"]]} for c in p.get("cases", [])]} for p in self.pages]}); self.dirty = False
        if not silent: self.status.set(f"Annotations enregistrées : {self.output_path}")

    def export_yolo(self) -> None:
        self.save(True)
        selected_dir = filedialog.askdirectory(title="Dossier d’export YOLO polygonal", initialdir=str(DEFAULT_EXPORT.parent))
        if not selected_dir:
            return
        out = Path(selected_dir)
        for split in ("train", "val"): (out / split / "images").mkdir(parents=True, exist_ok=True); (out / split / "labels").mkdir(parents=True, exist_ok=True)
        usable = [p for p in self.pages if p.get("cases") and image_path_for(p, self.base).exists()]; cut = max(1, int(round(len(usable) * .8))) if usable else 0
        for i, page in enumerate(usable):
            split = "train" if i < cut else "val"; src = image_path_for(page, self.base); name = f"page_{page_id(page)}{src.suffix.lower()}"; shutil.copy2(src, out / split / "images" / name); w, h = number(page.get("width")), number(page.get("height")); lines = []
            for c in page["cases"]:
                p = clamp_polygon(c["polygon"], int(w), int(h)); lines.append("0 " + " ".join(f"{x / w:.6f} {y / h:.6f}" for x, y in p))
            (out / split / "labels" / f"page_{page_id(page)}.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (out / "data.yaml").write_text(f"path: {out.as_posix()}\ntrain: train/images\nval: val/images\nnames:\n  0: case\n", encoding="utf-8"); messagebox.showinfo("Export terminé", f"Dataset YOLO polygonal créé dans :\n{out}")
    def close(self) -> None:
        if self.dirty and messagebox.askyesno("Quitter", "Enregistrer les modifications ?"): self.save(True)
        self.destroy()


def main() -> None:
    parser = argparse.ArgumentParser(description="Annotateur Tkinter de cases manga en quadrilatères pour YOLO segmentation.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET, help="dataset.json contenant pages et image_file")
    parser.add_argument("--output", type=Path, default=DEFAULT_ANNOTATIONS)
    parser.add_argument("--model", type=Path, default=None, help="best.pt du détecteur de cases actuel")
    parser.add_argument("--conf", type=float, default=.25)
    parser.add_argument("--sync", action="store_true", help="Synchronise Supabase/R2 avant d’ouvrir l’interface")
    parser.add_argument("--limit", type=int, default=None, help="Limite de pages lors de la synchronisation")
    parser.add_argument("--force-sync", action="store_true", help="Retélécharge les images déjà présentes")
    args = parser.parse_args()
    if args.sync or not args.dataset.exists():
        from sync_r2 import sync_dataset
        print("Synchronisation Supabase/R2…", flush=True)
        args.dataset = sync_dataset(args.dataset.parent, limit=args.limit, force=args.force_sync)
    model = discover_model(args.model); app = App(args.dataset, args.output, model, args.conf); app.mainloop()


if __name__ == "__main__": main()
