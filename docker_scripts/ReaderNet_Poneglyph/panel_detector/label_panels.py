import json
from pathlib import Path
from PIL import Image, ImageTk
import numpy as np
import tkinter as tk
from tkinter import ttk, messagebox

SCRIPT_DIR = Path(__file__).resolve().parent
DATASET_DIR = SCRIPT_DIR / "dataset"
IMAGES_DIR = DATASET_DIR / "images"
ANNOTATIONS_FILE = DATASET_DIR / "annotations.json"

CANVAS_W = 900
CANVAS_H = 720

KEYPOINT_NAMES = ["TL", "TR", "BR", "BL"]
KEYPOINT_COLORS = ["#ff0000", "#00ccff", "#00ff00", "#ff00ff"]
PANEL_FILL = "#00ff88"
PANEL_OUTLINE = "#00ff88"
PANEL_FILL_HL = "#ffff00"
PANEL_OUTLINE_HL = "#ffff00"
PREVIEW_OUTLINE = "#ffcc00"
PREVIEW_FILL = "#ffcc00"
SNAP_RADIUS = 20
BLACK_THRESHOLD = 80


class PanelLabeler:
    def __init__(self, root):
        self.root = root
        self.root.title("Panel Pose Labeler")

        self.image_files = sorted(IMAGES_DIR.glob("*.jpg"))
        if not self.image_files:
            messagebox.showerror("Error", f"No images in {IMAGES_DIR}")
            root.destroy()
            return

        self.current_idx = 0
        self.annotations = self._load_json()

        self.orig_image = None
        self.tk_image = None
        self.gray_array = None
        self.scale = 1.0
        self.offset_x = 0
        self.offset_y = 0

        self.current_keypoints = []
        self.temp_ids = []

        self.canvas_items = []
        self.selected_panel = None

        self._build_ui()
        self._bind_keys()
        self.root.after(100, self._load_current)

    def _load_json(self):
        if ANNOTATIONS_FILE.exists():
            with open(ANNOTATIONS_FILE) as f:
                data = json.load(f)
                return data.get("annotations", {})
        return {}

    def _save_json(self):
        out = {}
        for name, info in self.annotations.items():
            out[name] = {"panels": info["panels"]}
        with open(ANNOTATIONS_FILE, "w") as f:
            json.dump({"annotations": out}, f, indent=2)

    # ── UI ───────────────────────────────────────────────────────

    def _build_ui(self):
        main = ttk.Frame(self.root)
        main.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        cf = ttk.Frame(main)
        cf.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(cf, width=CANVAS_W, height=CANVAS_H, bg="#1e1e1e",
                                highlightthickness=0, cursor="crosshair")
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<Motion>", self._on_motion)
        self.canvas.bind("<Configure>", lambda e: self._load_current())

        rp = ttk.Frame(main, width=280)
        rp.pack(side=tk.RIGHT, fill=tk.Y, padx=(10, 0))
        rp.pack_propagate(False)

        nf = ttk.LabelFrame(rp, text="Navigation")
        nf.pack(fill=tk.X, pady=(0, 8))
        self.lbl_page = ttk.Label(nf, text="—")
        self.lbl_page.pack(pady=4)
        bf = ttk.Frame(nf)
        bf.pack(fill=tk.X, padx=5, pady=5)
        ttk.Button(bf, text="<< Prev", command=self._prev).pack(side=tk.LEFT, expand=True, fill=tk.X)
        ttk.Button(bf, text="Next >>", command=self._next).pack(side=tk.RIGHT, expand=True, fill=tk.X)

        self.lbl_hint = ttk.Label(rp, text="Click 4 corners: TL -> TR -> BR -> BL",
                                  font=("Consolas", 9), foreground="#aaaaaa")
        self.lbl_hint.pack(fill=tk.X, pady=(0, 4))

        pf = ttk.LabelFrame(rp, text="Panels (ordered)")
        pf.pack(fill=tk.BOTH, expand=True, pady=(0, 8))
        self.listbox = tk.Listbox(pf, selectmode=tk.SINGLE, font=("Consolas", 9))
        self.listbox.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.listbox.bind("<<ListboxSelect>>", self._on_select)

        btn_f = ttk.Frame(pf)
        btn_f.pack(fill=tk.X, padx=5, pady=(0, 3))
        ttk.Button(btn_f, text="Move Up", command=self._move_up).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 2))
        ttk.Button(btn_f, text="Move Down", command=self._move_down).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(2, 0))

        btn_f2 = ttk.Frame(pf)
        btn_f2.pack(fill=tk.X, padx=5, pady=(0, 5))
        ttk.Button(btn_f2, text="Delete  (Del)", command=self._delete_sel).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 2))
        ttk.Button(btn_f2, text="Clear All", command=self._clear).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(2, 0))

        af = ttk.LabelFrame(rp, text="Actions")
        af.pack(fill=tk.X)
        ttk.Button(af, text="Save  (Ctrl+S)", command=self._save).pack(fill=tk.X, padx=5, pady=5)

        sf = ttk.LabelFrame(rp, text="Shortcuts")
        sf.pack(fill=tk.X, pady=(8, 0))
        ttk.Label(sf, justify=tk.LEFT, font=("Consolas", 8),
                  text="Left/Right  : navigate\n"
                       "Ctrl+Z      : undo last panel\n"
                       "Ctrl+S      : save\n"
                       "Del         : delete selected\n"
                       "Escape      : cancel current box\n"
                       "Shift+Click : exact pos (no snap)").pack(padx=5, pady=5)

    def _bind_keys(self):
        self.root.bind("<Left>", lambda e: self._prev())
        self.root.bind("<Right>", lambda e: self._next())
        self.root.bind("<Control-z>", lambda e: self._undo())
        self.root.bind("<Control-s>", lambda e: self._save())
        self.root.bind("<Delete>", lambda e: self._delete_sel())
        self.root.bind("<Escape>", lambda e: self._cancel_current())

    # ── coords ───────────────────────────────────────────────────

    def _cur_name(self):
        return self.image_files[self.current_idx].name

    def _snap_to_black(self, ix, iy):
        if self.gray_array is None:
            return int(ix), int(iy)
        ow, oh = self.gray_array.shape[1], self.gray_array.shape[0]
        ix, iy = int(ix), int(iy)
        x0 = max(0, ix - SNAP_RADIUS)
        y0 = max(0, iy - SNAP_RADIUS)
        x1 = min(ow, ix + SNAP_RADIUS + 1)
        y1 = min(oh, iy + SNAP_RADIUS + 1)
        region = self.gray_array[y0:y1, x0:x1]
        if region.size == 0:
            return ix, iy
        mask = region < BLACK_THRESHOLD
        if not mask.any():
            return ix, iy
        ys, xs = np.where(mask)
        dists = (xs - (ix - x0)) ** 2 + (ys - (iy - y0)) ** 2
        best = np.argmin(dists)
        return int(xs[best] + x0), int(ys[best] + y0)

    def _c2i(self, cx, cy):
        return (cx - self.offset_x) / self.scale, (cy - self.offset_y) / self.scale

    def _i2c(self, ix, iy):
        return ix * self.scale + self.offset_x, iy * self.scale + self.offset_y

    # ── rendering ────────────────────────────────────────────────

    def _load_current(self):
        name = self._cur_name()
        self.orig_image = Image.open(IMAGES_DIR / name)
        self.gray_array = np.array(self.orig_image.convert("L"))
        self._cancel_current()
        self._render_base()
        self._draw_all_panels()
        self._refresh_list()
        self._refresh_label()

    def _render_base(self):
        cw = self.canvas.winfo_width() or CANVAS_W
        ch = self.canvas.winfo_height() or CANVAS_H
        ow, oh = self.orig_image.size
        self.scale = min(cw / ow, ch / oh)
        nw, nh = int(ow * self.scale), int(oh * self.scale)
        self.offset_x = (cw - nw) / 2
        self.offset_y = (ch - nh) / 2
        resized = self.orig_image.resize((nw, nh), Image.LANCZOS)
        self.tk_image = ImageTk.PhotoImage(resized)
        self.canvas.delete("all")
        self.canvas.create_image(self.offset_x, self.offset_y, anchor=tk.NW, image=self.tk_image)

    def _draw_all_panels(self):
        self.canvas_items.clear()
        name = self._cur_name()
        panels = self.annotations.get(name, {}).get("panels", [])
        for pi, panel in enumerate(panels):
            self._draw_panel(panel, highlight=(pi == self.selected_panel))

    def _draw_panel(self, panel, highlight=False):
        kps = panel.get("keypoints", [])
        if len(kps) < 4:
            return
        outline = PANEL_OUTLINE_HL if highlight else PANEL_OUTLINE
        fill = PANEL_FILL_HL if highlight else PANEL_FILL
        w = 3 if highlight else 2

        coords = []
        for kp in kps:
            cx, cy = self._i2c(kp["x"], kp["y"])
            coords.extend([cx, cy])

        rid = self.canvas.create_polygon(coords, outline=outline, fill=fill, width=w, stipple="gray25")
        self.canvas_items.append(rid)

        for ki, kp in enumerate(kps):
            cx, cy = self._i2c(kp["x"], kp["y"])
            r = 5
            self.canvas.create_oval(cx - r, cy - r, cx + r, cy + r,
                                    fill=KEYPOINT_COLORS[ki], outline="white", width=1)
            self.canvas.create_text(cx, cy - 12, text=KEYPOINT_NAMES[ki],
                                    fill=KEYPOINT_COLORS[ki], font=("Consolas", 8, "bold"))

    def _refresh_list(self):
        self.listbox.delete(0, tk.END)
        name = self._cur_name()
        for i, p in enumerate(self.annotations.get(name, {}).get("panels", [])):
            kps = p.get("keypoints", [])
            if len(kps) < 4:
                self.listbox.insert(tk.END, f"#{i + 1}  (incomplete)")
                continue
            xs = [k["x"] for k in kps]
            ys = [k["y"] for k in kps]
            self.listbox.insert(tk.END,
                                f"#{i + 1}  ({min(xs)},{min(ys)}) ({max(xs)},{max(ys)})")

    def _refresh_label(self):
        name = self._cur_name()
        n = len(self.annotations.get(name, {}).get("panels", []))
        kn = len(self.current_keypoints)
        self.lbl_page.config(text=f"Page {self.current_idx + 1}/{len(self.image_files)}   ({n} panels)")
        if kn > 0:
            self.lbl_hint.config(text=f"Click {KEYPOINT_NAMES[kn]} ({kn}/4)", foreground="#ffcc00")
        else:
            self.lbl_hint.config(text="Click 4 corners: TL -> TR -> BR -> BL", foreground="#aaaaaa")

    # ── live preview while drawing ───────────────────────────────

    def _redraw_scene(self):
        self.canvas.delete("all")
        self.canvas.create_image(self.offset_x, self.offset_y, anchor=tk.NW, image=self.tk_image)
        self._draw_all_panels()
        self._draw_temp_keypoints()

    def _draw_temp_keypoints(self):
        for cid in self.temp_ids:
            self.canvas.delete(cid)
        self.temp_ids.clear()

        for i, kp in enumerate(self.current_keypoints):
            cx, cy = self._i2c(kp["x"], kp["y"])
            r = 5
            self.temp_ids.append(self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                fill=KEYPOINT_COLORS[i], outline="white", width=1))
            self.temp_ids.append(self.canvas.create_text(
                cx, cy - 12, text=KEYPOINT_NAMES[i],
                fill=KEYPOINT_COLORS[i], font=("Consolas", 8, "bold")))

        n = len(self.current_keypoints)
        if n >= 2:
            coords = []
            for kp in self.current_keypoints:
                cx, cy = self._i2c(kp["x"], kp["y"])
                coords.extend([cx, cy])
            self.temp_ids.append(self.canvas.create_line(
                *coords, fill=PREVIEW_OUTLINE, width=2, dash=(6, 3)))

    def _on_motion(self, e):
        if not self.current_keypoints:
            return

        n = len(self.current_keypoints)
        ix, iy = self._c2i(e.x, e.y)

        shift = bool(e.state & 0x1)
        if not shift:
            ix, iy = self._snap_to_black(ix, iy)

        for cid in self.temp_ids:
            self.canvas.delete(cid)
        self.temp_ids.clear()

        pts = list(self.current_keypoints) + [{"x": int(ix), "y": int(iy)}]

        if n == 3:
            coords = []
            for kp in pts:
                cx, cy = self._i2c(kp["x"], kp["y"])
                coords.extend([cx, cy])
            self.temp_ids.append(self.canvas.create_polygon(
                *coords, outline=PREVIEW_OUTLINE, fill=PREVIEW_FILL, width=2, dash=(6, 3), stipple="gray25"))
        else:
            coords = []
            for kp in pts:
                cx, cy = self._i2c(kp["x"], kp["y"])
                coords.extend([cx, cy])
            self.temp_ids.append(self.canvas.create_line(
                *coords, fill=PREVIEW_OUTLINE, width=2, dash=(6, 3)))

        for i, kp in enumerate(self.current_keypoints):
            cx, cy = self._i2c(kp["x"], kp["y"])
            r = 5
            self.temp_ids.append(self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                fill=KEYPOINT_COLORS[i], outline="white", width=1))
            self.temp_ids.append(self.canvas.create_text(
                cx, cy - 12, text=KEYPOINT_NAMES[i],
                fill=KEYPOINT_COLORS[i], font=("Consolas", 8, "bold")))

    # ── click to place keypoints ─────────────────────────────────

    def _on_click(self, e):
        ix, iy = self._c2i(e.x, e.y)
        if ix < 0 or iy < 0:
            return
        ow, oh = self.orig_image.size
        if ix > ow or iy > oh:
            return

        shift = bool(e.state & 0x1)
        if not shift:
            ix, iy = self._snap_to_black(ix, iy)

        self.current_keypoints.append({"x": int(ix), "y": int(iy)})

        if len(self.current_keypoints) == 4:
            self._commit_panel(list(self.current_keypoints))
            self.current_keypoints.clear()
            for cid in self.temp_ids:
                self.canvas.delete(cid)
            self.temp_ids.clear()
            self._redraw_scene()
            self._refresh_list()
            self._refresh_label()
            return

        self._refresh_label()

    def _commit_panel(self, keypoints):
        name = self._cur_name()
        if name not in self.annotations:
            self.annotations[name] = {"panels": []}

        xs = [k["x"] for k in keypoints]
        ys = [k["y"] for k in keypoints]
        cx = sum(xs) / 4
        cy = sum(ys) / 4
        w = max(max(xs) - min(xs), 1)
        h = max(max(ys) - min(ys), 1)

        panel = {
            "keypoints": keypoints,
            "bbox": {"x_center": cx, "y_center": cy, "w": w, "h": h},
        }
        self.annotations[name]["panels"].append(panel)
        self._save_json()

    def _cancel_current(self):
        for cid in self.temp_ids:
            self.canvas.delete(cid)
        self.temp_ids.clear()
        self.current_keypoints.clear()
        self._refresh_label()

    # ── selection / panel management ─────────────────────────────

    def _on_select(self, _):
        sel = self.listbox.curselection()
        if not sel:
            self.selected_panel = None
        else:
            self.selected_panel = sel[0]
        self._redraw_scene()

    def _delete_sel(self):
        name = self._cur_name()
        panels = self.annotations.get(name, {}).get("panels", [])
        if self.selected_panel is not None and 0 <= self.selected_panel < len(panels):
            panels.pop(self.selected_panel)
            self._save_json()
        self.selected_panel = None
        self._load_current()

    def _move_up(self):
        name = self._cur_name()
        panels = self.annotations.get(name, {}).get("panels", [])
        i = self.selected_panel
        if i is not None and 0 < i < len(panels):
            panels[i], panels[i - 1] = panels[i - 1], panels[i]
            self.selected_panel = i - 1
            self._save_json()
            self._load_current()
            self.listbox.selection_set(self.selected_panel)

    def _move_down(self):
        name = self._cur_name()
        panels = self.annotations.get(name, {}).get("panels", [])
        i = self.selected_panel
        if i is not None and 0 <= i < len(panels) - 1:
            panels[i], panels[i + 1] = panels[i + 1], panels[i]
            self.selected_panel = i + 1
            self._save_json()
            self._load_current()
            self.listbox.selection_set(self.selected_panel)

    def _clear(self):
        name = self._cur_name()
        self.annotations[name] = {"panels": []}
        self._save_json()
        self._load_current()

    def _undo(self):
        name = self._cur_name()
        panels = self.annotations.get(name, {}).get("panels", [])
        if panels:
            panels.pop()
            self._save_json()
            self._load_current()

    def _prev(self):
        if self.current_idx > 0:
            self.current_idx -= 1
            self.selected_panel = None
            self._load_current()

    def _next(self):
        if self.current_idx < len(self.image_files) - 1:
            self.current_idx += 1
            self.selected_panel = None
            self._load_current()

    def _save(self):
        self._save_json()
        print(f"Saved {ANNOTATIONS_FILE}")


def main():
    root = tk.Tk()
    root.geometry("1250x780")
    root.minsize(900, 600)
    PanelLabeler(root)
    root.mainloop()


if __name__ == "__main__":
    main()
