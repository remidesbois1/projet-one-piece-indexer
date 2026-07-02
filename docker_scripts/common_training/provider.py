from __future__ import annotations

import os
import time
from typing import Any

import requests

from .env import env_bool, training_provider
from .job_status import update_training_job, utc_now_iso


class TrainingProviderHooks:
    provider = "local"

    def __init__(self, *, job_id: str | None = None, kind: str | None = None) -> None:
        self.job_id = job_id
        self.kind = kind

    def set_status(self, status: str, **fields: Any) -> None:
        update_training_job(self.job_id, status=status, provider=self.provider, kind=self.kind, **fields)

    def on_start(self, status: str = "running", **fields: Any) -> None:
        fields.setdefault("started_at", utc_now_iso())
        self.set_status(status, **fields)

    def on_error(self, error_message: str) -> None:
        self.set_status("failed", error_message=error_message, finished_at=utc_now_iso())

    def on_complete(self, summary: dict[str, Any] | None = None) -> None:
        self.set_status("completed", summary_json=summary, finished_at=utc_now_iso())


class LocalTrainingProvider(TrainingProviderHooks):
    provider = "local"


class ModalTrainingProvider(TrainingProviderHooks):
    provider = "modal"


class RunPodTrainingProvider(TrainingProviderHooks):
    provider = "runpod"

    def terminate_runpod(self, is_error: bool = False) -> None:
        pod_id = os.getenv("RUNPOD_POD_ID")
        api_key = os.getenv("RUNPOD_API_KEY")
        if not pod_id or not api_key or not env_bool("RUNPOD_TERMINATE_ON_EXIT", True):
            print("RunPod auto-termination skipped.", flush=True)
            return

        if is_error:
            delay = int(os.getenv("RUNPOD_ERROR_SHUTDOWN_DELAY_SECONDS", "600"))
            print(f"Pipeline failed. Waiting {delay}s before RunPod termination.", flush=True)
            time.sleep(delay)

        print(f"Terminating RunPod pod: {pod_id}", flush=True)
        url = f"https://api.runpod.io/graphql?api_key={api_key}"
        query = f'mutation {{ podTerminate(input: {{podId: "{pod_id}"}}) }}'
        try:
            response = requests.post(url, json={"query": query}, timeout=30)
            print(f"RunPod termination response: {response.text}", flush=True)
        except Exception as exc:
            print(f"RunPod termination failed: {exc}", flush=True)

    def on_error(self, error_message: str) -> None:
        super().on_error(error_message)
        self.terminate_runpod(is_error=True)

    def on_complete(self, summary: dict[str, Any] | None = None) -> None:
        super().on_complete(summary)
        self.terminate_runpod(is_error=False)


def provider_from_env(*, job_id: str | None = None, kind: str | None = None) -> TrainingProviderHooks:
    provider = training_provider()
    if provider == "runpod":
        return RunPodTrainingProvider(job_id=job_id, kind=kind)
    if provider == "modal":
        return ModalTrainingProvider(job_id=job_id, kind=kind)
    return LocalTrainingProvider(job_id=job_id, kind=kind)
