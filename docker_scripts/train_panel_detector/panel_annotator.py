from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tkinter as tk
from tkinter import messagebox, ttk

from PIL import Image, ImageTk

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pass


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATASET_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "dataset.json"
DEFAULT_OUTPUT_PATH = SCRIPT_DIR / "panel_annotation_dataset" / "panel_annotations.json"
RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    tmp_path.replace(path)


def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def page_id(page: dict[str, Any]) -> int:
    return to_int(page.get("page_id", page.get("id")))


def bbox_from_item(item: dict[str, Any]) -> dict[str, int]:
    bbox = item.get("bbox") if isinstance(item.get("bbox"), dict) else item
    return {
        "x": to_int(bbox.get("x")),
        "y": to_int(bbox.get("y")),
        "w": max(1, to_int(bbox.get("w"), 1)),
        "h": max(1, to_int(bbox.get("h"), 1)),
    }


def clamp_bbox(bbox: dict[str, int], width: int, height: int) -> dict[str, int]:
    x1 = max(0, min(width, bbox["x"]))
    y1 = max(0, min(height, bbox["y"]))
    x2 = max(0, min(width, bbox["x"] + bbox["w"]))
    y2 = max(0, min(height, bbox["y"] + bbox["h"]))
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    return {"x": x1, "y": y1, "w": max(1, x2 - x1), "h": max(1, y2 - y1)}


def rect_from_points(
    x1: float, y1: float, x2: float, y2: float, width: int, height: int
) -> dict[str, int]:
    left = max(0, min(width, int(round(min(x1, x2)))))
    top = max(0, min(height, int(round(min(y1, y2)))))
    right = max(0, min(width, int(round(max(x1, x2)))))
    bottom = max(0, min(height, int(round(max(y1, y2)))))
    return {"x": left, "y": top, "w": max(0, right - left), "h": max(0, bottom - top)}


def rect_area(bbox: dict[str, int]) -> int:
    return max(0, bbox["w"]) * max(0, bbox["h"])


def intersection_area(a: dict[str, int], b: dict[str, int]) -> int:
    left = max(a["x"], b["x"])
    top = max(a["y"], b["y"])
    right = min(a["x"] + a["w"], b["x"] + b["w"])
    bottom = min(a["y"] + a["h"], b["y"] + b["h"])
    return max(0, right - left) * max(0, bottom - top)


def contains_point(bbox: dict[str, int], x: float, y: float) -> bool:
    return bbox["x"] <= x <= bbox["x"] + bbox["w"] and bbox["y"] <= y <= bbox["y"] + bbox["h"]


def bubble_is_inside_case(
    bubble: dict[str, Any], case_bbox: dict[str, int], min_overlap: float = 0.60
) -> bool:
    bubble_bbox = bbox_from_item(bubble)
    center_x = bubble_bbox["x"] + bubble_bbox["w"] / 2
    center_y = bubble_bbox["y"] + bubble_bbox["h"] / 2
    if contains_point(case_bbox, center_x, center_y):
        return True
    area = rect_area(bubble_bbox)
    if area <= 0:
        return False
    return intersection_area(bubble_bbox, case_bbox) / area >= min_overlap


def bubble_sort_key(bubble: dict[str, Any]) -> tuple[int, int, int]:
    order = bubble.get("order")
    if order is None:
        return (1, 10**9, to_int(bubble.get("id")))
    return (0, to_int(order), to_int(bubble.get("id")))


