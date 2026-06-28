import { Router } from "express";

const router = Router();
const API = "https://api.donutsmp.net/v1";

function authHeaders() {
  return { Authorization: `Bearer ${process.env["DONUTSMP_API_KEY"] ?? ""}` };
}

router.get("/stats/:username", async (req, res) => {
  try {
    const r = await fetch(`${API}/stats/${encodeURIComponent(req.params["username"]!)}`, {
      headers: authHeaders(),
    });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

router.get("/lookup/:username", async (req, res) => {
  try {
    const r = await fetch(`${API}/lookup/${encodeURIComponent(req.params["username"]!)}`, {
      headers: authHeaders(),
    });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch {
    res.status(500).json({ error: "Failed to fetch lookup" });
  }
});

router.get("/online", async (_req, res) => {
  try {
    const r = await fetch(`${API}/online`, { headers: authHeaders() });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch {
    res.status(500).json({ error: "Failed to fetch online count" });
  }
});

export default router;
