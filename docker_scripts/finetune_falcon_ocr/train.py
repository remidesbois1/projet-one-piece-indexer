"""Full fine-tuning, validation-only selection, then optional all-corpus refit."""

import gc
import json
import math
import random
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict

import torch
import torch.nn.functional as F
from config import same_training_identity
from data import write_json
from model import FalconEngine, autocast
from PIL import Image
from report import aggregate, score_sample, write_benchmark
from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeRemainingColumn,
)

console = Console()


def seed_everything(seed):
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def atomic_save(path, payload):
    temporary = path.with_suffix(".tmp")
    torch.save(payload, temporary)
    temporary.replace(path)


def check_gradients(model):
    missing = []
    for name, parameter in model.named_parameters():
        if parameter.requires_grad and (
            parameter.grad is None or not torch.isfinite(parameter.grad).all()
        ):
            missing.append(name)
    if missing:
        raise RuntimeError(f"Missing/nonfinite gradients: {missing[:10]}")
    for name in (
        "img_projector.weight",
        "layers.0.feed_forward.w13.weight",
        "layers.0.attention.sinks",
    ):
        if not model.get_parameter(name).grad.abs().sum() > 0:
            raise RuntimeError(f"Zero gradient: {name}")


def make_optimizer(engine, config, lr=None):
    decay, no_decay = [], []
    for name, parameter in engine.model.named_parameters():
        (
            decay if parameter.ndim >= 2 and "tok_embeddings" not in name else no_decay
        ).append(parameter)
    return torch.optim.AdamW(
        [
            {"params": decay, "weight_decay": config.weight_decay},
            {"params": no_decay, "weight_decay": 0},
        ],
        lr=config.lr if lr is None else lr,
        fused=True,
    )


def calibrate(engine, rows):
    c = engine.config
    # Square maximum-resolution crop + longest target bounds padding cost even
    # when no real batch happens to contain both extremes during calibration.
    path = c.output / "calibration.png"
    Image.new("RGB", (c.max_dimension, c.max_dimension), "white").save(path)
    longest = max(rows, key=lambda r: len(engine.target_ids(r)))
    worst = dict(longest, image_path=str(path))
    candidates = (
        [c.micro_batch]
        if c.micro_batch
        else [n for n in (32, 16, 8, 4, 2, 1) if c.effective_batch % n == 0]
    )
    measurements = []
    for count in candidates:
        optimizer, batch, loss = None, None, None
        try:
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            free, _ = torch.cuda.mem_get_info()
            resident = torch.cuda.memory_allocated()
            optimizer = make_optimizer(engine, c, lr=0.0)
            batch = engine.collate([worst] * count)
            engine.model.train()
            started = time.perf_counter()
            with autocast():
                loss = engine.loss(batch)
            if not torch.isfinite(loss):
                raise RuntimeError("Nonfinite calibration loss")
            loss.backward()
            check_gradients(engine.model)
            optimizer.step()  # allocate real Adam moments; lr=0 preserves weights
            torch.cuda.synchronize()
            peak = torch.cuda.max_memory_allocated()
            safe = peak < (free + resident) * 0.85
            measurements.append(
                {
                    "micro_batch": count,
                    "peak_gib": peak / 2**30,
                    "seconds": time.perf_counter() - started,
                    "safe": safe,
                }
            )
            console.print(
                f"Calibration batch={count}: {peak / 2**30:.1f} GiB, margin {'OK' if safe else 'too small'}"
            )
            if safe:
                write_json(c.output / "calibration.json", measurements)
                return count
        except torch.cuda.OutOfMemoryError:
            measurements.append({"micro_batch": count, "oom": True})
        finally:
            engine.model.zero_grad(set_to_none=True)
            del loss, batch, optimizer
            gc.collect()
            torch.cuda.empty_cache()
    write_json(c.output / "calibration.json", measurements)
    raise RuntimeError("No safe batch. Free GPU memory or reduce FALCON_MAX_DIMENSION.")


def ordered_rows(rows, seed):
    """Shuffle length buckets, visit every example exactly once each epoch."""
    rng = random.Random(seed)
    shuffled = list(rows)
    rng.shuffle(shuffled)
    chunks = [shuffled[i : i + 256] for i in range(0, len(rows), 256)]
    for chunk in chunks:
        chunk.sort(key=lambda r: (r["width"] * r["height"], len(r["text"])))
    rng.shuffle(chunks)
    return [r for chunk in chunks for r in chunk]


