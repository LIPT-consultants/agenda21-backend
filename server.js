const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const inseeAxios = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
  timeout: 20000,
});

const defaultAxios = axios.create({
  headers: { "User-Agent": "Mozilla/5.0" },
  timeout: 20000,
});

app.get("/", (req, res) => res.json({ status: "ok", app: "Agenda21 Longévité Backend" }));

// ─── ROUTE ANALYSE ─────────────────────────────────────────────────────────────
app.post("/api/analyse", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt manquant" });
    const response = await defaultAxios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    });
    const text = (response.data.content || []).map((b) => b.text || "").join("\n");
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─── ROUTE ENRICHIR ────────────────────────────────────────────────────────────
app.post("/api/enrichir", async (req, res) => {
  try {
    const { citycode, city, lat, lon } = req.body;
    const results = {};

    function set(id, val, source, niveau) {
      if (val !== null && val !== undefined && !isNaN(parseFloat(val))) {
        results[id] = { valeur: String(Math.round(parseFloat(val) * 10) / 10), source, niveau };
      }
    }

    // Helper: extraire une valeur d'une série Melodi
    function getMelodiVal(series, keyFragment) {
      if (!series) return null;
      const entry = Object.entries(series).find(([k]) => k.includes(keyFragment));
      if (!entry) return null;
      const obs = Object.values(entry[1].observations || {});
      return obs[0]?.[0] ?? null;
    }

    // 1. API Geo
    try {
      const r = await defaultAxios.get("https://geo.api.gouv.fr/communes/" + citycode + "?fields=nom,population,codeDepartement,codeRegion,epci");
      const d = r.data;
      if (d.population) {
        results["_meta_population"] = { valeur: String(d.population), source: "API Geo gouv.fr", niveau: "commune" };
        results["_meta_seniors"] = { valeur: "Pop. " + d.population + " hab. (75+ estimés ~" + Math.round(d.population * 0.085) + ")", source: "API Geo + benchmark INSEE 2023", niveau: "commune" };
      }
      if (d.epci) results["_meta_epci"] = { valeur: typeof d.epci === "object" ? (d.epci.nom || d.epci.code) : String(d.epci), source: "API Geo gouv.fr", niveau: "epci" };
      if (d.codeDepartement) results["_meta_dept"] = { valeur: "Dép. " + d.codeDepartement, source: "API Geo gouv.fr", niveau: "departement" };
    } catch (e) { console.log("Geo error:", e.message); }

    // 2. Georisques
    try {
      if (lat && lon) {
        const r = await defaultAxios.get("https://georisques.gouv.fr/api/v1/gaspar/risques?rayon=1000&latlon=" + lon + "," + lat + "&page=1&page_size=20");
        console.log("Georisques:", r.status);
        const d = r.data;
        if (d && d.data && d.data.length > 0) {
          const risques = d.data.map((x) => x.libelle_risque_jo || x.code_risque).filter(Boolean);
          results["_meta_georisques"] = { valeur: "Risques : " + risques.slice(0, 5).join(", "), source: "Georisques 2026", niveau: "adresse" };
          if (risques.some((x) => x.toLowerCase().includes("inond"))) set("te5", 45, "Georisques 2026", "adresse");
        } else {
          results["_meta_georisques"] = { valeur: "Aucun risque majeur identifié (rayon 1km)", source: "Georisques 2026", niveau: "adresse" };
        }
      }
    } catch (e) { console.log("Georisques error:", e.message); }

    // 3. ADEME DPE — recherche par nom de ville
    try {
      const cityEncoded = encodeURIComponent(city || "");
      const r = await defaultAxios.get("https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?size=500&select=etiquette_dpe&q=" + cityEncoded);
      console.log("ADEME DPE:", r.status, "résultats:", r.data?.results?.length);
      const d = r.data;
      if (d.results && d.results.length > 0) {
        let total = d.results.length, efg = 0, renove = 0;
        d.results.forEach((x) => {
          if (["E", "F", "G"].includes(x.etiquette_dpe)) efg++;
          if (["A", "B", "C"].includes(x.etiquette_dpe)) renove++;
        });
        set("te1", efg / total * 100, "ADEME DPE 2025", "commune");
        set("te2", renove / total * 100, "ADEME DPE 2025", "commune");
        results["_meta_dpe"] = { valeur: total + " DPE : " + Math.round(efg / total * 100) + "% EFG, " + Math.round(renove / total * 100) + "% ABC", source: "ADEME DPE 2025", niveau: "commune" };
      }
    } catch (e) { console.log("ADEME error:", e.response?.status, e.message); }

// TEST — INSEE RP sans filtre GEO
const urlRp = "https://api.insee.fr/melodi/data/DS_RP_POPULATION_PRINC?maxResult=3&page=1";
const r = await inseeAxios.get(urlRp);
console.log("INSEE RP test:", r.status);
console.log("INSEE RP obs sample:", JSON.stringify(r.data?.observations?.slice(0,2)));

// TEST — BPE sans filtre GEO  
const urlBpe = "https://api.insee.fr/melodi/data/DS_BPE?maxResult=3&page=1";
const r = await inseeAxios.get(urlBpe);
console.log("BPE test:", r.status);
console.log("BPE obs sample:", JSON.stringify(r.data?.observations?.slice(0,2)));

// 6. Filosofi — non disponible via Melodi (dataset retiré)
// v14 (taux d'effort seniors) à saisir manuellement
console.log("Filosofi: non disponible via API, saisie manuelle requise");

    console.log("Résultats finaux:", Object.keys(results));
    res.json(results);
  } catch (err) {
    console.log("Erreur globale:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Agenda21 Backend démarré sur le port ${PORT}`));
