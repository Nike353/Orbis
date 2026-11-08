"""Device-local import history; running CLI processes are never resumed."""
import uuid

try:
    from agent_bridge import utc_now, BridgeContractError
except ModuleNotFoundError:
    from tools.agent_bridge import utc_now, BridgeContractError


class ActivityStore:
    def __init__(self, documents):
        self.storage = documents
        self.path = documents.root / ".orbis/activity.json"

    def read(self):
        jobs = self.storage.read(self.path, [])
        if (not isinstance(jobs, list) or len(jobs) > 500
                or any(not isinstance(job, dict) or not isinstance(job.get("id"), str)
                       or not isinstance(job.get("status"), str) for job in jobs)):
            raise BridgeContractError("Import activity could not be read. Its file is preserved.")
        return jobs

    def start(self, record, hint, agent, settings):
        with self.storage.lock:
            job = {"id": uuid.uuid4().hex, "kind": "import", "status": "running", "phase": "queued",
                   "title": record.get("title") or record["canonical_url"], "url": record["canonical_url"],
                   "source_kind": record.get("source_kind", "paper"), "hint": hint,
                   "agent": agent, "settings": settings, "created_at": utc_now(), "error": ""}
            self.storage.write(self.path, [job, *self.read()][:500])
            return job["id"]

    def update(self, identifier, **updates):
        if not identifier:
            return
        with self.storage.lock:
            jobs = self.read()
            job = next((job for job in jobs if job["id"] == identifier), None)
            if job is None:
                raise BridgeContractError("Import activity record is missing.")
            job.update(updates)
            self.storage.write(self.path, jobs)

    def recover(self):
        with self.storage.lock:
            jobs = self.read()
            changed = False
            for job in jobs:
                if job["status"] == "running":
                    job.update(status="interrupted", phase="interrupted",
                               error="The app stopped before this import finished. Check the library, then retry.",
                               finished_at=utc_now())
                    changed = True
            if changed:
                self.storage.write(self.path, jobs)