@contextmanager
def prepared_training_batches(engine, samples, rng, micro_batch):
    """One CPU producer, one batch ahead; preserve sample and augmentation order."""
    c = engine.config
    groups = (
        samples[i : i + c.effective_batch]
        for i in range(0, len(samples), c.effective_batch)
    )

    def prepare(group):
        return group, [
            (
                len(group[offset : offset + micro_batch]),
                engine.collate(
                    group[offset : offset + micro_batch],
                    rng if c.augment else None,
                    cpu_only=True,
                ),
            )
            for offset in range(0, len(group), micro_batch)
        ]

    if not c.prefetch_batches:
        yield map(prepare, groups)
        return
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="falcon-input") as pool:

        def batches():
            first = next(groups, None)
            pending = pool.submit(prepare, first) if first is not None else None
            while pending is not None:
                prepared = pending.result()
                following = next(groups, None)
                pending = (
                    pool.submit(prepare, following) if following is not None else None
                )
                yield prepared

        yield batches()


def train_epoch(
    engine, optimizer, scheduler, rows, epoch, stage, micro_batch, writer, steps
):
    c = engine.config
    engine.model.train()
    samples = ordered_rows(rows, c.seed + epoch)
    rng = random.Random(c.seed + epoch)
    total_loss, visited = 0.0, 0
    started = time.perf_counter()
    progress = Progress(
        SpinnerColumn(),
        TextColumn("{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeRemainingColumn(),
        console=console,
    )
    with (
        progress,
        prepared_training_batches(engine, samples, rng, micro_batch) as batches,
    ):
        task = progress.add_task(f"{stage} · epoch {epoch}", total=len(samples))
        for group, prepared in batches:
            optimizer.zero_grad(set_to_none=True)
            group_loss = 0.0
            for count, cpu_batch in prepared:
                batch = engine.to_device(cpu_batch)
                with autocast():
                    loss = engine.loss(batch)
                if not torch.isfinite(loss):
                    raise RuntimeError("Nonfinite loss; checkpoint preserved")
                (loss * count / len(group)).backward()
                group_loss += loss.detach().item() * count
                del batch, loss
            norm = torch.nn.utils.clip_grad_norm_(
                engine.model.parameters(), 1.0, error_if_nonfinite=True
            )
            optimizer.step()
            scheduler.step()
            steps += 1
            total_loss += group_loss
            visited += len(group)
            seconds = time.perf_counter() - started
            values = {
                "loss": group_loss / len(group),
                "lr": optimizer.param_groups[0]["lr"],
                "grad_norm": float(norm),
                "bubbles_per_second": visited / max(seconds, 1e-9),
                "vram_gib": torch.cuda.max_memory_allocated() / 2**30,
            }
            for key, value in values.items():
                writer.add_scalar(f"{stage}/{key}", value, steps)
            with (c.output / "steps.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(
                    json.dumps(
                        {"stage": stage, "epoch": epoch, "step": steps, **values}
                    )
                    + "\n"
                )
            progress.update(
                task,
                advance=len(group),
                description=(
                    f"{stage} {epoch} · loss {values['loss']:.3f} · "
                    f"{values['bubbles_per_second']:.1f} bulles/s · {values['vram_gib']:.1f} Go"
                ),
            )
    if visited != len(rows):
        raise RuntimeError("Incomplete epoch")
    return total_loss / visited, steps, time.perf_counter() - started


def evaluate(engine, rows, label):
    engine.model.eval()
    predictions = []
    torch.cuda.synchronize()
    started = time.perf_counter()
    last_log = started
    console.print(f"{label} · {len(rows)} bulles · batch {engine.config.eval_batch}")
    # Only images and the constant prompt enter the model, never references.
    with Progress(
        TextColumn("{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(label, total=len(rows))
        for start in range(0, len(rows), engine.config.eval_batch):
            group = rows[start : start + engine.config.eval_batch]
            with autocast():
                outputs = engine.generate(group)
            predictions.extend(
                score_sample(row, output) for row, output in zip(group, outputs)
            )
            progress.update(task, advance=len(group))
            now = time.perf_counter()
            if not console.is_terminal and now - last_log >= 20:
                completed = len(predictions)
                rate = completed / (now - started)
                remaining = (len(rows) - completed) / rate
                console.print(
                    f"{label} · {completed}/{len(rows)} · {rate:.1f} bulles/s · "
                    f"écoulé {(now - started) / 60:.1f} min · reste ~{remaining / 60:.1f} min"
                )
                last_log = now
    torch.cuda.synchronize()
    return predictions, time.perf_counter() - started


def fit_stage(engine, rows, val_rows, fingerprint, stage, epochs, micro_batch, writer):
    c = engine.config
    checkpoint_path = c.output / f"{stage}_resume.pt"
    best_path = c.output / "selected_weights.pt"
    optimizer = make_optimizer(engine, c)
    total_steps = epochs * math.ceil(len(rows) / c.effective_batch)
    warmup = max(1, math.ceil(0.05 * total_steps))

    def lr_factor(step):
        if step < warmup:
            return (step + 1) / warmup
        return 0.1 + 0.9 * 0.5 * (
            1
            + math.cos(math.pi * min(1, (step - warmup) / max(1, total_steps - warmup)))
        )

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_factor)
    identity = {
        "config": asdict(c),
        "fingerprint": fingerprint,
        "stage": stage,
        "epochs": epochs,
        "micro_batch": micro_batch,
    }
    # Upload/repo/output locations do not affect optimization or permit data changes.
    for key in ("upload", "repo_id", "output_dir", "dataset_dir"):
        identity["config"].pop(key)
    start, steps, best_cer, best_epoch, stale, history = 1, 0, float("inf"), 0, 0, []
    if checkpoint_path.exists():
        state = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        if not same_training_identity(state["identity"], identity):
            raise RuntimeError(
                "Resume config/dataset changed; use a new FALCON_OUTPUT_DIR"
            )
        engine.model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        scheduler.load_state_dict(state["scheduler"])
        start, steps = state["epoch"] + 1, state["steps"]
        best_cer, best_epoch, stale, history = (
            state[k] for k in ("best_cer", "best_epoch", "stale", "history")
        )
        del state
        console.print(
            f"Reprise {stage} à l’époque {start} (reprise aux frontières d’époque)"
        )
    for epoch in range(start, epochs + 1):
        if stage == "selection" and stale >= c.patience:
            break
        seed_everything(c.seed + epoch)
        loss, steps, elapsed = train_epoch(
            engine, optimizer, scheduler, rows, epoch, stage, micro_batch, writer, steps
        )
        event = {"epoch": epoch, "loss": loss, "seconds": elapsed, "visited": len(rows)}
        if val_rows:
            samples, seconds = evaluate(
                engine, val_rows, "Validation complète · génération"
            )
            metrics = aggregate(samples)
            event.update({"val_" + k: v for k, v in metrics.items()})
            for key, value in metrics.items():
                writer.add_scalar("validation/" + key, value, epoch)
            console.print(
                f"[bold cyan]Epoch {epoch} · CER {metrics['cer'] * 100:.3f}% · WER "
                f"{metrics['wer'] * 100:.3f}% · exact {metrics['exact_match'] * 100:.2f}%[/]"
            )
            if metrics["cer"] < best_cer:
                best_cer, best_epoch, stale = metrics["cer"], epoch, 0
                atomic_save(best_path, engine.model.state_dict())
                write_benchmark(
                    c.output / "benchmark_validation.json", samples, "selected", seconds
                )
            else:
                stale += 1
        else:
            best_epoch = epoch
        history.append(event)
        atomic_save(
            checkpoint_path,
            {
                "identity": identity,
                "model": engine.model.state_dict(),
                "optimizer": optimizer.state_dict(),
                "scheduler": scheduler.state_dict(),
                "epoch": epoch,
                "steps": steps,
                "best_cer": best_cer,
                "best_epoch": best_epoch,
                "stale": stale,
                "history": history,
            },
        )
        write_json(c.output / f"{stage}_history.json", history)
        writer.flush()
    del optimizer, scheduler
    gc.collect()
    torch.cuda.empty_cache()
    if stage == "selection":
        engine.model.load_state_dict(
            torch.load(best_path, map_location="cpu", weights_only=True)
        )
    return best_epoch, history


def smoke(engine, rows):
    """Real GPU backward + parity with upstream teacher-forced forward + save/reload."""
    engine.model.eval()
    batch = engine.collate(rows[:1])
    precision_checks = {}
    previous_precision = torch.get_float32_matmul_precision()
    try:
        for amp in (False, True):
            torch.set_float32_matmul_precision(previous_precision if amp else "highest")
            with (
                torch.no_grad(),
                torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp),
            ):
                training_logits = engine.model.output(engine.hidden(batch))
                size = batch["tokens"].shape[1]
                cache = engine.upstream.KVCache(
                    1,
                    size,
                    engine.model.config.n_heads,
                    engine.model.config.head_dim,
                    engine.model.config.n_layers,
                )
                mask = engine.model.get_attention_mask(batch["tokens"])
                native_logits = engine.model(
                    tokens=batch["tokens"],
                    attention_mask=mask,
                    kv_cache=cache,
                    rope_pos_t=batch["pos_t"],
                    rope_pos_hw=batch["pos_hw"],
                    pixel_values=batch["pixel_values"],
                    pixel_mask=batch["pixel_mask"],
                )
                valid = batch["labels"][:, 1:] != -100
                a, b = (
                    training_logits[:, :-1][valid].float(),
                    native_logits[:, :-1][valid].float(),
                )
                difference = (a - b).abs()
                max_error, mean_error = (
                    difference.max().item(),
                    difference.mean().item(),
                )
                kl = F.kl_div(
                    a.log_softmax(-1), b.softmax(-1), reduction="batchmean"
                ).item()
                label = "bf16" if amp else "fp32"
                precision_checks[label] = {
                    "max_abs": max_error,
                    "mean_abs": mean_error,
                    "kl_nats": max(0.0, kl),
                    "top1_agreement": (a.argmax(-1) == b.argmax(-1))
                    .float()
                    .mean()
                    .item(),
                }
                # FP32 verifies the mathematical contract. BF16 compares token
                # distributions: common logit offsets do not affect softmax.
                if (
                    not math.isfinite(kl)
                    or (amp and kl > 0.01)
                    or (not amp and max_error > 0.001)
                ):
                    raise RuntimeError(
                        f"Training/inference {label} parity failed: {precision_checks[label]}"
                    )
            del training_logits, native_logits, cache, mask, a, b, difference
    finally:
        torch.set_float32_matmul_precision(previous_precision)
    engine.model.train()
    with autocast():
        loss = engine.loss(batch)
    loss.backward()
    check_gradients(engine.model)
    engine.model.zero_grad(set_to_none=True)
    engine.model.eval()
    with autocast():
        before = engine.generate(rows[:1])
    folder = engine.config.output / "smoke_model"
    engine.save(folder)
    report = {
        "loss": float(loss.detach()),
        "parity_max_abs": max_error,
        "parity_mean_abs": mean_error,
        "precision_checks": precision_checks,
        "gradients": "all trainable parameters finite; image/MLP/sink nonzero",
        "prediction": before,
    }
    return folder, report


def run_training(config, splits, fingerprint, smoke_only=False):
    from torch.utils.tensorboard import SummaryWriter

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; launch with Docker --gpus all")
    capability = torch.cuda.get_device_capability()
    if not torch.cuda.is_bf16_supported():
        raise RuntimeError("BF16 support required")
    console.print(
        f"[bold]GPU: {torch.cuda.get_device_name()} · SM {capability[0]}.{capability[1]}[/]"
    )
    torch.set_float32_matmul_precision("high")
    seed_everything(config.seed)
    all_rows = [row for split in splits.values() for row in split]
    engine = FalconEngine(config)
    for row in all_rows:
        engine.target_ids(row)  # fail before training rather than truncate labels
    folder, smoke_report = smoke(engine, splits["train"])
    del engine
    gc.collect()
    torch.cuda.empty_cache()
    engine = FalconEngine(config, source=folder)
    engine.model.eval()
    with autocast():
        after = engine.generate(splits["train"][:1])
    if after != smoke_report["prediction"]:
        raise RuntimeError("Saved-model round-trip predictions differ")
    smoke_report["save_reload"] = "passed"
    write_json(config.output / "smoke_report.json", smoke_report)
    if smoke_only:
        micro_batch = calibrate(engine, all_rows)
        # Exercise the exact production accumulation/optimizer path on two
        # effective batches. These probe weights are intentionally not saved.
        optimizer = make_optimizer(engine, config)
        scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda _: 1.0)
        probe_rows = splits["train"][: 2 * config.effective_batch]
        with SummaryWriter(config.output / "smoke_tensorboard") as writer:
            loss, steps, seconds = train_epoch(
                engine,
                optimizer,
                scheduler,
                probe_rows,
                0,
                "smoke",
                micro_batch,
                writer,
                0,
            )
        by_size = sorted(splits["val"], key=lambda row: row["width"] * row["height"])
        indices = sorted({round(i * (len(by_size) - 1) / 15) for i in range(16)})
        samples, generation_seconds = evaluate(
            engine, [by_size[i] for i in indices], "Smoke · génération batchée"
        )
        smoke_report.update(
            {
                "micro_batch": micro_batch,
                "optimizer_steps": steps,
                "training_loss": loss,
                "training_seconds": seconds,
                "batched_generation_samples": len(samples),
                "generation_seconds": generation_seconds,
                "cuda": torch.version.cuda,
                "torch": torch.__version__,
                "gpu": torch.cuda.get_device_name(),
                "complete": True,
            }
        )
        write_json(config.output / "smoke_report.json", smoke_report)
        console.print(
            "[bold green]Smoke GPU : gradients, parité, rechargement, mémoire et optimiseur OK[/]"
        )
        return None
    micro_batch = calibrate(engine, all_rows)
    writer = SummaryWriter(config.output / "tensorboard")
    try:
        samples, elapsed = evaluate(
            engine, splits["val"], "Validation complète · Falcon de base"
        )
        base_validation = write_benchmark(
            config.output / "benchmark_base_validation.json", samples, "base", elapsed
        )
        best_epoch, history = fit_stage(
            engine,
            splits["train"],
            splits["val"],
            fingerprint,
            "selection",
            config.epochs,
            micro_batch,
            writer,
        )
        release = config.output / "release"
        evaluated = release / "evaluated" if config.refit_all else release
        engine.save(evaluated)
        selected_cer = min(h["val_cer"] for h in history)
        if selected_cer > base_validation["metrics"]["cer"]:
            write_json(
                config.output / "quality_gate.json",
                {
                    "passed": False,
                    "base_validation_cer": base_validation["metrics"]["cer"],
                    "selected_validation_cer": selected_cer,
                },
            )
            raise RuntimeError(
                "Validation regressed versus base; candidate saved, refit/upload blocked. Try a new run with a lower LR."
            )
        write_json(
            config.output / "quality_gate.json",
            {
                "passed": True,
                "base_validation_cer": base_validation["metrics"]["cer"],
                "selected_validation_cer": selected_cer,
            },
        )
        samples, elapsed = evaluate(
            engine, splits["test"], "Test complet · checkpoint sélectionné"
        )
        test = write_benchmark(
            release / "benchmark_test.json",
            samples,
            "evaluated checkpoint; never the all-data refit",
            elapsed,
        )
        del engine
        gc.collect()
        torch.cuda.empty_cache()
        engine = FalconEngine(config)
        samples, elapsed = evaluate(
            engine, splits["test"], "Test complet · Falcon de base"
        )
        baseline = write_benchmark(
            release / "benchmark_base_test.json",
            samples,
            "tiiuae/Falcon-OCR (base)",
            elapsed,
        )
        if config.refit_all:
            fit_stage(
                engine,
                all_rows,
                None,
                fingerprint,
                "refit",
                best_epoch,
                micro_batch,
                writer,
            )
            engine.save(release)
        else:
            del engine
            gc.collect()
            torch.cuda.empty_cache()
            engine = FalconEngine(config, source=release)
        engine.model.eval()
        with autocast():
            final_prediction = engine.generate(splits["train"][:1])
        del engine
        gc.collect()
        torch.cuda.empty_cache()
        engine = FalconEngine(config, source=release)
        engine.model.eval()
        with autocast():
            reloaded_prediction = engine.generate(splits["train"][:1])
        if reloaded_prediction != final_prediction:
            raise RuntimeError(
                "Final published weights failed save/reload generation parity"
            )
        summary = {
            "best_epoch": best_epoch,
            "exported": len(all_rows),
            "fingerprint": fingerprint,
            "micro_batch": micro_batch,
            "effective_batch": config.effective_batch,
            "root_training_scope": "all_exported_bubbles"
            if config.refit_all
            else "train_split_only",
            "root_has_held_out_metrics": not config.refit_all,
            "metric_checkpoint": "evaluated/" if config.refit_all else ".",
            "gpu": torch.cuda.get_device_name(),
            "compute_capability": list(capability),
            "base_test_cer": baseline["metrics"]["cer"],
            "selected_test_cer": test["metrics"]["cer"],
            "validation_best_cer": min(h["val_cer"] for h in history),
            "final_save_reload": "passed",
            "completed": True,
        }
        write_json(release / "run_summary.json", summary)
        return release, summary, test, baseline, history
    finally:
        writer.close()
