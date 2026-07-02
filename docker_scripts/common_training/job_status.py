from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _supabase_client():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client
    except ImportError:
        return None
    return create_client(url, key)


def update_training_job(job_id: str | None, **fields: Any) -> bool:
    if not job_id:
        return False
    payload = {key: value for key, value in fields.items() if value is not None}
    if not payload:
        return False
    payload["updated_at"] = utc_now_iso()
    client = _supabase_client()
    if client is None:
        return False
    try:
        client.table("training_jobs").update(payload).eq("id", job_id).execute()
        return True
    except Exception as exc:
        print(f"Training job status update skipped: {exc}", flush=True)
        return False


def append_training_log(job_id: str | None, message: str) -> bool:
    if not job_id or not message:
        return False
    client = _supabase_client()
    if client is None:
        return False
    stamped = f"[{utc_now_iso()}] {message.rstrip()}\n"
    try:
        response = client.table("training_jobs").select("logs_text").eq("id", job_id).single().execute()
        current = ""
        if response.data:
            current = response.data.get("logs_text") or ""
        client.table("training_jobs").update(
            {"logs_text": current + stamped, "updated_at": utc_now_iso()}
        ).eq("id", job_id).execute()
        return True
    except Exception as exc:
        print(f"Training job log append skipped: {exc}", flush=True)
        return False


def create_model_version(
    *,
    training_job_id: str | None,
    kind: str,
    hf_repo: str,
    hf_revision: str | None = None,
    metrics_json: dict[str, Any] | None = None,
    notes: str | None = None,
) -> bool:
    if not training_job_id or not hf_repo:
        return False
    client = _supabase_client()
    if client is None:
        return False
    payload = {
        "training_job_id": training_job_id,
        "kind": kind,
        "hf_repo": hf_repo,
        "hf_revision": hf_revision,
        "metrics_json": metrics_json,
        "is_candidate": True,
        "is_active": False,
        "notes": notes,
    }
    try:
        client.table("model_versions").insert(payload).execute()
        return True
    except Exception as exc:
        print(f"Model version creation skipped: {exc}", flush=True)
        return False