class PanelAnnotator(tk.Tk):
    def __init__(self, dataset_path: Path, output_path: Path) -> None:
        super().__init__()
        self.dataset_path = dataset_path.resolve()
        self.dataset_dir = self.dataset_path.parent
        self.output_path = output_path.resolve()

        self.dataset = read_json(self.dataset_path)
        self.pages: list[dict[str, Any]] = self.dataset.get("pages") or []
        if not self.pages:
            raise ValueError("Dataset has no pages.")

        self.current_index = -1
        self.current_image: Image.Image | None = None
        self.photo_image: ImageTk.PhotoImage | None = None
        self.scale = 1.0
        self.selected_case_index: int | None = None
        self.selected_bubble_id: int | None = None
        self.drag_start: tuple[float, float] | None = None
        self.temp_rect_id: int | None = None
        self.dirty = False
        self.syncing_page_list = False

        self.title("Panel annotator")
        self.geometry("1500x950")
        self.minsize(1000, 700)

        self._load_existing_annotations()
        self._build_ui()
        self._bind_events()
        self.refresh_page_list()
        self.load_page(0, autosave=False)

    def _build_ui(self) -> None:
        self.rowconfigure(1, weight=1)
        self.columnconfigure(0, weight=1)

        toolbar = ttk.Frame(self, padding=(8, 6))
        toolbar.grid(row=0, column=0, sticky="ew")

        ttk.Button(toolbar, text="Prev", command=self.previous_page).pack(side=tk.LEFT)
        ttk.Button(toolbar, text="Next", command=self.next_page).pack(side=tk.LEFT, padx=(4, 0))
        ttk.Button(toolbar, text="Next empty", command=self.next_unannotated_page).pack(
            side=tk.LEFT, padx=(4, 12)
        )
        ttk.Button(toolbar, text="-", width=3, command=lambda: self.zoom_by(0.85)).pack(
            side=tk.LEFT
        )
        ttk.Button(toolbar, text="Fit", command=self.fit_to_window).pack(side=tk.LEFT, padx=4)
        ttk.Button(toolbar, text="+", width=3, command=lambda: self.zoom_by(1.18)).pack(
            side=tk.LEFT
        )
        ttk.Button(toolbar, text="Save", command=lambda: self.save_annotations(False)).pack(
            side=tk.RIGHT
        )
        self.page_label_var = tk.StringVar(value="")
        ttk.Label(toolbar, textvariable=self.page_label_var).pack(side=tk.LEFT, padx=12)

        main = ttk.Frame(self)
        main.grid(row=1, column=0, sticky="nsew")
        main.rowconfigure(0, weight=1)
        main.columnconfigure(0, weight=1)

        canvas_frame = ttk.Frame(main)
        canvas_frame.grid(row=0, column=0, sticky="nsew")
        canvas_frame.rowconfigure(0, weight=1)
        canvas_frame.columnconfigure(0, weight=1)

        self.canvas = tk.Canvas(
            canvas_frame,
            bg="#202124",
            highlightthickness=0,
            cursor="crosshair",
        )
        self.canvas.grid(row=0, column=0, sticky="nsew")

        y_scroll = ttk.Scrollbar(canvas_frame, orient=tk.VERTICAL, command=self.canvas.yview)
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll = ttk.Scrollbar(canvas_frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        x_scroll.grid(row=1, column=0, sticky="ew")
        self.canvas.configure(xscrollcommand=x_scroll.set, yscrollcommand=y_scroll.set)

        side = ttk.Frame(main, padding=(8, 0, 8, 0), width=380)
        side.grid(row=0, column=1, sticky="ns")
        side.grid_propagate(False)

        ttk.Label(side, text="Pages").pack(anchor="w")
        page_frame = ttk.Frame(side)
        page_frame.pack(fill=tk.BOTH, expand=False, pady=(2, 8))
        page_frame.columnconfigure(0, weight=1)
        self.page_listbox = tk.Listbox(page_frame, height=8, exportselection=False)
        self.page_listbox.grid(row=0, column=0, sticky="ew")
        page_scroll = ttk.Scrollbar(page_frame, orient=tk.VERTICAL, command=self.page_listbox.yview)
        page_scroll.grid(row=0, column=1, sticky="ns")
        self.page_listbox.configure(yscrollcommand=page_scroll.set)
        self.page_listbox.bind("<<ListboxSelect>>", self.on_page_list_select)

        ttk.Label(side, text="Cases").pack(anchor="w")
        case_frame = ttk.Frame(side)
        case_frame.pack(fill=tk.BOTH, expand=False, pady=(2, 4))
        case_frame.columnconfigure(0, weight=1)
        self.case_listbox = tk.Listbox(case_frame, height=9, exportselection=False)
        self.case_listbox.grid(row=0, column=0, sticky="ew")
        case_scroll = ttk.Scrollbar(case_frame, orient=tk.VERTICAL, command=self.case_listbox.yview)
        case_scroll.grid(row=0, column=1, sticky="ns")
        self.case_listbox.configure(yscrollcommand=case_scroll.set)
        self.case_listbox.bind("<<ListboxSelect>>", self.on_case_list_select)

        case_buttons = ttk.Frame(side)
        case_buttons.pack(fill=tk.X, pady=(0, 8))
        ttk.Button(case_buttons, text="Up", command=lambda: self.move_selected_case(-1)).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        ttk.Button(case_buttons, text="Down", command=lambda: self.move_selected_case(1)).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=4
        )
        ttk.Button(case_buttons, text="Delete", command=self.delete_selected_case).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )

        case_buttons_2 = ttk.Frame(side)
        case_buttons_2.pack(fill=tk.X, pady=(0, 10))
        ttk.Button(case_buttons_2, text="Sort RTL", command=self.sort_cases_rtl).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        ttk.Button(case_buttons_2, text="Auto case", command=self.auto_assign_selected_case).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=4
        )
        ttk.Button(case_buttons_2, text="Auto page", command=self.auto_assign_page).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )

        ttk.Label(side, text="Bulles").pack(anchor="w")
        bubble_frame = ttk.Frame(side)
        bubble_frame.pack(fill=tk.BOTH, expand=True, pady=(2, 4))
        bubble_frame.rowconfigure(0, weight=1)
        bubble_frame.columnconfigure(0, weight=1)
        self.bubble_listbox = tk.Listbox(bubble_frame, exportselection=False)
        self.bubble_listbox.grid(row=0, column=0, sticky="nsew")
        bubble_scroll = ttk.Scrollbar(
            bubble_frame, orient=tk.VERTICAL, command=self.bubble_listbox.yview
        )
        bubble_scroll.grid(row=0, column=1, sticky="ns")
        self.bubble_listbox.configure(yscrollcommand=bubble_scroll.set)
        self.bubble_listbox.bind("<<ListboxSelect>>", self.on_bubble_list_select)
        self.bubble_listbox.bind("<Double-Button-1>", lambda _event: self.assign_selected_bubble())

        bubble_buttons = ttk.Frame(side)
        bubble_buttons.pack(fill=tk.X)
        ttk.Button(bubble_buttons, text="Assign", command=self.assign_selected_bubble).pack(
            side=tk.LEFT, fill=tk.X, expand=True
        )
        ttk.Button(bubble_buttons, text="Unassign", command=self.unassign_selected_bubble).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=(4, 0)
        )

        self.status_var = tk.StringVar(value="")
        ttk.Label(self, textvariable=self.status_var, anchor="w", padding=(8, 4)).grid(
            row=2, column=0, sticky="ew"
        )

    def _bind_events(self) -> None:
        self.canvas.bind("<ButtonPress-1>", self.on_canvas_mouse_down)
        self.canvas.bind("<B1-Motion>", self.on_canvas_mouse_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_canvas_mouse_up)
        self.canvas.bind("<MouseWheel>", self.on_mouse_wheel)
        self.bind("<Control-s>", lambda _event: self.save_annotations(False))
        self.bind("<Left>", lambda _event: self.previous_page())
        self.bind("<Right>", lambda _event: self.next_page())
        self.bind("<Delete>", lambda _event: self.delete_selected_case())
        self.bind("<Escape>", lambda _event: self.cancel_temp_rect())
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    def _load_existing_annotations(self) -> None:
        for page in self.pages:
            page["bubbles"] = sorted(page.get("bubbles") or [], key=bubble_sort_key)
            page["cases"] = []

        if not self.output_path.exists():
            return

        data = read_json(self.output_path)
        annotations_by_page = {
            to_int(item.get("page_id")): item for item in data.get("pages", [])
        }
        for page in self.pages:
            stored = annotations_by_page.get(page_id(page))
            if not stored:
                continue
            cases = []
            for index, raw_case in enumerate(stored.get("cases") or [], start=1):
                bbox = bbox_from_item(raw_case)
                bubble_ids = raw_case.get("bubble_ids")
                if bubble_ids is None:
                    bubble_ids = [b.get("id") for b in raw_case.get("bubbles", [])]
                cases.append(
                    {
                        "id": raw_case.get("case_id") or raw_case.get("id") or f"case_{index}",
                        "order": to_int(raw_case.get("order"), index),
                        "bbox": clamp_bbox(
                            bbox,
                            to_int(page.get("width"), 10**9),
                            to_int(page.get("height"), 10**9),
                        ),
                        "bubble_ids": [to_int(bid) for bid in bubble_ids if bid is not None],
                    }
                )
            page["cases"] = sorted(cases, key=lambda case: case.get("order", 10**9))
            self.normalize_page_cases(page)

    def current_page(self) -> dict[str, Any]:
        return self.pages[self.current_index]

    def current_cases(self) -> list[dict[str, Any]]:
        return self.current_page().setdefault("cases", [])

    def current_bubbles(self) -> list[dict[str, Any]]:
        return self.current_page().get("bubbles") or []

    def normalize_page_cases(self, page: dict[str, Any]) -> None:
        valid_bubble_ids = {to_int(b.get("id")) for b in page.get("bubbles") or []}
        seen: set[int] = set()
        normalized_cases = []
        width = to_int(page.get("width"), 10**9)
        height = to_int(page.get("height"), 10**9)

        for index, case in enumerate(page.get("cases") or [], start=1):
            bbox = clamp_bbox(bbox_from_item(case), width, height)
            if bbox["w"] <= 0 or bbox["h"] <= 0:
                continue
            bubble_ids = []
            for bubble_id in case.get("bubble_ids") or []:
                bid = to_int(bubble_id)
                if bid in valid_bubble_ids and bid not in seen:
                    bubble_ids.append(bid)
                    seen.add(bid)
            normalized_cases.append(
                {
                    "id": case.get("id") or case.get("case_id") or f"case_{index}",
                    "order": index,
                    "bbox": bbox,
                    "bubble_ids": bubble_ids,
                }
            )
        page["cases"] = normalized_cases
        self.update_case_orders(page)

    def update_case_orders(self, page: dict[str, Any] | None = None) -> None:
        if page is None:
            page = self.current_page()
        for index, case in enumerate(page.get("cases") or [], start=1):
            case["order"] = index
            if not case.get("id"):
                case["id"] = f"case_{index}"

    def refresh_page_list(self) -> None:
        self.syncing_page_list = True
        try:
            self.page_listbox.delete(0, tk.END)
            for index, page in enumerate(self.pages):
                cases = page.get("cases") or []
                marker = "*" if cases else " "
                label = self.format_page_list_label(index, page, marker)
                self.page_listbox.insert(tk.END, label)
            if 0 <= self.current_index < len(self.pages):
                self.page_listbox.selection_clear(0, tk.END)
                self.page_listbox.selection_set(self.current_index)
                self.page_listbox.see(self.current_index)
        finally:
            self.syncing_page_list = False

    def format_page_list_label(self, index: int, page: dict[str, Any], marker: str) -> str:
        manga = page.get("manga") or {}
        tome = page.get("tome") or {}
        chapitre = page.get("chapitre") or {}
        slug = manga.get("slug") or "-"
        tome_number = tome.get("numero")
        chapter_number = chapitre.get("numero")
        page_number = page.get("numero_page")
        meta = f"{slug} T{tome_number or '-'} C{chapter_number or '-'} P{page_number or '-'}"
        return f"{marker} {index + 1:04d} id:{page_id(page)} {meta}"

    def load_page(self, index: int, autosave: bool = True) -> None:
        if index < 0 or index >= len(self.pages):
            return
        if autosave and self.dirty:
            self.save_annotations(silent=True)

        self.current_index = index
        page = self.current_page()
        image_path = self.dataset_dir / page["image_file"]
        if not image_path.exists():
            messagebox.showerror("Missing image", f"Image not found:\n{image_path}")
            return

        with Image.open(image_path) as image:
            self.current_image = image.convert("RGB")
        page["width"], page["height"] = self.current_image.size
        self.normalize_page_cases(page)
        self.selected_case_index = None
        self.selected_bubble_id = None
        self.fit_to_window(render=False)
        self.refresh_page_list()
        self.refresh_side_lists()
        self.render()
        self.update_status()

    def previous_page(self) -> None:
        self.load_page(max(0, self.current_index - 1))

    def next_page(self) -> None:
        self.load_page(min(len(self.pages) - 1, self.current_index + 1))

    def next_unannotated_page(self) -> None:
        start = self.current_index + 1
        for index in range(start, len(self.pages)):
            if not self.pages[index].get("cases"):
                self.load_page(index)
                return
        for index in range(0, start):
            if not self.pages[index].get("cases"):
                self.load_page(index)
                return

    def on_page_list_select(self, _event: tk.Event) -> None:
        if self.syncing_page_list:
            return
        selection = self.page_listbox.curselection()
        if not selection:
            return
        index = int(selection[0])
        if index != self.current_index:
            self.load_page(index)

    def fit_to_window(self, render: bool = True) -> None:
        if self.current_image is None:
            return
        self.update_idletasks()
        canvas_width = max(100, self.canvas.winfo_width() - 24)
        canvas_height = max(100, self.canvas.winfo_height() - 24)
        image_width, image_height = self.current_image.size
        self.scale = max(
            0.05,
            min(canvas_width / image_width, canvas_height / image_height, 1.0),
        )
        if render:
            self.render()

    def zoom_by(self, factor: float) -> None:
        if self.current_image is None:
            return
        self.scale = max(0.05, min(5.0, self.scale * factor))
        self.render()

    def render(self) -> None:
        self.canvas.delete("all")
        if self.current_image is None:
            return

        image_width, image_height = self.current_image.size
        display_size = (
            max(1, int(round(image_width * self.scale))),
            max(1, int(round(image_height * self.scale))),
        )
        display_image = self.current_image.resize(display_size, RESAMPLE)
        self.photo_image = ImageTk.PhotoImage(display_image)
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.photo_image)
        self.canvas.configure(scrollregion=(0, 0, display_size[0], display_size[1]))
        self.draw_overlays()

    def draw_overlays(self) -> None:
        page = self.current_page()
        assigned_bubbles = self.assigned_bubble_map(page)

        for bubble in self.current_bubbles():
            bbox = bbox_from_item(bubble)
            sx1, sy1, sx2, sy2 = self.scale_bbox(bbox)
            bid = to_int(bubble.get("id"))
            assigned = bid in assigned_bubbles
            color = "#27c46b" if assigned else "#00a7ff"
            self.canvas.create_rectangle(sx1, sy1, sx2, sy2, outline=color, width=2)
            order = bubble.get("order")
            label = str(order) if order is not None else f"b{bid}"
            self.draw_label(sx1, sy1, label, fill="#071b2c", text_fill="#ffffff")

        for index, case in enumerate(self.current_cases()):
            bbox = bbox_from_item(case)
            sx1, sy1, sx2, sy2 = self.scale_bbox(bbox)
            selected = index == self.selected_case_index
            color = "#ff3b30" if selected else "#ffb000"
            width = 4 if selected else 3
            self.canvas.create_rectangle(sx1, sy1, sx2, sy2, outline=color, width=width)
            label = f"C{case['order']} ({len(case.get('bubble_ids') or [])})"
            self.draw_label(sx1, sy1 - 18, label, fill=color, text_fill="#111111")

    def draw_label(
        self,
        x: float,
        y: float,
        text: str,
        fill: str,
        text_fill: str,
    ) -> None:
        y = max(0, y)
        text_id = self.canvas.create_text(
            x + 4,
            y + 3,
            anchor=tk.NW,
            text=text,
            fill=text_fill,
            font=("TkDefaultFont", 9, "bold"),
        )
        bbox = self.canvas.bbox(text_id)
        if bbox is not None:
            rect_id = self.canvas.create_rectangle(
                bbox[0] - 3,
                bbox[1] - 2,
                bbox[2] + 3,
                bbox[3] + 2,
                fill=fill,
                outline=fill,
            )
            self.canvas.tag_raise(text_id, rect_id)

    def scale_bbox(self, bbox: dict[str, int]) -> tuple[float, float, float, float]:
        return (
            bbox["x"] * self.scale,
            bbox["y"] * self.scale,
            (bbox["x"] + bbox["w"]) * self.scale,
            (bbox["y"] + bbox["h"]) * self.scale,
        )

    def canvas_to_image(self, canvas_x: float, canvas_y: float) -> tuple[float, float]:
        x = self.canvas.canvasx(canvas_x) / self.scale
        y = self.canvas.canvasy(canvas_y) / self.scale
        if self.current_image is None:
            return x, y
        width, height = self.current_image.size
        return max(0, min(width, x)), max(0, min(height, y))

    def on_canvas_mouse_down(self, event: tk.Event) -> None:
        if self.current_image is None:
            return
        self.canvas.focus_set()
        self.drag_start = self.canvas_to_image(event.x, event.y)
        self.cancel_temp_rect()

    def on_canvas_mouse_drag(self, event: tk.Event) -> None:
        if self.drag_start is None or self.current_image is None:
            return
        start_x, start_y = self.drag_start
        end_x, end_y = self.canvas_to_image(event.x, event.y)
        sx1, sy1 = start_x * self.scale, start_y * self.scale
        sx2, sy2 = end_x * self.scale, end_y * self.scale
        if self.temp_rect_id is None:
            self.temp_rect_id = self.canvas.create_rectangle(
                sx1,
                sy1,
                sx2,
                sy2,
                outline="#ff3b30",
                width=2,
                dash=(6, 4),
            )
        else:
            self.canvas.coords(self.temp_rect_id, sx1, sy1, sx2, sy2)

    def on_canvas_mouse_up(self, event: tk.Event) -> None:
        if self.drag_start is None or self.current_image is None:
            return
        start_x, start_y = self.drag_start
        end_x, end_y = self.canvas_to_image(event.x, event.y)
        self.drag_start = None
        self.cancel_temp_rect()

        distance = math.hypot((end_x - start_x) * self.scale, (end_y - start_y) * self.scale)
        if distance < 6:
            self.select_at_point(end_x, end_y)
            return

        image_width, image_height = self.current_image.size
        bbox = rect_from_points(start_x, start_y, end_x, end_y, image_width, image_height)
        if bbox["w"] < 8 or bbox["h"] < 8:
            return
        self.add_case(bbox)

    def cancel_temp_rect(self) -> None:
        if self.temp_rect_id is not None:
            self.canvas.delete(self.temp_rect_id)
            self.temp_rect_id = None

    def select_at_point(self, x: float, y: float) -> None:
        candidates = []
        for index, case in enumerate(self.current_cases()):
            bbox = bbox_from_item(case)
            if contains_point(bbox, x, y):
                candidates.append((rect_area(bbox), index))
        if candidates:
            _, index = min(candidates)
            self.select_case(index)
            return

        for index, bubble in enumerate(self.current_bubbles()):
            if contains_point(bbox_from_item(bubble), x, y):
                self.selected_bubble_id = to_int(bubble.get("id"))
                self.refresh_side_lists()
                self.render()
                return

        self.selected_case_index = None
        self.selected_bubble_id = None
        self.refresh_side_lists()
        self.render()

    def add_case(self, bbox: dict[str, int]) -> None:
        cases = self.current_cases()
        next_id = self.next_case_id()
        case = {
            "id": next_id,
            "order": len(cases) + 1,
            "bbox": bbox,
            "bubble_ids": [],
        }
        cases.append(case)
        self.selected_case_index = len(cases) - 1
        self.auto_assign_case(case, only_unassigned=True)
        self.mark_dirty()

    def next_case_id(self) -> str:
        existing = {case.get("id") for page in self.pages for case in page.get("cases", [])}
        counter = 1
        while f"case_{counter}" in existing:
            counter += 1
        return f"case_{counter}"

    def on_case_list_select(self, _event: tk.Event) -> None:
        selection = self.case_listbox.curselection()
        if selection:
            self.select_case(int(selection[0]), refresh=False)
            self.render()

    def select_case(self, index: int, refresh: bool = True) -> None:
        if index < 0 or index >= len(self.current_cases()):
            return
        self.selected_case_index = index
        if refresh:
            self.refresh_side_lists()
            self.render()

    def on_bubble_list_select(self, _event: tk.Event) -> None:
        selection = self.bubble_listbox.curselection()
        if not selection:
            return
        bubble = self.current_bubbles()[int(selection[0])]
        self.selected_bubble_id = to_int(bubble.get("id"))
        self.render()

    def refresh_side_lists(self) -> None:
        self.refresh_case_list()
        self.refresh_bubble_list()
        self.update_status()

    def refresh_case_list(self) -> None:
        self.case_listbox.delete(0, tk.END)
        for case in self.current_cases():
            bbox = bbox_from_item(case)
            text = (
                f"C{case['order']:02d} "
                f"b:{len(case.get('bubble_ids') or []):02d} "
                f"x:{bbox['x']} y:{bbox['y']} w:{bbox['w']} h:{bbox['h']}"
            )
            self.case_listbox.insert(tk.END, text)
        if self.selected_case_index is not None and self.selected_case_index < len(self.current_cases()):
            self.case_listbox.selection_set(self.selected_case_index)
            self.case_listbox.see(self.selected_case_index)

    def refresh_bubble_list(self) -> None:
        self.bubble_listbox.delete(0, tk.END)
        assigned = self.assigned_bubble_map(self.current_page())
        for bubble in self.current_bubbles():
            bid = to_int(bubble.get("id"))
            assigned_case = assigned.get(bid)
            assigned_label = f"C{assigned_case}" if assigned_case else "-"
            order = bubble.get("order")
            order_label = f"{to_int(order):03d}" if order is not None else "---"
            text = " ".join(str(bubble.get("text") or "").split())
            if len(text) > 44:
                text = text[:41] + "..."
            self.bubble_listbox.insert(
                tk.END,
                f"{order_label} b{bid} -> {assigned_label} {text}",
            )
            if self.selected_bubble_id == bid:
                last_index = self.bubble_listbox.size() - 1
                self.bubble_listbox.selection_set(last_index)
                self.bubble_listbox.see(last_index)

    def assigned_bubble_map(self, page: dict[str, Any]) -> dict[int, int]:
        assigned: dict[int, int] = {}
        for case in page.get("cases") or []:
            for bubble_id in case.get("bubble_ids") or []:
                assigned[to_int(bubble_id)] = to_int(case.get("order"))
        return assigned

    def assigned_bubble_ids(self) -> set[int]:
        return set(self.assigned_bubble_map(self.current_page()).keys())

    def auto_assign_case(self, case: dict[str, Any], only_unassigned: bool) -> None:
        assigned = self.assigned_bubble_ids() if only_unassigned else set()
        target_bbox = bbox_from_item(case)
        for bubble in self.current_bubbles():
            bid = to_int(bubble.get("id"))
            if bid in assigned:
                continue
            if bubble_is_inside_case(bubble, target_bbox):
                self.assign_bubble_to_case(bid, case, refresh=False)
        self.sort_case_bubbles(case)

    def auto_assign_selected_case(self) -> None:
        if self.selected_case_index is None:
            return
        case = self.current_cases()[self.selected_case_index]
        self.auto_assign_case(case, only_unassigned=True)
        self.mark_dirty()

    def auto_assign_page(self) -> None:
        cases = self.current_cases()
        if not cases:
            return
        for case in cases:
            case["bubble_ids"] = []
        for bubble in self.current_bubbles():
            bid = to_int(bubble.get("id"))
            candidates = []
            for index, case in enumerate(cases):
                bbox = bbox_from_item(case)
                if bubble_is_inside_case(bubble, bbox):
                    candidates.append((rect_area(bbox), index, case))
            if candidates:
                _, _, best_case = min(candidates)
                best_case.setdefault("bubble_ids", []).append(bid)
        for case in cases:
            self.sort_case_bubbles(case)
        self.mark_dirty()

    def assign_selected_bubble(self) -> None:
        if self.selected_case_index is None or self.selected_bubble_id is None:
            return
        case = self.current_cases()[self.selected_case_index]
        self.assign_bubble_to_case(self.selected_bubble_id, case)
        self.mark_dirty()

    def unassign_selected_bubble(self) -> None:
        if self.selected_bubble_id is None:
            return
        self.remove_bubble_from_cases(self.selected_bubble_id)
        self.mark_dirty()

    def assign_bubble_to_case(
        self,
        bubble_id: int,
        target_case: dict[str, Any],
        refresh: bool = True,
    ) -> None:
        self.remove_bubble_from_cases(bubble_id, refresh=False)
        target_case.setdefault("bubble_ids", []).append(bubble_id)
        self.sort_case_bubbles(target_case)
        if refresh:
            self.refresh_side_lists()
            self.render()

    def remove_bubble_from_cases(self, bubble_id: int, refresh: bool = True) -> None:
        for case in self.current_cases():
            case["bubble_ids"] = [
                bid for bid in case.get("bubble_ids", []) if to_int(bid) != bubble_id
            ]
        if refresh:
            self.refresh_side_lists()
            self.render()

    def sort_case_bubbles(self, case: dict[str, Any]) -> None:
        bubble_by_id = {to_int(b.get("id")): b for b in self.current_bubbles()}
        unique_ids = []
        seen: set[int] = set()
        for bubble_id in case.get("bubble_ids") or []:
            bid = to_int(bubble_id)
            if bid in bubble_by_id and bid not in seen:
                unique_ids.append(bid)
                seen.add(bid)
        unique_ids.sort(key=lambda bid: bubble_sort_key(bubble_by_id[bid]))
        case["bubble_ids"] = unique_ids

    def move_selected_case(self, delta: int) -> None:
        if self.selected_case_index is None:
            return
        cases = self.current_cases()
        old = self.selected_case_index
        new = max(0, min(len(cases) - 1, old + delta))
        if old == new:
            return
        cases[old], cases[new] = cases[new], cases[old]
        self.selected_case_index = new
        self.update_case_orders()
        self.mark_dirty()

    def delete_selected_case(self) -> None:
        if self.selected_case_index is None:
            return
        cases = self.current_cases()
        if self.selected_case_index >= len(cases):
            return
        del cases[self.selected_case_index]
        if not cases:
            self.selected_case_index = None
        else:
            self.selected_case_index = min(self.selected_case_index, len(cases) - 1)
        self.update_case_orders()
        self.mark_dirty()

    def sort_cases_rtl(self) -> None:
        cases = self.current_cases()
        if not cases:
            return
        heights = sorted(bbox_from_item(case)["h"] for case in cases)
        median_height = heights[len(heights) // 2]
        row_band = max(40, int(median_height * 0.6))

        def key(case: dict[str, Any]) -> tuple[int, int]:
            bbox = bbox_from_item(case)
            center_y = bbox["y"] + bbox["h"] / 2
            center_x = bbox["x"] + bbox["w"] / 2
            return (int(center_y // row_band), -int(center_x))

        cases.sort(key=key)
        self.selected_case_index = None
        self.update_case_orders()
        self.mark_dirty()

    def mark_dirty(self) -> None:
        self.dirty = True
        self.refresh_page_list()
        self.refresh_side_lists()
        self.render()

    def update_status(self) -> None:
        if self.current_index < 0:
            return
        page = self.current_page()
        cases = page.get("cases") or []
        bubble_count = len(page.get("bubbles") or [])
        assigned_count = len(self.assigned_bubble_map(page))
        self.page_label_var.set(
            f"Page {self.current_index + 1}/{len(self.pages)} - id {page_id(page)}"
        )
        self.status_var.set(
            f"Cases: {len(cases)} | Bulles: {assigned_count}/{bubble_count} assigned | "
            f"Output: {self.output_path}"
        )

    def on_mouse_wheel(self, event: tk.Event) -> None:
        if event.state & 0x0004:
            self.zoom_by(1.10 if event.delta > 0 else 0.90)
            return
        self.canvas.yview_scroll(-1 * int(event.delta / 120), "units")

    def build_output_data(self) -> dict[str, Any]:
        output_pages = []
        for page in self.pages:
            self.normalize_page_cases(page)
            bubble_by_id = {to_int(b.get("id")): b for b in page.get("bubbles") or []}
            assigned_ids: set[int] = set()
            output_cases = []

            for index, case in enumerate(page.get("cases") or [], start=1):
                case["order"] = index
                bubble_ids = [
                    bid
                    for bid in case.get("bubble_ids") or []
                    if to_int(bid) in bubble_by_id and to_int(bid) not in assigned_ids
                ]
                bubble_ids = [to_int(bid) for bid in bubble_ids]
                bubble_ids.sort(key=lambda bid: bubble_sort_key(bubble_by_id[bid]))
                assigned_ids.update(bubble_ids)

                output_cases.append(
                    {
                        "case_id": case.get("id") or f"case_{index}",
                        "order": index,
                        "bbox": bbox_from_item(case),
                        "bubble_ids": bubble_ids,
                        "bubbles": [self.output_bubble(bubble_by_id[bid]) for bid in bubble_ids],
                    }
                )

            all_bubble_ids = {to_int(b.get("id")) for b in page.get("bubbles") or []}
            output_pages.append(
                {
                    "page_id": page_id(page),
                    "image_file": page.get("image_file"),
                    "width": page.get("width"),
                    "height": page.get("height"),
                    "numero_page": page.get("numero_page"),
                    "chapitre": page.get("chapitre"),
                    "tome": page.get("tome"),
                    "manga": page.get("manga"),
                    "cases": output_cases,
                    "unassigned_bubble_ids": sorted(all_bubble_ids - assigned_ids),
                }
            )

        return {
            "version": 1,
            "kind": "panel_case_annotations",
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "dataset_file": str(self.dataset_path),
            "page_count": len(output_pages),
            "pages": output_pages,
        }

    def output_bubble(self, bubble: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": to_int(bubble.get("id")),
            "order": bubble.get("order"),
            "bbox": bbox_from_item(bubble),
            "text": bubble.get("text"),
        }

    def save_annotations(self, silent: bool = False) -> None:
        data = self.build_output_data()
        write_json(self.output_path, data)
        self.dirty = False
        self.refresh_page_list()
        self.update_status()
        if not silent:
            messagebox.showinfo("Saved", f"Annotations saved:\n{self.output_path}")

    def on_close(self) -> None:
        if self.dirty:
            self.save_annotations(silent=True)
        self.destroy()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Annotate manga panels around bubbles.")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=DEFAULT_DATASET_PATH,
        help=f"Dataset JSON produced by download_panel_annotation_dataset.py. Default: {DEFAULT_DATASET_PATH}",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help=f"Output annotation JSON. Default: {DEFAULT_OUTPUT_PATH}",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset_path = args.dataset.resolve()
    if not dataset_path.exists():
        raise SystemExit(f"Dataset file not found: {dataset_path}")

    app = PanelAnnotator(dataset_path=dataset_path, output_path=args.output)
    app.mainloop()


if __name__ == "__main__":
    main()
