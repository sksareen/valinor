"""Local checks for the Muse store + surface merge + completion report."""
import os
import tempfile
import unittest
from pathlib import Path


class MuseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["MUSE_STORE_PATH"] = str(Path(self.tmp.name) / "muse.json")
        os.environ["MUSE_DEADLETTER_PATH"] = str(Path(self.tmp.name) / "dead.jsonl")
        os.environ["MUSE_COMPLETIONS_PATH"] = str(Path(self.tmp.name) / "done.json")
        os.environ.pop("INGEST_PATH", None)
        os.environ.pop("MUSE_INBOUND_KEY", None)
        os.environ.pop("MUSE_WEBHOOK_URL", None)
        os.environ.pop("VALINOR_GATE", None)
        os.environ.pop("VALINOR_PUBLIC_URL", None)
        import muse
        import ingest_surface
        import importlib
        importlib.reload(muse)
        importlib.reload(ingest_surface)
        self.muse = muse
        self.surface = ingest_surface

    def tearDown(self):
        self.tmp.cleanup()

    def test_upsert_and_surface(self):
        out = self.muse.upsert_missions([{
            "muse_id": "muse-1",
            "title": "Send the overdue follow-up",
            "outcome": "the follow-up sent",
            "theme": "Send the overdue follow-up",
            "why_now": "thread sitting 4 days",
            "priority": 1,
        }])
        self.assertEqual(out["added"], 1)
        missions = self.muse.surfaced_missions()
        self.assertEqual(len(missions), 1)
        self.assertEqual(missions[0]["origin"], "muse")
        self.assertEqual(missions[0]["muse_id"], "muse-1")

        batch = self.surface.surface_missions(limit=6)
        self.assertEqual(batch["muse"], 1)
        self.assertEqual(batch["missions"][0]["id"], "muse-muse-1")

    def test_consume_hides(self):
        self.muse.upsert_missions([{"muse_id": "muse-2", "title": "Write the brief"}])
        self.surface.record_consumed("Write the brief")
        self.assertEqual(self.muse.surfaced_missions(), [])
        self.muse.upsert_missions([{"muse_id": "muse-2", "title": "Write the brief"}])
        self.assertEqual(len(self.muse.surfaced_missions()), 1)

    def test_report_needs_muse_id(self):
        ev = [
            {"type": "intent.confirmed", "payload": {"theme": "x", "muse_id": "muse-9"}},
            {"type": "human.completed", "payload": {"title": "Draft it", "elapsed_s": 12,
                                                   "proof": {"body": "sent"}}},
            {"type": "outcome.recorded", "payload": {"closed": []}},
        ]
        report = self.muse.report_from_events("loop-1", ev)
        self.assertEqual(report["muse_id"], "muse-9")
        self.assertEqual(report["human_s"], 12)
        self.assertEqual(report["steps"][0]["assignee"], "human")
        self.assertIsNone(self.muse.report_from_events("loop-2", [
            {"type": "intent.confirmed", "payload": {"theme": "x"}}
        ]))

    def test_deadletter_on_bad_webhook(self):
        os.environ["MUSE_WEBHOOK_URL"] = "http://127.0.0.1:1/nope"
        ok = self.muse.post_completion({"muse_id": "muse-x", "loop_id": "loop-x", "status": "completed"})
        self.assertFalse(ok)
        dead = Path(os.environ["MUSE_DEADLETTER_PATH"]).read_text()
        self.assertIn("muse-x", dead)

    def test_inbound_auth(self):
        self.assertTrue(self.muse.inbound_authorized("", ""))
        os.environ["MUSE_INBOUND_KEY"] = "secret"
        self.assertFalse(self.muse.inbound_authorized("", ""))
        self.assertTrue(self.muse.inbound_authorized("Bearer secret", ""))
        self.assertTrue(self.muse.inbound_authorized("", "secret"))

    def test_poll_completions(self):
        os.environ["MUSE_COMPLETIONS_PATH"] = str(Path(self.tmp.name) / "done.json")
        import importlib
        importlib.reload(self.muse)
        report = {"muse_id": "muse-p", "loop_id": "loop-p", "status": "completed",
                  "completed_at": "2026-09-22T18:00:00Z"}
        self.assertTrue(self.muse.post_completion(report))
        rows = self.muse.list_completions()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["muse_id"], "muse-p")
        self.assertEqual(self.muse.list_completions(since="2026-09-22T19:00:00Z"), [])

    def test_status_live_with_key(self):
        self.assertEqual(self.muse.connector_status(), "offline")
        os.environ["MUSE_INBOUND_KEY"] = "secret"
        self.assertEqual(self.muse.connector_status(), "live")

    def test_connect_instructions_hosted(self):
        os.environ["VALINOR_GATE"] = "preview"
        os.environ["MUSE_INBOUND_KEY"] = "secret-key"
        card = self.muse.connect_instructions("app.tryvalinor.com")
        self.assertEqual(card["base"], "https://api.tryvalinor.com")
        self.assertTrue(card["configured"])
        self.assertIn("secret-key", card["prompt"])
        self.assertIn("POST https://api.tryvalinor.com/api/connectors/muse/missions", card["prompt"])
        self.assertNotIn("app.tryvalinor.com/api", card["prompt"])

    def test_muse_reports_close(self):
        self.muse.upsert_missions([{"muse_id": "muse-ig-review-1", "title": "Review IG posts"}])
        self.assertEqual(len(self.muse.surfaced_missions()), 1)
        out = self.muse.accept_completions([{
            "muse_id": "muse-ig-review-1",
            "status": "completed",
            "note": "reviewed 12 posts",
        }])
        self.assertEqual(out["accepted"], ["muse-ig-review-1"])
        self.assertEqual(out["missing"], [])
        self.assertEqual(self.muse.surfaced_missions(), [])
        rows = self.muse.list_completions()
        self.assertEqual(rows[-1]["muse_id"], "muse-ig-review-1")
        self.assertEqual(rows[-1]["source"], "muse")
        miss = self.muse.accept_completions([{"muse_id": "no-such"}])
        self.assertEqual(miss["accepted"], [])
        self.assertEqual(miss["missing"], ["no-such"])


if __name__ == "__main__":
    unittest.main()
